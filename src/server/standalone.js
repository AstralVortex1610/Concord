#!/usr/bin/env node
// Headless Concord: coordinator + HTTP/MCP server + browser dashboard, no Electron.
// Usage: node src/server/standalone.js <project-folder> [--port 4317]
const path = require('path');
const { Coordinator } = require('../core/coordinator');
const { createServer } = require('./http');
const root = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd());
const i = process.argv.indexOf('--port');
const port = i > 0 ? Number(process.argv[i + 1]) : 4317;
const c = new Coordinator({ root });
const s = createServer({ getCoordinator: () => c, staticDir: path.join(__dirname, '..', '..', 'renderer'), port });
s.listen().then((p) => {
  console.log(`Concord coordinator for ${root}`);
  console.log(`  dashboard  http://127.0.0.1:${p}/`);
  console.log(`  MCP        http://127.0.0.1:${p}/mcp`);
  console.log(`  REST       http://127.0.0.1:${p}/api/...`);
  if (process.send) process.send({ port: p });
});
const bye = () => { c.close(); process.exit(0); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
