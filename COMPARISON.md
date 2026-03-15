# engram vs claude-mem

Both are persistent memory systems for Claude Code. They solve the same problem (sessions are stateless) but with fundamentally different philosophies.

## The Core Difference

**claude-mem** captures everything, compresses later.
**engram** scores everything, captures only what matters.

claude-mem is a flight recorder. engram is an attention system.

## Architecture Comparison

| | claude-mem | engram |
|---|---|---|
| **Philosophy** | Record everything, retrieve by search | Score everything, store only what's salient |
| **Capture** | Every tool invocation stored | Every tool invocation *scored* — only above-threshold stored |
| **Filtering** | Post-hoc (search filters at retrieval time) | Pre-storage (SNARC salience scoring at capture time) |
| **Compression** | AI-driven via agent-sdk (LLM compresses logs) | Heuristic (no LLM calls in the hot path, <10ms) |
| **Storage** | Single global SQLite + Chroma vector DB | Per-directory SQLite + FTS5 (no vectors, no embeddings) |
| **Retrieval** | 3-layer progressive disclosure (search → timeline → detail) | Automatic injection (SessionStart briefing + UserPromptSubmit recall) + 4 MCP tools for explicit queries |
| **Context injection** | Manual (you call the MCP tools) | Automatic (hooks inject relevant context without being asked) |
| **Consolidation** | Continuous AI compression | Dream cycles at session end (heuristic pattern extraction) |
| **Dependencies** | Node.js, Bun, uv, Chroma, agent-sdk | Node.js, better-sqlite3 (one native dep) |
| **Scope** | Global per machine | Per launch directory (like Claude Code's `-c` flag) |

## Salience Scoring: The Differentiator

claude-mem treats every tool invocation equally. A routine `ls` and a critical test failure get the same storage treatment — both recorded, both compressed, both retrievable.

engram scores every observation on five dimensions before deciding whether to store it:

| Dimension | What it measures | Why it matters |
|-----------|-----------------|----------------|
| **S**urprise | How unexpected was this tool transition? | Unusual workflows signal exploration or problems |
| **N**ovelty | Are these files/concepts new to this project? | First encounters with code are more informative than revisits |
| **A**rousal | Errors, warnings, state changes? | Failures and mutations are inherently more memorable |
| **R**eward | Did this advance the task? | Successes and milestones anchor what worked |
| **C**onflict | Does this contradict recent observations? | Contradictions signal bugs or misunderstandings |

```
salience = 0.25×surprise + 0.20×novelty + 0.20×arousal + 0.25×reward + 0.10×conflict
```

Observations below 0.3 salience stay in the circular buffer (50 slots, in-memory) and evict. Above 0.3, they persist to SQLite. This means a routine `git status` (low surprise, low novelty, no arousal, low reward, no conflict) is forgotten, while a test failure after a refactor (moderate surprise, high arousal, zero reward, high conflict) is remembered.

This is how biological memory works. You don't remember every step you took today. You remember the one where you tripped.

## Memory Tiers

**claude-mem**: One tier with progressive disclosure.
| Layer | What | Tokens |
|-------|------|--------|
| Search index | Sparse results with IDs | ~50-100/result |
| Timeline | Chronological context | Variable |
| Full detail | Complete observation | ~500-1,000/result |

**engram**: Four tiers with different purposes.
| Tier | Name | What | Retention |
|------|------|------|-----------|
| 0 | Buffer | Last 50 raw observations | Session only (FIFO) |
| 1 | Observations | Salience-scored experiences | Permanent (SQLite) |
| 2 | Patterns | Consolidated workflows, error-fix chains | Permanent (SQLite) |
| 3 | Identity | Persistent project facts | Permanent (SQLite) |

claude-mem's layers are about *token efficiency* (don't load everything at once).
engram's tiers are about *cognitive function* (different memories serve different purposes).

## Context Injection

**claude-mem**: Pull-only. You call MCP tools to retrieve memories. If you don't ask, nothing surfaces.

