#!/usr/bin/env node

// stdio entry point — used by the npm package (@jobdatalake/mcp-server) for
// local clients like Claude Desktop and Claude Code. The hosted remote uses
// http.ts instead. Both share the same tools via createServer().
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
