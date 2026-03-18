# Privacy Policy

**engram** — salience-gated memory for Claude Code

## Data Collection

engram collects **no data**. Zero. None.

- No external API calls
- No telemetry
- No analytics
- No crash reporting
- No usage tracking
- No network requests of any kind

## Data Storage

All data is stored **locally on your machine** at `~/.engram/projects/<hash>/`:

- `engram.db` — SQLite database containing observations, patterns, identity facts, settings
- `meta.json` — maps the directory hash back to its path

Each launch directory gets its own isolated database. No cross-project data sharing.

## What Is Stored

engram stores summaries of Claude Code tool usage (truncated to 300 characters), salience scores, consolidated patterns, and optional identity facts. It does **not** store:

- Full file contents
- API keys or credentials
- Personal information beyond what appears in tool usage summaries

## Data Sharing

engram does not share data with anyone. The optional `engram export` command produces a markdown file that you can choose to share manually — this is entirely under your control.

## Deep Dream

The optional deep dream feature (`engram dream --deep`) sends observation summaries to Claude via your existing `claude --print` CLI. This uses your own Claude Code authentication and is subject to Anthropic's privacy policy, not ours. Deep dream is opt-in and never runs automatically unless you set `ENGRAM_DEEP_DREAM=1`.

## Third Parties

engram has no third-party integrations, no cloud backend, and no dependencies that phone home. The only runtime dependencies are `better-sqlite3` (local database) and `@modelcontextprotocol/sdk` (local MCP server).

## Contact

Questions: dp@metalinxx.io
Source: https://github.com/dp-web4/engram

**Last updated**: March 2026
