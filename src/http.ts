// Streamable HTTP entry point — the hosted remote server (Cloud Run →
// mcp.jobdatalake.com). Streamable HTTP is the transport recommended by MCP
// hosts including the ChatGPT app/plugin directory.
//
// Stateless: every POST gets a fresh McpServer + transport and nothing
// survives the request. All five tools are read-only and the server never
// pushes to the client, so there is no state worth keeping between requests.
//
// It used to be stateful (session id -> transport, in memory), and that broke
// real clients: any restart, idle reap or request routed to another Cloud Run
// instance left the client holding a session id the server no longer knew,
// and the server answered 400 "no valid session id". The spec only tells
// clients to re-initialize on 404, so they failed outright instead -- the
// Claude connector went dead until a manual reconnect. Held sessions were also
// the memory driver behind the OOM kills. Stateless removes both.
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from './server.js';

const app = express();
app.use(express.json());

// SSE sessions: these already evict correctly (res.on('close') always fires
// for an HTTP response, unlike transport.onclose for an abandoned POST session).
const sseTransports: Record<string, SSEServerTransport> = {};

// Streamable HTTP requests currently being handled. Stateless, so this falls
// back to zero between requests; a number that only climbs means a leak.
let inFlight = 0;

// Health check for Cloud Run and uptime monitors. Heap and RSS are here because
// the old session leak OOM-killed this service ~80x/day while looking like a
// flaky endpoint from outside.
app.get('/health', (_req: Request, res: Response) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    inFlight,
    sseSessions: Object.keys(sseTransports).length,
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    rssMb: Math.round(mem.rss / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
  });
});

// Serve the Streamable HTTP endpoint at BOTH the root path and /mcp. The
// existing Claude connector (and the Claude directory listing) connect at the
// ROOT of mcp.jobdatalake.com; ChatGPT/newer clients use /mcp. Serving both
// keeps every client working. (Regression fix: an earlier version only served
// /mcp, so root returned 404 and Claude could not connect.)
//
// A client may still send an mcp-session-id it got from the old stateful
// server; stateless transports ignore it, so those clients just keep working.
app.post(['/', '/mcp'], async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  inFlight++;
  res.on('close', () => {
    inFlight--;
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// No sessions means no server->client stream to open (GET) and nothing to
// terminate (DELETE). 405 is the spec's answer for both.
const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed.' },
    id: null,
  });
};
app.get(['/', '/mcp'], methodNotAllowed);
app.delete(['/', '/mcp'], methodNotAllowed);

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
