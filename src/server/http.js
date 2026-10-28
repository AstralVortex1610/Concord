// Concord local server: REST API, live events (SSE), the MCP endpoint (Streamable HTTP) and the browser dashboard.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TOOLS, runTool } = require('../core/tools');
const { version } = require('../../package.json');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { const s = Buffer.concat(chunks).toString('utf8'); if (!s) return resolve({}); try { resolve(JSON.parse(s)); } catch { reject(new Error('Body is not JSON')); } });
    req.on('error', reject);
  });
}

function createServer({ getCoordinator, staticDir, onPlan, onRestore, port = 4317, host = '127.0.0.1', token = '' }) {
  const clients = new Set();
  const sessions = new Map(); // mcp session id -> agent id
  let bound = null;

  const attach = () => {
    const c = getCoordinator();
    if (!c || bound === c) return c;
    if (bound) bound.removeListener('event', bound.__sse);
    bound = c;
    c.__sse = (e) => { const data = `data: ${JSON.stringify(e)}\n\n`; for (const res of clients) res.write(data); };
    c.on('event', c.__sse);
    for (const res of clients) res.write(`data: ${JSON.stringify({ type: 'project', at: Date.now() })}\n\n`);
    return c;
  };
  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'http://127.0.0.1:' + (server && server.address() ? server.address().port : port), ...headers }); res.end(JSON.stringify(obj)); };

  // ---------- MCP (JSON-RPC 2.0) ----------
  function mcpAgentId(req, params, sid) {
    if (sid && sessions.has(sid)) return sessions.get(sid);
    const url = new URL(req.url, 'http://x');
    const h = req.headers['x-concord-agent'] || url.searchParams.get('agent');
    const ci = params && params.clientInfo;
    return String(h || (ci && ci.name) || 'external-agent').replace(/[^\w.@-]/g, '-').slice(0, 48);
  }
  function handleRpc(msg, req, ctx) {
    const c = attach();
    const { id, method, params = {} } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'initialize') {
      const agent = mcpAgentId(req, params, null);
      const ci = params.clientInfo || {};
      const sid = 'cs-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessions.set(sid, agent);
      ctx.sessionId = sid;
      c.registerAgent({ id: agent, name: agent, model: ci.name ? `${ci.name}${ci.version ? ' ' + ci.version : ''}` : 'external', provider: 'MCP', kind: 'external' });
      const pv = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return ok({ protocolVersion: pv, capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} }, serverInfo: { name: 'concord', title: 'Concord', version },
        instructions: 'Concord coordinates many coding agents in one project. Call concord_briefing first. Read files to get their revision, reserve the function or lines you will change, edit with baseRev, and redo your edit on the fresh text if it is rejected. Share decisions with memory_write. Use ONLY these tools to change project files so you never overwrite another agent.' });
    }
    if (id === undefined) return null; // notification
    const agent = mcpAgentId(req, params, req.headers['mcp-session-id']);
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
    if (method === 'tools/call') {
      try {
        const r = runTool(c, agent, params.name, params.arguments || {});
        const isError = /^REJECTED|^Error/.test(r.text) || (r.data && r.data.ok === false);
        return ok({ content: [{ type: 'text', text: r.text }], isError: !!isError });
      } catch (e) { return ok({ content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
    }
    if (method === 'resources/list') return ok({ resources: [] });
    if (method === 'resources/templates/list') return ok({ resourceTemplates: [] });
    if (method === 'prompts/list') return ok({ prompts: [] });
    return err(-32601, `Method not found: ${method}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:' + (server && server.address() ? server.address().port : port), 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }); return res.end(); }
    // Only this machine may talk to Concord (DNS-rebinding guard).
    const hostHdr = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostHdr)) return send(res, 403, { error: 'Concord only accepts local connections.' });
    // A web page open in a browser must never drive Concord (CSRF): only the dashboard itself and non-browser clients
    // (MCP clients, scripts, which send no Origin) may call the API.
    const origin = req.headers.origin;
    if (origin && origin !== 'null' && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return send(res, 403, { error: 'Cross-site requests are not allowed.' });
    if (origin === 'null' && req.method !== 'GET') return send(res, 403, { error: 'Cross-site requests are not allowed.' });
    if (token && p.startsWith('/api') && req.headers['x-concord-token'] !== token && url.searchParams.get('token') !== token) return send(res, 401, { error: 'bad token' });
    try {
      const c = attach();
      if (p === '/mcp') {
        if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
        if (req.method === 'DELETE') { sessions.delete(req.headers['mcp-session-id']); res.writeHead(200); return res.end(); }
        const body = await readBody(req);
        const ctx = {};
        const batch = Array.isArray(body) ? body : [body];
        const out = batch.map((m) => handleRpc(m, req, ctx)).filter(Boolean);
        const headers = ctx.sessionId ? { 'Mcp-Session-Id': ctx.sessionId } : {};
        if (!out.length) { res.writeHead(202, headers); return res.end(); }
        return send(res, 200, Array.isArray(body) ? out : out[0], headers);
      }
      // Static dashboard.
      if (staticDir && req.method === 'GET') {
        const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
        const file = path.join(staticDir, rel);
        if (!p.startsWith('/api') && file.startsWith(staticDir) && fs.existsSync(file) && fs.statSync(file).isFile()) { res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); return fs.createReadStream(file).pipe(res); }
      }
      if (!c) return send(res, 503, { error: 'No project is open in Concord yet.' });
      if (p === '/api/health') return send(res, 200, { ok: true, name: 'concord', version, project: c.root });
      if (p === '/api/snapshot') return send(res, 200, c.snapshot());
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': 'http://127.0.0.1:' + (server && server.address() ? server.address().port : port) });
        res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
        clients.add(res);
        const ka = setInterval(() => res.write(': ka\n\n'), 20000);
        req.on('close', () => { clients.delete(res); clearInterval(ka); });
        return;
      }
      if (p === '/api/tools') return send(res, 200, TOOLS);
      if (p.startsWith('/api/tool/') && req.method === 'POST') {
        const b = await readBody(req);
        const agent = String(b.agent || req.headers['x-concord-agent'] || 'http-agent');
        if (!c.agents.has(agent) && agent !== 'user') c.registerAgent({ id: agent, name: b.agentName || agent, model: b.model || '', provider: 'HTTP', kind: 'external' });
        const r = runTool(c, agent, decodeURIComponent(p.slice(10)), b.args || {});
        return send(res, 200, { text: r.text, data: r.data });
      }
      if (p === '/api/register' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.registerAgent({ ...b, kind: 'external' })); }
      if (p === '/api/files') return send(res, 200, c.listFiles({ dir: url.searchParams.get('dir') || '' }));
      if (p === '/api/file') { const f = c.readFile(url.searchParams.get('path')); return send(res, 200, { ...f, symbols: f.exists ? c.symbols(f.path) : [], history: c.history(f.path, 40), revs: f.exists ? c.revisions(f.path) : [] }); }
      if (p === '/api/file/at') return send(res, 200, { text: c.textAt(url.searchParams.get('path'), url.searchParams.get('rev')) });
      if (p === '/api/file/revert' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.revertFile({ agent: b.agent || 'user', path: b.path, rev: b.rev })); }
      if (p === '/api/checkpoints') { const list = await c.listCheckpoints(Number(url.searchParams.get('limit')) || 60); const ready = c.checkpoints ? await c.checkpoints.ready() : false; return send(res, 200, { ready, list }); }
      if (p === '/api/checkpoint/changes') return send(res, 200, c.checkpoints ? await c.checkpoints.changed(url.searchParams.get('sha')) : []);
      if (p === '/api/checkpoint' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, await c.checkpoint(b.message || 'Manual checkpoint', { agent: 'user', manual: true })); }
      if (p === '/api/checkpoint/restore' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, onRestore ? await onRestore(b.sha) : await c.restoreCheckpoint(b.sha)); }
      if (p === '/api/submit' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.submit(b)); }
      if (p === '/api/lease' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.acquire(b)); }
      if (p === '/api/release' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.release(b)); }
      if (p === '/api/task' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.createTask({ ...b, createdBy: b.createdBy || 'user' })); }
      if (p === '/api/task/update' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.updateTask(b)); }
      if (p === '/api/task/delete' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.deleteTask(b)); }
      if (p === '/api/memory' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.remember(b)); }
      if (p === '/api/memory/search') return send(res, 200, c.recall({ query: url.searchParams.get('q') || '', limit: 40, kind: url.searchParams.get('kind') || undefined }));
      if (p === '/api/memory/delete' && req.method === 'POST') { const b = await readBody(req); return send(res, 200, c.forget(b)); }
      if (p === '/api/plan' && req.method === 'POST') { const b = await readBody(req); if (!onPlan) return send(res, 400, { error: 'Planning needs the desktop app.' }); return send(res, 200, { tasks: await onPlan(b.goal) }); }
      send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: e.message }); }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      let tries = 0;
      const tryPort = (pt) => {
        server.once('error', (e) => { if (e.code === 'EADDRINUSE' && tries++ < 10) tryPort(pt + 1); else reject(e); });
        server.listen(pt, host, () => resolve(server.address().port));
      };
      tryPort(port);
    }),
    close: () => new Promise((r) => { for (const res of clients) res.end(); server.close(() => r()); }),
  };
}

module.exports = { createServer };