**engram**: Push + pull.
- **SessionStart**: Automatically injects a briefing — recent patterns, high-salience observations, identity facts. Claude starts every session knowing what happened recently.
- **UserPromptSubmit**: Searches for memories related to your prompt and injects them via `additionalContext`. Most prompts pass silently (no match = no injection). When there's a match, Claude sees it without you asking.
- **PostCompact**: When Claude Code compacts the conversation, engram runs a mid-session dream cycle (consolidates observations from the first half of the session) then re-injects the now-enriched briefing. The session gets smarter as it goes — patterns discovered mid-session carry into the second half.
- **MCP tools**: Available for explicit queries when you want to dig deeper.

The UX rationale: if retrieval requires extra steps, nobody does it. Memory that isn't surfaced is memory that doesn't exist. Automatic injection makes the value visible from the first session.

## Dream Cycles

**claude-mem**: Continuous compression via agent-sdk. Every observation is AI-compressed as it's stored. "Endless Mode" (beta) adds ~95% token reduction with 60-90 second latency per tool invocation.

**engram**: Heuristic consolidation at session end. No LLM calls. Three extractors run on Tier 1 observations:
- **Tool sequences**: Find recurring workflows (e.g., `Edit → Bash(test) → Edit` = TDD loop)
- **Error-fix chains**: Error followed by fix on the same target within 5 observations
- **Concept clusters**: Multiple observations grouped around the same files

Patterns promote to Tier 2 with frequency and confidence scores. Next session, they appear in the briefing.

The tradeoff: claude-mem's AI compression produces higher-quality summaries. engram's heuristic extraction is faster (zero latency) and captures structural patterns (workflows, chains) that text compression misses.

## Scope & Portability

**claude-mem**: Single global database (`~/.claude-mem/claude-mem.db`). All projects share one memory. Web viewer at `localhost:37777`.

**engram**: Per-directory database (`~/.engram/projects/<hash>/engram.db`). Each project gets isolated memory — SAGE patterns don't contaminate web4 work. Same pattern as Claude Code's `-c` flag.

**Fleet sync**: engram exports Tier 2 (patterns) and Tier 3 (identity) to markdown for git sync across machines. Tier 0 and 1 stay local. claude-mem has no built-in fleet sync.

## Performance

| | claude-mem | engram |
|---|---|---|
| PostToolUse latency | ~100ms (AI compression) | <10ms (heuristic scoring) |
| Endless Mode latency | 60-90s per tool | N/A |
| SessionStart | Minimal | ~50ms (SQLite query + briefing) |
| UserPromptSubmit | N/A | ~20ms (FTS5 search) |
| Storage growth | Everything stored (compressed) | Only salient observations stored |
| Dependencies | Node + Bun + uv + Chroma | Node + better-sqlite3 |

## When to Use Which

**Choose claude-mem if:**
- You want maximum recall (nothing is forgotten)
- You're working on a single project
- You want AI-quality summaries of past sessions
- You don't mind manual retrieval (calling MCP tools)
- You want the web viewer UI

**Choose engram if:**
- You want attention-filtered memory (noise is forgotten)
- You work across multiple projects (per-directory isolation)
- You want automatic context injection (no manual retrieval)
- You want zero-latency capture (no LLM in the hot path)
- You run a fleet of machines (markdown export/import)
- You care about biological memory analogies (SNARC, dream cycles, salience)

## Origin

engram combines two lineages:
- [claude-mem](https://github.com/thedotmack/claude-mem)'s auto-capture hooks (the observation pipeline)
- [SAGE](https://github.com/dp-web4/SAGE)'s salience-gated memory architecture (the filtering, tiering, and consolidation)

The SNARC scoring concept (Surprise, Novelty, Arousal, Reward, Conflict) originates from Richard Aragon's [Transformer Sidecar](https://github.com/RichardAragon/Transformer-Sidecar-Bolt-On-Persistent-State-Space-Memory) — a selective memory system that only writes when moments are salient. SAGE adapted this into a neural scorer with learnable weights; engram adapts it further into pure heuristic TypeScript — same dimensions, no model required.
