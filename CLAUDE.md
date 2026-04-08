## Session Discipline

- **Re-read before editing**: After 10+ messages in a conversation, re-read any file before editing it. Auto-compaction may have silently dropped file contents from context. Do not trust memory of file state — verify.
- **Verify before reporting success**: After code changes, run the project build/typecheck (e.g., `npx next build`, `npx tsc --noEmit`, `python -m py_compile`, or equivalent) before reporting the task as complete. A successful file write is not a successful change — the code must compile.
- **Assume tool result truncation**: If search or command results look suspiciously small, re-run with narrower scope. Tool results over 50K characters are silently truncated to a preview.

<!-- gitnexus:start -->
<!-- gitnexus:keep -->
# GitNexus — Code Knowledge Graph

Indexed as **snarc** (236 symbols, 529 relationships, 19 execution flows). MCP tools available via `mcp__gitnexus__*`.

**Do not reindex.** The supervisor handles GitNexus indexing. If the index is stale, note it in session context.

| Tool | Use for |
|------|---------|
| `query` | Find execution flows by concept |
| `context` | 360-degree view of a symbol (callers, callees, processes) |
| `impact` | Blast radius before editing (upstream/downstream) |
| `detect_changes` | Map git diff to affected symbols and flows |
| `rename` | Graph-aware multi-file rename (dry_run first) |
| `cypher` | Raw Cypher queries against the graph |

Resources: `gitnexus://repo/snarc/context`, `clusters`, `processes`, `process/{name}`
<!-- gitnexus:end -->
