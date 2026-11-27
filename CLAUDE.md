@AGENTS.md

## Claude-specific

- To check the hosted server the way users see it, use the `jdl` MCP connector (`mcp__claude_ai_jdl__*`); it
  draws on the same shared 500/day pool, so keep checks to a handful of calls.
- `/review` before a PR; `/cso` for any change to how keys reach the server (per-user auth is the open work).
- No auto-memory exists for this repo; its history lives in the jobdatalake memory folder (see Pointers).
