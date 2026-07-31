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
