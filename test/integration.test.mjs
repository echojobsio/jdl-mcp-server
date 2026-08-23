// Integration / regression tests for the hosted HTTP MCP server (dist/http.js).
//
// These start the built server and exercise it over HTTP the way real clients
// do. The load-bearing guard is "MCP endpoint served at the ROOT path": the
// Claude connector and the Claude directory connect at the root of
// mcp.jobdatalake.com, so a change that serves the endpoint only at /mcp breaks
// Claude (root 404). That regression shipped once (hotfix PR #5); this test
// exists so it can't ship again.
//
// Run: npm test   (which builds first, then `node --test test/`)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.TEST_PORT || 8090);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

// Minimal MCP-over-HTTP client. Handles the session id and both JSON and SSE
// (text/event-stream) response bodies that Streamable HTTP may return.
async function rpc(path, payload, sessionId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const sid = res.headers.get('mcp-session-id') || sessionId;
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try { json = JSON.parse(line.slice(5).trim()); break; } catch { /* keep scanning */ }
      }
    }
  } else if (text) {
    try { json = JSON.parse(text); } catch { /* leave null */ }
  }
  return { status: res.status, sid, json };
}

const QUOTA_EXHAUSTED = /Daily free limit reached|Rate limit exceeded/;

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

before(async () => {
  server = spawn('node', ['dist/http.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error('server did not become healthy in time');
});

after(() => { server?.kill(); });

test('GET /health returns 200 {status:ok}', async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

// *** THE REGRESSION GUARD ***
// Claude connects at the ROOT of the server URL. This must stay 200.
test('MCP endpoint is served at the ROOT path "/" (Claude)', async () => {
  const r = await rpc('/', INIT);
  assert.equal(r.status, 200, 'POST / must return 200 (Claude connects at root)');
  assert.equal(r.json?.result?.serverInfo?.name, 'jobdatalake');
});

test('MCP endpoint is served at /mcp (ChatGPT / newer clients)', async () => {
  const r = await rpc('/mcp', INIT);
  assert.equal(r.status, 200);
  assert.equal(r.json?.result?.serverInfo?.name, 'jobdatalake');
});

test('legacy SSE endpoint /sse opens and advertises /messages', async () => {
  const ac = new AbortController();
  const res = await fetch(`${BASE}/sse`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (let i = 0; i < 5 && !buf.includes('/messages?sessionId='); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  ac.abort();
  assert.match(buf, /event:\s*endpoint/);
  assert.match(buf, /\/messages\?sessionId=/);
});

// Guard against accidental tool removal / registration breakage.
test('tools/list returns all five tools (over the root path)', async () => {
  const { sid } = await rpc('/', INIT);
  await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  const r = await rpc('/', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sid);
  const names = (r.json?.result?.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(names, [
    'find_similar_jobs', 'get_company', 'get_filter_options', 'get_job', 'search_jobs',
  ]);
});

// Soft check: a live call against the JDL API. Network-dependent, so it warns
// instead of failing CI — the endpoint/handshake/tool guards above are the hard
// gates; this just confirms the wiring end-to-end when the network is available.
test('search_jobs returns data (live JDL API — soft)', async (t) => {
  let r;
  try {
    const { sid } = await rpc('/', INIT);
    await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    r = await rpc('/', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'search_jobs', arguments: { query: 'python', per_page: 1 } },
    }, sid);
  } catch (err) {
    skipEnv(t, err);
    return;
  }
  // This used to assert only `content.length`. An ERROR result also has exactly
  // one content item ("Error: Daily free limit reached…"), so it passed while
  // the tool was failing -- quota error, API down, 500, wrong key, anything.
  const text = r.json?.result?.content?.[0]?.text ?? '';
  if (skipIfQuotaText(t, text)) return;
  assert.ok(!r.json?.result?.isError, `search_jobs errored: ${text.slice(0, 200)}`);
  assert.match(stripBanner(text), /^Found [\d,]+ jobs|^No jobs found/,
    `search_jobs did not return a result set:\n${text.slice(0, 200)}`);
});

// Regression: find_similar_jobs must accept a job HANDLE, not just a raw id.
//
// The JDL API's `similar_to` parameter only accepts a job's raw id, but every
// tool here surfaces `job_handle` and never the id — so a model calling this
// tool can only ever pass a handle. Passing the handle straight through made
// the API return an "embedding" error, which the catch block rewrote into
// "this job doesn't have vector embeddings yet". That message is plausible and
// matches a real documented limitation, so the tool looked like it was working
// (isError: false) while being 100% broken for every caller.
//
// Rather than hardcode a handle (job data rolls hourly), discover candidates
// via search_jobs and assert that at least one of them returns real results
// when addressed BY HANDLE. If handle->id resolution regresses, every
// candidate falls back to the embeddings message and this fails.
test('find_similar_jobs works when given a job handle (live JDL API — soft)', async (t) => {
  const NO_EMBEDDINGS = /doesn't have vector embeddings/;
  let handles;
  let searchText = '';
  try {
    const { sid } = await rpc('/', INIT);
    await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const search = await rpc('/', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'search_jobs', arguments: { query: 'software engineer', remote_type: 'fully_remote', per_page: 5 } },
    }, sid);
    searchText = search.json?.result?.content?.[0]?.text ?? '';
    handles = [...searchText.matchAll(/^\s*ID:\s*(\S+)$/gm)].map((m) => m[1]);
  } catch (err) {
    skipEnv(t, err);
    return;
  }

  // Quota exhaustion is environmental, not a regression — skip rather than
  // redden `build` and block the CircleCI deploy job.
  if (skipIfQuotaText(t, searchText)) return;

  // Not a skip: search_jobs is already proven working by the test above, so if we
  // got a response and still can't pull handles out of it, the output format
  // changed or the arguments were rejected — both are regressions worth failing on.
  assert.ok(handles.length, `expected job handles from search_jobs, got:\n${searchText.slice(0, 400)}`);

  const seen = [];
  for (const handle of handles) {
    const { sid } = await rpc('/', INIT);
    await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const r = await rpc('/', {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'find_similar_jobs', arguments: { job_id: handle, per_page: 3 } },
    }, sid);
    const out = r.json?.result?.content?.[0]?.text ?? '';
    // Re-check per iteration: the seed check happens once, but this loop makes
    // ~2 more billed calls per handle. If the 500th lands mid-loop the error
    // text is "Daily free limit reached", the assert fails, `build` goes red
    // and the deploy is blocked by quota -- inverting the whole design.
    if (skipIfQuotaText(t, out)) return;
    assert.ok(!r.json?.result?.isError, `find_similar_jobs errored for handle ${handle}: ${out}`);
    // `Found 0 similar jobs` matches /Found \d+/ and would declare victory on an
    // empty result set -- a backend returning nothing for every job would pass.
    if (/Found [1-9]\d* similar jobs/.test(out)) return; // handle path works
    seen.push(`${handle} -> ${out.slice(0, 80)}`);
  }

  // Every candidate claimed "no embeddings". Coverage is limited to remote/tech
  // jobs, but these ARE remote engineering roles — so this is the handle bug.
  assert.fail(
    `find_similar_jobs returned no results for any of ${handles.length} remote engineering handles.\n` +
    (seen.every((s) => NO_EMBEDDINGS.test(s))
      ? 'All returned the "no embeddings" message — handle->id resolution is likely broken again.\n'
      : '') + seen.join('\n')
  );
});

// The query job must not appear in its own "more like this" results.
//
// `similar_to` runs an ANN search using the job's own stored embedding, and a
// vector's nearest neighbour is always itself -- so the query job comes back as
// its own #1 hit at score ~1.0 unless the backend excludes it. Measured against
// production: 8/8 sampled jobs returned themselves at rank 1. Every caller
// silently loses one of N results to the job they are already viewing (20% of
// the payload at per_page=5).
//
// The test above passes happily while this is broken -- it only asserts that
// SOME results came back, not that they are useful -- which is exactly how this
// survived a fix, a deploy, and a green suite.
//
// Fixed in the API by echojobsio/jobdatalake#67 (excludeJob drops the query job
// after the Typesense call). The first attempt, #66, tried to do it as a
// Typesense filter -- `id:!=<id>` -- which Typesense rejects outright and which
// 500'd the entire similar_to path in production until it was rolled forward.
// This test is the end-to-end guard neither of those changes had.
test('find_similar_jobs excludes the query job from its own results',
  async (t) => {
    let handles = [];
    let seedText = '';
    try {
      const { sid } = await rpc('/', INIT);
      await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
      const search = await rpc('/', {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'search_jobs', arguments: { query: 'software engineer', remote_type: 'fully_remote', per_page: 5 } },
      }, sid);
      seedText = search.json?.result?.content?.[0]?.text ?? '';
      handles = [...seedText.matchAll(/^\s*ID:\s*(\S+)$/gm)].map((m) => m[1]);
    } catch (err) {
      skipEnv(t, err);
      return;
    }
    if (skipIfQuotaText(t, seedText)) return;
    assert.ok(handles.length, 'expected job handles from search_jobs');

    const offenders = [];
    let checked = 0;
    for (const handle of handles) {
      const { sid } = await rpc('/', INIT);
      await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
      const r = await rpc('/', {
        jsonrpc: '2.0', id: 7, method: 'tools/call',
        params: { name: 'find_similar_jobs', arguments: { job_id: handle, per_page: 5 } },
      }, sid);
      const out = r.json?.result?.content?.[0]?.text ?? '';
      if (skipIfQuotaText(t, out)) return;
      // Require a NON-ZERO count: "Found 0 similar jobs" has no ID: lines, so it
      // would contribute no offenders and silently inflate `checked`, letting
      // this test judge self-exclusion on zero actual results.
      if (!/Found [1-9]\d* similar jobs/.test(out)) continue; // no embeddings / empty
      checked++;
      const returned = [...out.matchAll(/^\s*ID:\s*(\S+)$/gm)].map((m) => m[1]);
      const idx = returned.indexOf(handle);
      if (idx >= 0) offenders.push(`${handle} -> self at index ${idx} of ${returned.length}`);
    }

    assert.ok(checked, 'no sampled job had embeddings — cannot judge self-exclusion');
    assert.deepEqual(offenders, [],
      `the query job was returned as its own match in ${offenders.length}/${checked} cases:\n${offenders.join('\n')}`);
  });

