// Proof over the wire: 4 separate OS processes (like Claude Code, Codex, Cursor, Gemini CLI) edit one file through MCP at once.
const { fork, spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');

if (process.argv[2] === 'child') {
  // One external agent process speaking MCP over HTTP.
  const [, , , port, name, rounds] = process.argv;
  const url = `http://127.0.0.1:${port}/mcp`;
  let sid = null, id = 0;
  const rpc = async (method, params) => {
    const h = { 'Content-Type': 'application/json' }; if (sid) h['Mcp-Session-Id'] = sid;
    const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (r.headers.get('mcp-session-id')) sid = r.headers.get('mcp-session-id');
    return (await r.json()).result;
  };
  const call = async (n, a) => (await rpc('tools/call', { name: n, arguments: a }));
  (async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } });
    const tools = await rpc('tools/list', {});
    if (!tools.tools.find((t) => t.name === 'edit_file')) throw new Error('no edit tool');
    let retries = 0;
    for (let r = 0; r < Number(rounds); r++) {
      for (;;) {
        const read = await call('read_file', { path: 'app.py' });
        const rev = Number(/revision (\d+)/.exec(read.content[0].text)[1]);
        await new Promise((s) => setTimeout(s, Math.random() * 20));
        const res = await call('edit_file', { path: 'app.py', baseRev: rev, edits: [{ old: '    items = []', new: `    items = []\n    items.append("${name}-${r}")` }], message: `${name} ${r}` });
        if (!res.isError) break;
        retries++;
      }
    }
    await call('memory_write', { kind: 'lesson', title: `${name} finished ${rounds} edits`, body: `${retries} retries` });
    process.send({ done: name, retries });
  })().catch((e) => { process.send({ error: e.message }); });
  return;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-mp-'));
  fs.writeFileSync(path.join(root, 'app.py'), 'def collect():\n    items = []\n    return items\n');
  const server = fork(path.join(__dirname, '..', 'src', 'server', 'standalone.js'), [root, '--port', '47317'], { silent: true });
  const port = await new Promise((r) => server.on('message', (m) => m.port && r(m.port)));
  console.log(`\nTest 5: 4 separate processes edit app.py over MCP on port ${port}, same line, 15 edits each`);
  const names = ['claude-code', 'codex', 'cursor', 'gemini-cli'];
  const results = await Promise.all(names.map((n) => new Promise((resolve, reject) => {
    const ch = fork(__filename, ['child', String(port), n, '15']);
    ch.on('message', (m) => (m.error ? reject(new Error(m.error)) : resolve(m)));
  })));
  const final = fs.readFileSync(path.join(root, 'app.py'), 'utf8');
  let count = 0; for (const n of names) for (let r = 0; r < 15; r++) { assert(final.includes(`items.append("${n}-${r}")`), `lost ${n}-${r}`); count++; }
  console.log(`  ✓ ${count}/60 edits present across 4 processes (${results.reduce((s, x) => s + x.retries, 0)} clean retries, 0 overwrites)`);

  // Stdio bridge works for stdio-only clients.
  const br = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server', 'mcp-stdio.js'), '--port', String(port), '--agent', 'cline']);
  const lines = [];
  br.stdout.on('data', (d) => lines.push(...d.toString().trim().split('\n')));
  br.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cline' } } }) + '\n');
  br.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_search', arguments: { query: 'finished edits' } } }) + '\n');
  await new Promise((r) => setTimeout(r, 900));
  br.kill();
  const resp = lines.map((l) => JSON.parse(l)).find((x) => x.id === 2);
  assert(resp && resp.result.content[0].text.includes('finished 15 edits'));
  console.log('  ✓ stdio bridge: a stdio-only client read the memories the other 4 agents wrote');
  const snap = await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json();
  assert(names.every((n) => snap.agents.find((a) => a.id === n)));
  console.log(`  ✓ board shows all ${snap.agents.length} external agents; ${snap.stats.commits} commits, ${snap.stats.rebased} auto-rebased`);
  server.kill();
  console.log('\nMulti-process MCP test passed.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
