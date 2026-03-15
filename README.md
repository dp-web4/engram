# engram

Salience-gated memory for Claude Code.

Captures what matters, forgets what doesn't, consolidates patterns while sleeping.

## What it does

Every tool Claude uses during a session is observed, scored on 5 salience dimensions, and either forgotten (below threshold) or stored (above threshold). At session end, a "dream cycle" extracts patterns from stored observations — either mechanically (heuristic) or semantically (LLM-powered deep dream). Over time, engram builds a structured memory of how you work — what tools you reach for, what errors you hit, what fixes you apply.

Context injection is automatic. engram injects relevant memories at session start, after each prompt (if related memories exist), and after context compaction. You don't need to query it — it surfaces what's relevant without being asked.

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
| 1 | Observations | Salience-gated experiences (observed) | Decays after 7 days | SQLite |
| 2 | Patterns | Consolidated workflows, error-fix chains (inferred) | Decays 0.05/day, pruned below 0.1 | SQLite |
| 3 | Identity | Persistent project facts | Permanent | SQLite |

Injection is epistemically labeled: Tier 1 = "observed (directly recorded)", Tier 2 = "inferred (heuristic — may not be accurate)", Tier 3 = "auto-extracted, verify if unsure". Injection is conservative — biased toward omission. Wrong memory is more damaging than missing memory.

## Dream cycles

Two modes of consolidation:

### Heuristic dream (always runs at session end, <100ms)

- **Tool sequences**: Recurring workflows (e.g., `Edit → Bash(test) → Edit` = TDD loop)
- **Error-fix chains**: Error followed by fix on the same file within 5 observations
- **Concept clusters**: Multiple observations grouped around the same files

### Deep dream (LLM-powered, opt-in)

Sends session observations to Claude via `claude --print` for semantic pattern extraction:

- **Workflows**: Recurring approaches (not just tool sequences — understands intent)
- **Error-fix chains**: Problem → solution with semantic understanding
- **Insights**: Something learned about the codebase
- **Decisions**: Architectural choices made during the session
- **Identity facts**: Persistent project knowledge (confidence >= 0.8 auto-promotes to Tier 3)

```bash
engram dream --deep                # CLI trigger
ENGRAM_DEEP_DREAM=1                # env var for automatic deep dream at session end
```

Example: from 8 raw tool observations, deep dream extracted "PostCompact hook re-injects engram context after compaction" (confidence 0.75) and "engram uses per-directory SQLite isolation" (confidence 0.70). The heuristic dream would have found "Edit appeared 3 times."

### Confidence decay

Memories are not permanent. Patterns lose 0.05 confidence per day since last seen. Observations lose salience after 7 days. Patterns below 0.1 confidence are pruned. A memory system that only accumulates is a distortion engine — engram forgets.

## Context injection (automatic)

| Hook | When | What |
|------|------|------|
| **SessionStart** | Session begins | Inject briefing: recent patterns, high-salience observations, identity facts |
| **UserPromptSubmit** | Every user message | Search for related memories, inject if found (most prompts pass silently) |
| **PostCompact** | After context compaction | Re-inject briefing (replaces what compaction lost) |

All injection is conservative: patterns need confidence >= 0.6, observations need salience >= 0.6, identity needs confidence >= 0.7. Below those thresholds, engram stays silent.

## Retrieval (MCP tools)

For when you want to dig deeper than automatic injection:

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
git clone https://github.com/dp-web4/engram.git
cd engram && npm install && npm run build && npm link
```

Register MCP server and hooks — see [fleet install guide](https://github.com/dp-web4/engram#hooks) or the `hooks/` directory.

## CLI

```bash
engram stats            # Memory health dashboard
engram search <query>   # Search across all tiers
engram patterns [kind]  # List consolidated patterns
engram export           # Export Tier 2+3 to markdown
engram dream            # Heuristic consolidation
engram dream --deep     # LLM-powered semantic consolidation
```

## Architecture

```
SessionStart hook
  │
  └─→ Inject session briefing (conservative, epistemically labeled)
        ├─ Inferred patterns (Tier 2, confidence >= 0.6)
        ├─ Recent observations (Tier 1, salience >= 0.6)
        └─ Project facts (Tier 3, confidence >= 0.7)

UserPromptSubmit hook (every user message)
  │
  ├─→ Extract keywords from prompt
  ├─→ FTS5 search across observations and patterns
  └─→ If matches found: inject via additionalContext
      (most prompts pass silently — no match = no injection)

PostToolUse hook (every tool invocation)
  │
  ├─→ Summarize input/output (truncate to 300 chars)
  ├─→ Push to Tier 0 circular buffer
  ├─→ SNARC heuristic score (<10ms, no LLM)
  │     S — tool transition frequency
  │     N — seen-set lookup
  │     A — error/warning keywords
  │     R — success signals
  │     C — result contradicts history
  ├─→ salience >= 0.3? → INSERT Tier 1 (SQLite)
  └─→ Silent pass-through (never blocks Claude Code)

PostCompact hook
  │
  └─→ Re-inject briefing after context compaction

Stop hook (dream cycle)
  │
  ├─→ Confidence decay (patterns -0.05/day, observations after 7 days)
  ├─→ Prune patterns below 0.1 confidence
  ├─→ Heuristic extraction → Tier 2
  └─→ [opt-in] Deep dream via claude --print → Tier 2 + Tier 3
```

## Data

Each launch directory gets its own isolated database:
```
~/.engram/projects/<hash>/engram.db    # observations, patterns, identity
~/.engram/projects/<hash>/meta.json    # maps hash → directory path
```

Same pattern as Claude Code's `-c` flag: project context is scoped to where you launched from. Working on SAGE won't surface 4-life patterns. No cross-project noise.

No external API calls. No telemetry. All local.

## Origin

engram is a lightweight spinoff from [SAGE](https://github.com/dp-web4/SAGE) (Situation-Aware Governance Engine) — a cognition kernel for edge AI that runs a continuous consciousness loop with salience-gated memory, metabolic states, and trust dynamics. SAGE's SNARC attention system, multi-tier memory architecture, and sleep consolidation cycles are adapted here into a practical Claude Code plugin.

The observation pipeline draws from [claude-mem](https://github.com/thedotmack/claude-mem)'s auto-capture hooks. The filtering and consolidation draw from SAGE. See [COMPARISON.md](COMPARISON.md) for a detailed side-by-side.

The key insight: capturing everything is noisy. Capturing nothing loses context. Salience scoring finds the middle — capture what your attention system flags as important, consolidate patterns during downtime, forget the rest.

## License

MIT
