## Nova's Fourth Review — Deep Dream

**One-liner**: "valuable upgrade, risky memory fiction engine, keep it opt-in and quarantined until it earns trust."

### Key concerns addressed:

1. **Identity auto-promotion** → Quarantined. Deep dream identity facts go to Tier 2 as `proposed_identity`, NOT Tier 3. Need human confirmation or cross-session corroboration.

2. **Shell interpolation** → Fixed. Prompt passed via stdin (temp file pipe) instead of bash string interpolation.

3. **Source ID validation** → Added. Fabricated IDs lower confidence by 0.2. Kind validated against allowed set.

### Still open (from review):
- Evaluation harness (is deep dream useful or just aesthetically better?)
- Deduplication of patterns across sessions
- Contradiction handling for conflicting patterns
- "summary-on-summary" epistemic risk remains inherent to the approach

### Nova's framing shift:
Before deep dream: "heuristic brittleness" was the main flaw.
After deep dream: "narrative overreach" is the new risk — it can look like improvement while quietly reducing truthfulness.

Full review preserved for context.
