# Show HN: engram — salience-gated memory for Claude Code (captures what matters, forgets what doesn't)

**GitHub**: https://github.com/dp-web4/engram
**License**: MIT

Every Claude Code memory plugin captures everything and searches later. engram does the opposite: it scores every tool use on 5 salience dimensions at capture time and only stores what matters. Low-salience observations (routine `ls`, `git status`) evict from a circular buffer. High-salience ones (test failures, successful builds, novel file writes) persist.

**The scoring (SNARC — Surprise, Novelty, Arousal, Reward, Conflict):**

- Surprise: how unexpected was this tool transition? (tracks tool sequence frequency)
- Novelty: are these files/symbols new to this project? (seen-before set in SQLite)
- Arousal: errors, warnings, state changes? (keyword patterns)
- Reward: did this advance the task? (test pass, build success, git commit)
- Conflict: does this contradict recent observations? (result comparison)

Scoring is pure heuristic TypeScript — no LLM calls, <10ms per observation.

**What makes it different from claude-mem, Total Recall, ContextForge, etc.:**

1. **Salience-gated capture, not log-everything.** Most memory systems store first, search later. engram filters at capture time. A routine `engram stats` call (surprise=0, novelty=0, arousal=0) scores below threshold and evicts. A test failure after a refactor (high surprise + high arousal + high conflict) scores above threshold and persists.

2. **Automatic context injection.** 5 hooks — SessionStart (briefing), UserPromptSubmit (reactive recall), PostToolUse (capture), PostCompact (mid-session dream + re-inject), Stop (dream cycle). You never need to query it manually.

3. **Confidence decay.** Patterns lose 0.05 confidence per day. Observations decay after 7 days. Patterns below 0.1 are pruned. Memory that only accumulates is a distortion engine.

4. **Dream cycles.** At session end (and mid-session on compaction), heuristic extractors identify recurring tool sequences, error→fix chains, and concept clusters. Optional "deep dream" sends observations to Claude for semantic pattern extraction.

5. **Per-directory isolation.** Each launch directory gets its own SQLite database. Working on project A won't surface project B's patterns.

6. **Epistemic labeling.** Tier 1 observations are labeled "observed." Tier 2 patterns are labeled "inferred (may not be accurate)." Deep dream identity proposals are quarantined until human-reviewed.

**Architecture:**

```
PostToolUse → SNARC score (<10ms) → above threshold? → SQLite
SessionStart → inject briefing (patterns + observations + identity)
UserPromptSubmit → FTS5 search → inject if matches found
PostCompact → mid-session dream → re-inject enriched briefing
Stop → dream cycle (heuristic + optional deep dream via claude --print)
```

**Install:** Clone + `bash install.sh`, or as a Claude Code plugin.

**Origin:** Lightweight spinoff from SAGE (https://github.com/dp-web4/SAGE), a cognition kernel for edge AI. The SNARC concept originates from Richard Aragon's Transformer Sidecar.

Interested in how the salience scoring performs in practice. We've been running it across a 6-machine fleet for a few days — the v2 scorer threshold (0.1) captures most meaningful work while still filtering routine operations. Feedback welcome.
