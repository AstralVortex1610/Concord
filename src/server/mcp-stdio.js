#!/usr/bin/env node
// Concord stdio MCP bridge, for MCP clients that only speak stdio.
// Forwards JSON-RPC lines to the running Concord app at http://127.0.0.1:<port>/mcp.
// Usage: concord-mcp [--agent my-agent] [--port 4317]
// Without Node installed on Windows: set ELECTRON_RUN_AS_NODE=1 and run Concord.exe <path-to>/resources/app.asar/src/server/mcp-stdio.js
const readline = require('readline');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg('--port', process.env.CONCORD_PORT || 4317));
const agent = arg('--agent', process.env.CONCORD_AGENT || '');
let session = null;
const rl = readline.createInterface({ input: process.stdin });
const write = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (agent) headers['X-Concord-Agent'] = agent;
    if (session) headers['Mcp-Session-Id'] = session;
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(msg) });
    const sid = r.headers.get('mcp-session-id'); if (sid) session = sid;
    if (r.status === 202) return;
    write(await r.json());
  } catch (e) {
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `Concord is not running on port ${port}. Open the Concord app and a project first. (${e.message})` } });
  }
});
