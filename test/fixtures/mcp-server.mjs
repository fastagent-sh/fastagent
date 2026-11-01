import { appendFileSync } from 'node:fs';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

if (process.env.MCP_PID_FILE) appendFileSync(process.env.MCP_PID_FILE, `${process.pid}\n`);
let calls = 0;
serveStdio(() => {
  const server = new McpServer({ name: 'test-mcp', version: '1' });
  server.registerTool('who', { inputSchema: fromJsonSchema({ type: 'object', properties: {} }) }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ value: process.env.MCP_VALUE, cwd: process.cwd(), pid: process.pid, calls: ++calls, leaked: process.env.UNRELATED_MCP_SECRET !== undefined }) }],
  }));
  server.registerTool('wait', { inputSchema: fromJsonSchema({ type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] }) }, async ({ ms }, ctx) => {
    if (process.env.MCP_EVENTS) appendFileSync(process.env.MCP_EVENTS, 'started\n');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      ctx.mcpReq.signal.addEventListener('abort', () => { clearTimeout(timer); if (process.env.MCP_EVENTS) appendFileSync(process.env.MCP_EVENTS, 'aborted\n'); reject(new Error('aborted')); }, { once: true });
    });
    return { content: [{ type: 'text', text: 'finished' }] };
  });
  server.registerTool('bad', { inputSchema: fromJsonSchema({ type: 'object', properties: {} }) }, async () => ({ content: [{ type: 'text', text: 'expected failure' }], isError: true }));
  return server;
}, { legacy: 'reject' });
