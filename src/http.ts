// Streamable HTTP entry point — the hosted remote server (Cloud Run →
// mcp.jobdatalake.com). Streamable HTTP is the transport recommended by MCP
// hosts including the ChatGPT app/plugin directory.
//
// Stateful sessions: the MCP handshake is initialize -> (session id) ->
// tools/list -> tools/call, and that state must persist across the separate
// HTTP requests a client makes. We issue a session id on initialize and keep
// the transport in memory keyed by it.
//
// Cloud Run note: because sessions live in-memory, enable **session affinity**
// on the Cloud Run service so a client's follow-up requests reach the same
// instance. (Read-only search tools mean a dropped session just forces a
// re-initialize, so this is low-risk even if affinity lapses.)
import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';

const app = express();
app.use(express.json());

// SSE sessions: these already evict correctly (res.on('close') always fires
// for an HTTP response, unlike transport.onclose for an abandoned POST session).
const sseTransports: Record<string, SSEServerTransport> = {};

// Health check for Cloud Run and uptime monitors.
//
// Reports live session counts and heap use: the leak that OOM-killed this
// service ~80x/day was invisible from outside, and the 503s it caused looked
// like a flaky endpoint rather than a container being reaped. `sessions` going
// up and never coming down is the signal.
app.get('/health', (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    sessions: sessions.size,
    sseSessions: Object.keys(sseTransports).length,
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  });
});

// Live sessions: session id -> transport + last activity.
//
// These MUST be evicted on a timer, not only via transport.onclose. onclose
// fires when a client explicitly closes (DELETE, or the stream ending); clients
// that simply stop talking -- the Claude connector, directory health checkers
// that probe hourly, one-shot CLI probes -- never trigger it. Every abandoned
// session then pins a transport AND a full McpServer (createServer() builds one
// per session, with all five tools and their zod schemas).
//
// That leak OOM-killed the container ~80x/day against a 256 MiB limit, and any
// request that landed on an instance mid-kill returned 503 to a real user.
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 min with no requests -> reap
const SESSION_SWEEP_MS = 5 * 60 * 1000; // check every 5 min
const MAX_SESSIONS = 500;               // backstop against a burst

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}
const sessions = new Map<string, Session>();

function touch(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) s.lastSeen = Date.now();
}

async function dropSession(sessionId: string, reason: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  try {
    await s.transport.close();
  } catch (err) {
    console.error(`session ${sessionId} close failed (${reason}):`, err);
  }
}

// Reap idle sessions. unref() so the timer never holds the process open.
const sweeper = setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) void dropSession(id, 'idle');
  }
}, SESSION_SWEEP_MS);
sweeper.unref();

// Serve the Streamable HTTP endpoint at BOTH the root path and /mcp. The
// existing Claude connector (and the Claude directory listing) connect at the
// ROOT of mcp.jobdatalake.com; ChatGPT/newer clients use /mcp. Serving both
// keeps every client working. (Regression fix: an earlier version only served
// /mcp, so root returned 404 and Claude could not connect.)
app.post(['/', '/mcp'], async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && sessions.has(sessionId)) {
    // Existing session.
    transport = sessions.get(sessionId)!.transport;
    touch(sessionId);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // Backstop: if a burst outruns the sweeper, reap the least-recently-used
    // rather than accepting unbounded growth toward another OOM.
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) await dropSession(oldest[0], 'max sessions');
    }
    // New session: create a transport + a fresh server, register on init.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: no valid session id (initialize first)' },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// GET = server->client SSE stream; DELETE = terminate — both need a live session.
const handleSession = async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(400).send('Invalid or missing session id');
    return;
  }
  touch(sessionId!);
  await session.transport.handleRequest(req, res);
};
app.get(['/', '/mcp'], handleSession);
app.delete(['/', '/mcp'], handleSession);

// --- Legacy SSE transport (backward compatibility) -------------------------
// The Claude connector directory and existing remote clients connect over SSE
// at /sse. Keep it alongside Streamable HTTP so upgrading the server does not
// break them: GET /sse opens the stream; the client POSTs messages to /messages
// (the path is advertised to the client when the stream opens).

app.get('/sse', async (_req: Request, res: Response) => {
  const transport = new SSEServerTransport('/messages', res);
  sseTransports[transport.sessionId] = transport;
  res.on('close', () => {
    delete sseTransports[transport.sessionId];
  });
  const server = createServer();
  await server.connect(transport);
});

app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined;
  const transport = sessionId ? sseTransports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send('No active SSE session for the given sessionId');
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, () => {
  console.log(`JobDataLake MCP server (Streamable HTTP) listening on :${port}`);
});