// ---------------------------------------------------------------------------
// Tool contract
//
// `tools/list returns all five tools` above asserts only that the tools are
// REGISTERED. Registration is not evidence of working: find_similar_jobs was
// registered, listed, and 100% broken for every caller at the same time. The
// tests below actually invoke each tool and assert on what comes back.
// ---------------------------------------------------------------------------

// Open one session and reuse it. Each call costs a free-tier API request
// (500/day, shared), so the suite should not open a session per assertion.
async function session() {
  const { sid } = await rpc('/', INIT);
  await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  return sid;
}

// The hosted server runs on the shared free key (500 calls/day, counted per
// client IP) whenever JDL_API_KEY is unset -- which is the case in CI. A run
// that exhausts the quota must SKIP, not fail: a red `build` blocks the
// CircleCI deploy job, and "we ran out of API calls" is not a code regression.
// Set JDL_API_KEY in the CircleCI project to remove the ceiling entirely.
// Uses t.skip(), NOT t.diagnostic() + return. `return` counts the test as a
// PASS: a run where every live assertion bailed reported "pass 32, skipped 0",
// indistinguishable from one where they all genuinely asserted -- and
// deploy_to_production proceeds on that. t.skip() reports it as skipped.
function skipIfQuotaExhausted(t, r) {
  if (QUOTA_EXHAUSTED.test(r.text ?? '') || QUOTA_EXHAUSTED.test(r.raw ?? '')) {
    t.skip('JDL free-tier quota exhausted for this IP');
    return true;
  }
  return false;
}

