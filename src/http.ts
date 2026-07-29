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
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';

const app = express();
app.use(express.json());

// Health check for Cloud Run and uptime monitors.
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Live sessions: session id -> transport.
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Existing session.
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session: create a transport + a fresh server, register on init.
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
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
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session id');
    return;
  }
  await transports[sessionId].handleRequest(req, res);
};
app.get('/mcp', handleSession);
app.delete('/mcp', handleSession);

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, () => {
  console.log(`JobDataLake MCP server (Streamable HTTP) listening on :${port}`);
});
