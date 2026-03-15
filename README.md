# engram

Salience-gated memory for Claude Code.

Captures what matters, forgets what doesn't, consolidates patterns while sleeping.

## What it does

Every tool Claude uses during a session is observed, scored on 5 salience dimensions, and either forgotten (below threshold) or stored (above threshold). At session end, a "dream cycle" extracts recurring patterns from stored observations. Over time, engram builds a structured memory of how you work — what tools you reach for, what errors you hit, what fixes you apply.

## How it's different from logging everything

Most memory systems capture everything and retrieve by search. engram captures selectively using [SNARC salience scoring](https://github.com/dp-web4/SAGE) — the same attention mechanism used by the SAGE cognition kernel:

| Dimension | What it measures | How |
|-----------|-----------------|-----|
| **S**urprise | How unexpected was this tool transition? | Tool transition frequency map |
| **N**ovelty | Are these files/symbols/concepts new? | Seen-before set (SQLite) |
| **A**rousal | Errors, warnings, state changes? | Keyword pattern matching |
| **R**eward | Did this advance the task? | Success/build/test signals |
| **C**onflict | Does this contradict recent observations? | Recent result comparison |

Observations scoring below the salience threshold (0.3) stay in the circular buffer briefly and then evict. High-salience observations persist. This mirrors biological memory: you don't remember every step, but you remember the one where you tripped.

## Memory tiers

| Tier | Name | Contents | Retention | Storage |
|------|------|----------|-----------|---------|
| 0 | Buffer | Last 50 observations, raw | Session only (FIFO) | In-memory |
| 1 | Observations | Salience-gated experiences | Permanent | SQLite |
| 2 | Patterns | Consolidated workflows, error-fix chains | Permanent | SQLite |
| 3 | Identity | Persistent project facts | Permanent | SQLite |

## Dream cycles

At session end, engram runs a consolidation pass over Tier 1 observations:

- **Tool sequences**: Recurring workflows (e.g., `Edit → Bash(test) → Edit` = TDD loop)
- **Error-fix chains**: Error followed by fix on the same file within 5 observations
- **Concept clusters**: Multiple observations grouped around the same files

Patterns are promoted to Tier 2 with frequency and confidence scores.

## Retrieval (MCP tools)

| Tool | Purpose |
|------|---------|
| `engram_search` | Query across all tiers, ranked by salience |
| `engram_context` | Observations around a timestamp or session |
| `engram_patterns` | Consolidated patterns from dream cycles |
| `engram_stats` | Memory health: tier sizes, salience distribution |

## Fleet portability

Tier 2 and 3 export to markdown for git sync across machines:

```bash
engram export > memory-export.md    # dump patterns + identity
engram import memory-export.md      # load on another machine
```

Tier 0 and 1 stay local — they're raw and session-specific.

## Install

```bash
npm install -g engram

# Register MCP server
claude mcp add -s user engram -- node $(which engram)/../engram/dist/src/server.js

# Register hooks (add to ~/.claude/settings.json)
# See hooks/ directory for hook configuration
```

## CLI

```bash
engram stats            # Memory health dashboard
engram search <query>   # Search across all tiers
engram patterns [kind]  # List consolidated patterns
engram export           # Export Tier 2+3 to markdown
engram dream            # Trigger manual consolidation
```

## Architecture

```
SessionStart hook
  │
  └─→ Inject session briefing into Claude's context
        ├─ Recent patterns (Tier 2)
        ├─ High-salience observations (Tier 1, salience >= 0.5)
        └─ Identity facts (Tier 3)

UserPromptSubmit hook (every user message)
  │
  ├─→ Extract keywords from prompt (stop words filtered)
  ├─→ FTS5 search across observations and patterns
  └─→ If matches found: inject via additionalContext JSON field
      (most prompts pass silently — no match = no injection)

PostToolUse hook (every tool invocation)
  │
  ├─→ Summarize input/output (truncate to 300 chars)
  ├─→ Push to Tier 0 circular buffer
  ├─→ SNARC heuristic score (<10ms, no LLM)
  │     ├─ Surprise:  tool transition frequency
  │     ├─ Novelty:   seen-set lookup
  │     ├─ Arousal:   error/warning keywords
  │     ├─ Reward:    success signals
  │     └─ Conflict:  result contradicts history
  ├─→ salience >= 0.3? → INSERT Tier 1 (SQLite)
  └─→ stdout: {"continue": true, "suppressOutput": true}

PostCompact hook (after context compaction)
  │
  └─→ Re-inject session briefing (patterns, observations, identity)
      so Claude doesn't lose awareness after compaction

Stop hook (dream cycle)
  │
  ├─→ Tool sequence extraction → Tier 2
  ├─→ Error-fix chain detection → Tier 2
  └─→ Concept clustering → Tier 2

MCP Server (explicit retrieval, when you want to dig deeper)
  │
  ├─→ engram_search:   FTS5 across Tier 1+2
  ├─→ engram_context:  temporal window query
  ├─→ engram_patterns: Tier 2 retrieval
  └─→ engram_stats:    memory health
```

Context injection is automatic — engram surfaces relevant memories without being asked. MCP tools are for when you want to search or explore the memory explicitly.

## Origin

engram is a lightweight spinoff from [SAGE](https://github.com/dp-web4/SAGE) (Situation-Aware Governance Engine) — a cognition kernel for edge AI that runs a continuous consciousness loop with salience-gated memory, metabolic states, and trust dynamics. SAGE's SNARC attention system, multi-tier memory architecture, and sleep consolidation cycles are adapted here into a practical Claude Code plugin.

The observation pipeline draws from [claude-mem](https://github.com/thedotmack/claude-mem)'s auto-capture hooks. The filtering and consolidation draw from SAGE. See [COMPARISON.md](COMPARISON.md) for a detailed side-by-side.

The key insight: capturing everything is noisy. Capturing nothing loses context. Salience scoring finds the middle — capture what your attention system flags as important, consolidate patterns during downtime, forget the rest.

This is how biological memory works. engram applies it to code.

## Data

Each launch directory gets its own isolated database:
```
~/.engram/projects/<hash>/engram.db    # observations, patterns, identity
~/.engram/projects/<hash>/meta.json    # maps hash → directory path
```

Same pattern as Claude Code's `-c` flag: project context is scoped to where you launched from. Working on SAGE won't surface 4-life patterns. No cross-project noise.

No external API calls. No telemetry. All local.

## License

MIT