// Same, for a bare response string (seed searches).
function skipIfQuotaText(t, text) {
  if (QUOTA_EXHAUSTED.test(text ?? '')) {
    t.skip('JDL free-tier quota exhausted for this IP');
    return true;
  }
  return false;
}

// A live call failed for an environmental reason (network/DNS/server down).
function skipEnv(t, err) {
  t.skip(`live API unavailable: ${err.message}`);
}

// Strips the free-tier quota banner so assertions match on content, not quota.
// Deliberately anchored to the banner's own wording rather than "everything up
// to the first newline": an earlier version of this helper swallowed the first
// line of real output too, because the banner used to run into the content.
const BANNER = /^\s*[\u{1F4CA}\u{26A0}\uFE0F]+[^\n]*(free calls remaining today|Daily free limit reached)[^\n]*\n*/u;
function stripBanner(text) {
  return text.replace(BANNER, '').trim();
}

let callId = 100;
async function callTool(sid, name, args) {
  const r = await rpc('/', {
    jsonrpc: '2.0', id: callId++, method: 'tools/call',
    params: { name, arguments: args },
  }, sid);
  return {
    isError: r.json?.result?.isError ?? false,
    rpcError: r.json?.error,
    // Strip the free-tier banner so assertions match on content, not quota.
    raw: r.json?.result?.content?.[0]?.text ?? '',
    text: stripBanner(r.json?.result?.content?.[0]?.text ?? ''),
  };
}

