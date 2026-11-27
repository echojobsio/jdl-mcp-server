# src/ — the MCP server: five tools over the JDL API

## Purpose

All server code. `createServer()` in `server.ts` registers five read-only tools; each one turns its arguments
into a query string, calls `api.jobdatalake.com` through `JDLClient`, and returns a Markdown text block (not
JSON). Two entries attach a transport: `index.ts` (stdio, npm package) and `http.ts` (hosted, Cloud Run).
There is no database and no other dependency.

## Files

- `server.ts` — tool schemas (zod, module scope so per-request servers share them), `CONTINENT_MAP`,
  `formatSalary`, the free-tier banner `mcpWarning`, the `instructions` string, and the API key choice.
- `client.ts` — `JDLClient.request`: GET with `X-API-Key`; 401/402/429 become fixed messages; reads
  `X-MCP-Remaining`. Three calls: `searchJobs` (`/v1/jobs`), `getJob`, `getCompany`.
- `http.ts` — Express. `POST /` and `/mcp`: a new `McpServer` + stateless transport per request.
  `GET`/`DELETE` there → 405. `/sse` + `/messages`: legacy SSE, sessions in an in-memory map. `/health`.
- `index.ts` — stdio entry, one server for the process.

## Tools and the JDL calls behind them

| Tool | JDL call | Notes |
|---|---|---|
| `search_jobs` | `GET /v1/jobs` | `query`→`q` (`*` if no query), `company`→`domain`, a continent name in `location` → `countries` list, salary ≥1000 → thousands, `posted_within` (`24h`/`7d`) → `posted_after` ms, salary sort adds `salary_min=1`, `per_page` capped 100 |
| `get_job` | `GET /v1/jobs/{handle}` | handle or 24-hex id; prints the description |
| `get_company` | `GET /v1/companies/{domain or handle}` | JDL tries handle, then domain |
| `find_similar_jobs` | `GET /v1/jobs/{handle}` then `GET /v1/jobs?similar_to={id}` | anything not lowercase 24-hex is looked up as a handle first (PR #7); `per_page` capped 50 |
| `get_filter_options` | `GET /v1/jobs?q=*&per_page=0&facets=...` | default facets: seniority, job_function, remote_type, employment_type, required_skills |

## The shared free key pool

`apiKey = JDL_API_KEY || MCP_FREE_KEY`; the free key is a constant in `server.ts`, public by design. It is
read once at module load, so one process uses one key for every user. How JDL treats it (read in
`jobdatalake/api/middleware/auth.go`, 2026-11-27):

- `/v1/jobs*` (search, get_job, similar, facets): 500 calls/day per client IP, counted in `jdl_daily_usage`,
  no credits. JDL returns `X-MCP-Remaining`, which `mcpWarning` prints at the top of the answer.
- `/v1/companies/*` (get_company) is not a public route in JDL: the free key is treated as an ordinary key,
  so the call is not counted in the IP pool, sends no `X-MCP-Remaining`, and deducts 1 credit from the free
  key's owning account. If that account reaches 0 credits every `get_company` answers "Insufficient
  credits". [check] that account's balance.
- Hosted on Cloud Run, every user arrives from Google's IPs with no identity, so hosted users share the
  pool (customer hit it 2026-11-21). Only the npm package can use a personal key.

## Rules

- Tools stay read-only, with `readOnlyHint: true, openWorldHint: false, destructiveHint: false`; the
  ChatGPT submission file states the same values.
- Pass `url` through as `Apply:`. Never build, rewrite or log a job link (sponsored jobs are `/go/j`).
- Keep the transport stateless; build no per-user state in `http.ts` (PR #13, #15).
- Corpus numbers in `instructions` and descriptions are public claims: take them from `GET /v1/stats` with
  a date.
- A new JDL field reaches a user only if the formatter in the tool prints it; check field names against
  `jobdatalake/store/search.go` `SearchJob` and `model/` (search rows use `company_name`, `salary_*_usd`;
  `get_job` uses `company.name`, `salary_min`).

## Gotchas

- `get_company` prints `company.job_count`, but JDL's field is `total_jobs`, so "Open jobs" is always
  "Unknown" (read in code 2026-11-27; not fixed).
- `job_function` enum lists 12 of JDL's 24 families; a valid family outside it is rejected by zod.
- `location` other than a continent is sent as `location`, which JDL folds into the keyword query, not a filter.
- `formatSalary` hides values outside 10–1000 (thousands) as non-USD; real but extreme salaries show as
  "Not disclosed".
- The `McpServer` `version` is hard-coded `1.0.0`, unrelated to `package.json` or `server.json`.

## Tests

`npm test` (builds first). `test/unit.test.mjs`: `formatSalary`, `CONTINENT_MAP`. `test/integration.test.mjs`
starts `dist/http.js` on `TEST_PORT` (8090): root and `/mcp` paths, SSE, all five tools against the live
API (soft-skip on network or quota failure; read the output for skips), statelessness, 405s, no leaks.
Live tests spend the free pool of the machine's IP.
