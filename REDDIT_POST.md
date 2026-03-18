# engram: Claude Code memory that captures what matters, forgets what doesn't

**TL;DR**: Instead of logging every tool use and searching later, engram scores each observation on 5 salience dimensions at capture time. Low-salience stuff evicts. High-salience stuff persists. Memories decay over time. Patterns consolidate during "dream cycles."

**GitHub**: https://github.com/dp-web4/engram (MIT)

## Why another memory plugin?

I looked at claude-mem, Total Recall, ContextForge, and others. They all solve the same problem the same way: capture everything, compress or search later. The result is either token-expensive injection or noisy retrieval.

engram flips it: **filter at capture, not at retrieval.**

## How it works

Every tool Claude uses gets scored on 5 dimensions (SNARC):
- **S**urprise — unexpected tool transition?
- **N**ovelty — new files/concepts?
- **A**rousal — errors, state changes?
- **R**eward — task advancement?
- **C**onflict — contradicts recent results?

Scoring is heuristic TypeScript, <10ms, no LLM calls. Observations below threshold (0.1) evict from a circular buffer. Above threshold → SQLite with FTS5.

## What's different

| | engram | Log-everything approaches |
|---|---|---|
| Capture | Score first, store if salient | Store everything |
| Injection | Automatic (5 hooks) | Manual (MCP calls) |
| Decay | Confidence decays daily | Accumulates forever |
| Dream cycles | Extract patterns at session end | Continuous compression |
| Scope | Per launch directory | Usually global |

## The hooks

- **SessionStart**: injects briefing (recent patterns + high-salience observations)
- **UserPromptSubmit**: searches for related memories, injects if found
- **PostToolUse**: captures + SNARC scores every tool use
- **PostCompact**: mid-session dream cycle + re-inject enriched briefing
- **Stop**: full dream cycle (heuristic + optional deep dream)

Context injection is automatic. You never query it manually unless you want to.

## Confidence decay

Memories aren't permanent. Patterns lose confidence daily. Below 0.1 = pruned. This prevents the "memory distortion" problem where old, wrong patterns keep getting injected.

## Deep dream (optional)

At session end, you can run `engram dream --deep` which sends observations to Claude and asks "what patterns are worth remembering?" — extracting semantic insights, not just mechanical tool sequences. Identity proposals from deep dream are quarantined until human-reviewed.

## Install

```bash
git clone https://github.com/dp-web4/engram.git
cd engram && bash install.sh
```

Or as a Claude Code plugin (pending marketplace acceptance).

## Origin

Spinoff from [SAGE](https://github.com/dp-web4/SAGE) — a cognition kernel for edge AI that uses the same SNARC salience scoring in its consciousness loop. The concept of salience-gated selective memory comes from Richard Aragon's Transformer Sidecar research.

Been running it across a 6-machine fleet for a few days. The salience scoring works — routine operations filter out, errors and milestones persist. Would love feedback on the approach.