// Every tool must carry a description, an input schema, and the three
// annotations. The ChatGPT app directory requires all three to be set
// explicitly and rejects submissions with missing hints, so a tool registered
// without them is a submission blocker rather than a cosmetic gap.
test('every tool declares a description, input schema, and annotations', async () => {
  const sid = await session();
  const r = await rpc('/', { jsonrpc: '2.0', id: 200, method: 'tools/list', params: {} }, sid);
  const tools = r.json?.result?.tools ?? [];
  assert.equal(tools.length, 5);
  for (const t of tools) {
    assert.ok(t.description?.length > 20, `${t.name}: description missing or too short`);
    assert.equal(t.inputSchema?.type, 'object', `${t.name}: inputSchema is not an object schema`);
    assert.ok(t.annotations, `${t.name}: no annotations`);
    assert.equal(t.annotations.readOnlyHint, true, `${t.name}: readOnlyHint must be true — every tool here is read-only`);
    for (const hint of ['openWorldHint', 'destructiveHint']) {
      assert.equal(typeof t.annotations[hint], 'boolean', `${t.name}: ${hint} must be set explicitly`);
    }
  }
});

// The root path and /mcp are the same server; a divergence means one client
// population silently gets a different tool set.
test('/ and /mcp expose an identical tool set', async () => {
  const names = async (path) => {
    const { sid } = await rpc(path, INIT);
    await rpc(path, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const r = await rpc(path, { jsonrpc: '2.0', id: 201, method: 'tools/list', params: {} }, sid);
    return (r.json?.result?.tools ?? []).map((t) => t.name).sort();
  };
  assert.deepEqual(await names('/'), await names('/mcp'));
});

test('unknown tool name returns an error rather than empty success', async () => {
  const sid = await session();
  const r = await callTool(sid, 'no_such_tool', {});
  assert.ok(r.isError || r.rpcError, 'expected an error for an unregistered tool');
});

// --- get_job ------------------------------------------------------------

// get_job is load-bearing beyond its own surface: find_similar_jobs resolves a
// handle to an id through it, so a get_job outage breaks similar-jobs too.
test('get_job returns the requested job, addressed by handle (live — soft)', async (t) => {
  let sid, handle, handleSearchText = '';
  try {
    sid = await session();
    const s = await callTool(sid, 'search_jobs', { query: 'engineer', per_page: 3 });
    handleSearchText = s.text;
    handle = (s.text.match(/^\s*ID:\s*(\S+)$/m) ?? [])[1];
  } catch (err) {
    skipEnv(t, err);
    return;
  }
  if (skipIfQuotaText(t, handleSearchText)) return;
  assert.ok(handle, 'search_jobs returned no handle to look up');

  const r = await callTool(sid, 'get_job', { job_id: handle });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(!r.isError, `get_job errored: ${r.text}`);

  // Assert against the STRUCTURED HEADER only, not the whole body. get_job
  // appends the raw job description after a `---` rule, and real postings
  // routinely contain the words "Location:" / "Salary:" in their prose -- an
  // earlier version of this test matched those and passed even with the
  // structured fields renamed. Splitting on the rule is what makes it real.
  const [header, ...rest] = r.text.split(/\n---\n/);
  assert.ok(rest.length, `get_job output has no --- rule separating header from description:\n${r.text.slice(0, 300)}`);
  for (const field of ['Location:', 'Salary:', 'Seniority:', 'Skills:', 'Type:', 'Apply:']) {
    assert.ok(header.includes(field), `get_job header missing "${field}":\n${header.slice(0, 300)}`);
  }
  // The title line identifies which job came back.
  assert.match(header, /^\*\*.+\*\* at .+/, `get_job header missing the "**Title** at Company" line:\n${header.slice(0, 200)}`);
});

test('get_job rejects an unknown handle with a real error (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'get_job', { job_id: 'definitely-not-a-real-job-handle-zzzz' });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(r.isError, `expected isError for an unknown handle, got:\n${r.text.slice(0, 200)}`);
  // Assert WHY it errored. Without this the test passed while the API was
  // returning 429 for everything -- it proved nothing about not-found handling.
  assert.match(r.text, /not found|404/i,
    `expected a not-found error, got a different failure:\n${r.text.slice(0, 200)}`);
});

