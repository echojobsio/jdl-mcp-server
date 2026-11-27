# JobDataLake MCP server (jdl-mcp-server)

## What this is

An MCP server over the public JobDataLake API. One codebase, two entry points: `src/index.ts` (stdio, shipped
as npm `@jobdatalake/mcp-server`) and `src/http.ts` (Streamable HTTP + legacy SSE, hosted at
`mcp.jobdatalake.com` on Cloud Run `jdl-mcp-server`). Five read-only tools: `search_jobs`, `get_job`,
`get_company`, `find_similar_jobs`, `get_filter_options`. Role: part of JobDataLake, **maintain**; it is a
distribution channel whose metric is paying API keys (PORTFOLIO.md). Depends only on `api.jobdatalake.com`
(no database, no internal imports). Listed in the Claude directory ("JobDataLake by EchoJobs LLC", root URL),
the official MCP registry (`server.json`), Glama, and submitted as a ChatGPT app [check] status.

## Commands

- `npm ci`, then `npm run build` (tsc → `dist/`).
- `npm test` builds, then runs `test/unit.test.mjs` and `test/integration.test.mjs`: it starts `dist/http.js`
  on port 8090 (`TEST_PORT`) and checks the root path, `/mcp`, `/sse`, all five tools and error paths. Tools
  that hit the live API skip softly on network failure, so read the output for skips. 39/39 passed 2026-11-27.
- `npm run start:http` (hosted mode, `PORT` default 8080), `npm start` (stdio).
- No lint script. `tsc` is the typecheck.

Before a push: `npm test` green with no unexpected skips.

## Deploy and verify

- Push to `main` → CircleCI `build` (every branch) then `deploy_to_production` (main only): image
  `us.gcr.io/<project>/jdl-mcp-server:<sha>` → Cloud Run `jdl-mcp-server`, region us-central1 (hardcoded; any
  other region would create a second service). The job ends with a smoke check: `/health` 200 and an MCP
  `initialize` at the ROOT path of `https://mcp.jobdatalake.com`.
- Finished: `gh api repos/echojobsio/jdl-mcp-server/commits/main/status` (CircleCI contexts). GitHub Actions
  `ci.yml` exists but fails in seconds on every branch (org billing), so it is not the gate.
- Production: `curl https://mcp.jobdatalake.com/health` returns `inFlight`, `sseSessions`, `heapUsedMb`,
  `rssMb`, `uptimeSec`. A climbing `inFlight` or `rssMb` is a leak.
- npm is published by hand, not by CI [check] who and from where: npm latest is 1.0.14 (checked 2026-11-27), `server.json`
  says 1.0.14, but `package.json` still says 1.0.11. Bump `package.json` and `server.json` together before a
  publish; publishing is a one-way door (level C).

## Map

- `src/server.ts` — `createServer()`: all tools, their zod schemas, `CONTINENT_MAP`, salary conversion
  (full dollars ≥ 1000 become thousands), the server `instructions` string, free-mode key selection.
- `src/client.ts` — `JDLClient`: fetches `api.jobdatalake.com` with `X-API-Key`, maps 401/402/429 to messages,
  reads `X-MCP-Remaining`.
- `src/http.ts` — Express: `POST /` and `/mcp` (stateless Streamable HTTP), `GET`/`DELETE` → 405, `/sse` +
  `/messages` (legacy, in-memory sessions), `/health`.
- `src/index.ts` — stdio entry.
- `server.json` (MCP registry), `glama.json`, `LAUNCHGUIDE.md` (directory copy), `chatgpt-app-submission.json`
  (untracked as of 2026-11-27).

## Data and secrets

No database. Env: `JDL_API_KEY` (optional; without it the built-in MCP free key is used), `PORT`, `NODE_ENV`.
The hosted service sets only `NODE_ENV` (checked 2026-11-27), so it runs on the free key. The free key is
public by design (it ships in the npm package) and JDL limits it to 500 calls/day per client IP.

## Rules for this repo

- **Serve MCP at the root path.** The Claude connector and directory connect at `https://mcp.jobdatalake.com/`;
  serving only `/mcp` broke Claude once (PR #5, 2026-07-30). The integration test guards it.
- **Stay stateless on Streamable HTTP.** In-memory sessions died on restart or instance switch and answered 400
  "no valid session id", which clients do not recover from; held sessions also OOM-killed the container ~80x/day.
  (PR #13 2026-09-24, PR #15 2026-11-25.) Do not reintroduce server-side session state.
- **Tools stay read-only** with `readOnlyHint` annotations; directory listings depend on it.
- **Pass through, never enrich, job URLs.** JDL already returns the `/go/j` redirect for sponsored jobs; this
  server must not add or log referral links.
- Numbers in tool descriptions and `instructions` are public claims (constitution: no invented numbers). Take
  them from `GET /v1/stats` with the date.

## Gotchas

- **Hosted users share one 500/day pool.** JDL limits the free key by client IP, and every hosted request
  comes from Cloud Run without the end user's identity. A directory user cannot bring a paid key either; only
  the npm package reads `JDL_API_KEY`. A customer hit this 2026-11-21; per-user auth (key in URL, then OAuth)
  is the open fix.
- **Stale corpus numbers:** `instructions` says 1,080,000+ jobs and 20,000+ companies; `/v1/stats` said
  1,909,839 jobs on 2026-11-27 and the JDL site says 1.8M+ / 25,000+. [check] and align in one change.
- **`server.json` still advertises the legacy `/sse` remote**, which keeps in-memory sessions. [check] whether
  to list the Streamable HTTP root instead.
- `find_similar_jobs` takes a job handle and resolves it to an id first (PR #7); it only works for jobs that have
  embeddings (remote/tech, decided by lotsofjobs).
- `.gitignore` has an uncommitted `.gstack/` line (someone's working change, 2026-11-27).

## Decisions in force

- Stateless Streamable HTTP, per-request `McpServer` (PR #15, 2026-11-25; supersedes the session-TTL PR #14).
- CircleCI deploys on main with a post-deploy root-path smoke (PR #8, 2026-08-23); manual `gcloud run deploy`
  is retired.

## Pointers

- JDL API contract: `~/code/jdl/jobdatalake/docs/api-reference.md`; ChatGPT package:
  `~/code/jdl/jobdatalake/docs/chatgpt-app-submission.md`.
- Hosted-state memory: `~/.claude/projects/-Users-mengengao-code-jdl-jobdatalake/memory/mcp-server-hosted-state.md`.
- Site page for clients: `~/code/jdl/jobdatalake-frontend/src/app/mcp/`.
