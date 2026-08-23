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
  try {
    const { sid } = await rpc('/', INIT);
    await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
    const r = await rpc('/', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'search_jobs', arguments: { query: 'python', per_page: 1 } },
    }, sid);
    assert.ok(r.json?.result?.content?.length, 'expected content from search_jobs');
  } catch (err) {
    t.diagnostic(`live API check skipped (network/env): ${err.message}`);
  }
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
    t.diagnostic(`live API check skipped (network/env): ${err.message}`);
    return;
  }

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
    assert.ok(!r.json?.result?.isError, `find_similar_jobs errored for handle ${handle}: ${out}`);
    if (/Found \d+ similar jobs/.test(out)) return; // handle path works
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
    try {
      const { sid } = await rpc('/', INIT);
      await rpc('/', { jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
      const search = await rpc('/', {
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: 'search_jobs', arguments: { query: 'software engineer', remote_type: 'fully_remote', per_page: 5 } },
      }, sid);
      const txt = search.json?.result?.content?.[0]?.text ?? '';
      handles = [...txt.matchAll(/^\s*ID:\s*(\S+)$/gm)].map((m) => m[1]);
    } catch (err) {
      t.diagnostic(`live API check skipped (network/env): ${err.message}`);
      return;
    }
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
      if (!/Found \d+ similar jobs/.test(out)) continue; // no embeddings for this job
      checked++;
      const returned = [...out.matchAll(/^\s*ID:\s*(\S+)$/gm)].map((m) => m[1]);
      const idx = returned.indexOf(handle);
      if (idx >= 0) offenders.push(`${handle} -> self at index ${idx} of ${returned.length}`);
    }

    assert.ok(checked, 'no sampled job had embeddings — cannot judge self-exclusion');
    assert.deepEqual(offenders, [],
      `the query job was returned as its own match in ${offenders.length}/${checked} cases:\n${offenders.join('\n')}`);
  });