// --- get_company --------------------------------------------------------

test('get_company returns the requested company (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'get_company', { company: 'stripe.com' });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(!r.isError, `get_company errored: ${r.text}`);
  // Must return the company that was ASKED FOR — a tool that returns some
  // other company's profile is worse than one that errors.
  assert.match(r.text, /stripe\.com/i, `get_company did not return stripe.com:\n${r.text.slice(0, 300)}`);
  assert.ok(r.text.includes('Open jobs:') || r.text.includes('Industry:'),
    `get_company output missing profile fields:\n${r.text.slice(0, 300)}`);
});

test('get_company rejects an unknown domain with a real error (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'get_company', { company: 'not-a-real-company-zzzz.invalid' });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(r.isError, `expected isError for an unknown domain, got:\n${r.text.slice(0, 200)}`);
  assert.match(r.text, /not found|404/i,
    `expected a not-found error, got a different failure:\n${r.text.slice(0, 200)}`);
});

// --- get_filter_options -------------------------------------------------

test('get_filter_options returns facets with counts (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'get_filter_options', {});
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(!r.isError, `get_filter_options errored: ${r.text}`);
  // The whole point of this tool is telling a caller which values are valid,
  // so an empty facet list is a silent failure, not an empty result.
  const entries = [...r.text.matchAll(/^\s*-\s+(\S.*?)\s+\(([\d,]+) jobs\)$/gm)];
  assert.ok(entries.length >= 5, `expected several facet values, got ${entries.length}:\n${r.text.slice(0, 300)}`);
  assert.ok(entries.some(([, , count]) => Number(count.replace(/,/g, '')) > 0), 'all facet counts were zero');
  // The default facet set is part of the contract with the search filters.
  assert.match(r.text, /\*\*employment_type:\*\*/, 'default facets missing employment_type');
});

test('get_filter_options honours an explicit facet list (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'get_filter_options', { facets: 'remote_type' });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(!r.isError, `get_filter_options errored: ${r.text}`);
  assert.match(r.text, /\*\*remote_type:\*\*/, `requested facet not returned:\n${r.text.slice(0, 200)}`);
  assert.ok(!r.text.includes('**seniority:**'), 'returned facets that were not requested');
});

// --- search_jobs behaviour ----------------------------------------------

test('search_jobs honours per_page (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'search_jobs', { query: 'engineer', per_page: 3 });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(!r.isError, `search_jobs errored: ${r.text}`);
  const results = [...r.text.matchAll(/^\d+\.\s+\*\*/gm)];
  assert.ok(results.length > 0 && results.length <= 3,
    `expected 1..3 results for per_page=3, got ${results.length}`);
});

// An impossible filter must produce the guidance message, not an error and not
// a silently empty body.
test('search_jobs explains itself when filters match nothing (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'search_jobs', {
    query: 'zzzqqxunlikelykeyword', salary_min: 990, per_page: 5,
  });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(!r.isError, `search_jobs errored on an empty result set: ${r.text}`);
  assert.match(r.text, /No jobs found matching your filters/,
    `expected the no-results guidance, got:\n${r.text.slice(0, 300)}`);
});

// Invalid enum values must be rejected by the schema rather than silently
// dropped, which would return unfiltered results a caller would trust.
test('search_jobs rejects an invalid remote_type instead of ignoring it', async () => {
  const sid = await session();
  const r = await callTool(sid, 'search_jobs', { query: 'engineer', remote_type: 'remote', per_page: 2 });
  assert.ok(r.isError || r.rpcError,
    `"remote" is not in the enum (fully_remote|hybrid|on_site) and must be rejected, got:\n${r.text.slice(0, 200)}`);
});

// --- cross-tool chaining -------------------------------------------------

// The handles search_jobs prints must be accepted by the tools that consume
// them. This is the contract that broke find_similar_jobs: search_jobs labels
// the handle "ID:", and similar_to only accepted the raw id.
test('handles from search_jobs are accepted by get_job and find_similar_jobs (live — soft)', async (t) => {
  let sid, handles, chainSearchText = '';
  try {
    sid = await session();
    const s = await callTool(sid, 'search_jobs', { query: 'software engineer', remote_type: 'fully_remote', per_page: 3 });
    chainSearchText = s.text;
    handles = [...s.text.matchAll(/^\s*ID:\s*(\S+)$/gm)].map((m) => m[1]);
  } catch (err) {
    skipEnv(t, err);
    return;
  }
  if (skipIfQuotaText(t, chainSearchText)) return;
  assert.ok(handles.length, 'search_jobs returned no handles');

  const handle = handles[0];
  const job = await callTool(sid, 'get_job', { job_id: handle });
  if (skipIfQuotaExhausted(t, job)) return;
  assert.ok(!job.isError, `get_job rejected a handle from search_jobs: ${job.text}`);

  const similar = await callTool(sid, 'find_similar_jobs', { job_id: handle, per_page: 3 });
  if (skipIfQuotaExhausted(t, similar)) return;
  assert.ok(!similar.isError, `find_similar_jobs rejected a handle from search_jobs: ${similar.text}`);

  // Handles returned by find_similar_jobs must round-trip too.
  const nested = [...similar.text.matchAll(/^\s*ID:\s*(\S+)$/gm)].map((m) => m[1]);
  if (nested.length) {
    const back = await callTool(sid, 'get_job', { job_id: nested[0] });
    if (skipIfQuotaExhausted(t, back)) return;
    assert.ok(!back.isError, `a handle from find_similar_jobs was rejected by get_job: ${back.text}`);
  }
});

// The free-tier banner is prepended to every response in free mode, and
// production runs in free mode (no JDL_API_KEY on the Cloud Run service). It
// must not run into the content: before this was fixed, every response read
// "...free calls remaining todayFound 224,511 jobs (showing 1)".
test('the free-tier banner is separated from the response body (live — soft)', async (t) => {
  let sid;
  try { sid = await session(); } catch (err) {
    skipEnv(t, err); return;
  }
  const r = await callTool(sid, 'search_jobs', { query: 'engineer', per_page: 1 });
  if (skipIfQuotaExhausted(t, r)) return;
  assert.ok(!r.isError, `search_jobs errored: ${r.text}`);
  if (!/free calls remaining|Daily free limit/.test(r.raw)) {
    t.skip('not in free mode — no banner to separate');
    return;
  }
  assert.match(r.raw, /(remaining today|jobdatalake\.com)\s*\n/,
    `banner runs into the body:\n${JSON.stringify(r.raw.slice(0, 160))}`);
  // And the body must survive intact rather than being glued to the banner.
  assert.match(r.text, /^Found [\d,]+ jobs/,
    `body did not start cleanly after the banner:\n${JSON.stringify(r.text.slice(0, 160))}`);
});
