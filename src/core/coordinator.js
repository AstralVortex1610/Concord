// Concord coordinator: the single writer for a project folder.
// Holds canonical file revisions, leases (file / symbol / line range), the task board, shared memory and the event log.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { splitLines, joinLines, hunks, merge3, mapRange, mapHunksToCurrent, applyEdits } = require('./merge');
const { findSymbols, resolveSymbol } = require('./symbols');
const { Memory } = require('./memory');
const { Checkpoints } = require('./checkpoints');
const crypto = require('crypto');

const IGNORE = new Set(['node_modules', '.git', '.concord', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target', '.DS_Store']);
const MAX_FILE = 2 * 1024 * 1024;
const KEEP_REVS = 400;
const DISK_REVS = 60, DISK_REV_BYTES = 8 * 1024 * 1024; // revision history kept on disk per file (survives restarts)
const uid = (p) => p + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);
const PALETTE = ['#ff7a59', '#46d6b0', '#ffc94d', '#8f7bff', '#ff5fa2', '#4fb3ff', '#b6e35a', '#ff9f43', '#c58cff', '#5ce1e6'];

class Coordinator extends EventEmitter {
  constructor({ root, persist = true, leaseTtlMs = 10 * 60 * 1000 } = {}) {
    super();
    this.setMaxListeners(100);
    this.root = path.resolve(root);
    this.persist = persist;
    this.leaseTtlMs = leaseTtlMs;
    this.files = new Map();   // rel path -> { rev, text, revs: Map, mtime, history: [] }
    this.leases = [];
    this.tasks = [];
    this.agents = new Map();
    this.events = [];
    this.memory = new Memory();
    this.stats = { commits: 0, rebased: 0, conflicts: 0, blocked: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, calls: 0 };
    if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true });
    this.dataDir = path.join(this.root, '.concord');
    this._dirtyFiles = new Set();
    this.checkpoints = persist ? new Checkpoints(this.root, { log: (m) => this.emit('error-log', m) }) : null;
    this._load();
    this._sweep = setInterval(() => this._expireLeases(), 5000);
    if (this._sweep.unref) this._sweep.unref();
  }

  // ---------- persistence ----------
  _load() {
    if (!this.persist) return;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'state.json'), 'utf8'));
      this.tasks = j.tasks || [];
      this.memory = new Memory(j.memory || []);
      this.events = (j.events || []).slice(-1500);
      this.stats = Object.assign(this.stats, j.stats || {});
      for (const a of j.agents || []) this.agents.set(a.id, { ...a, online: false, status: 'idle' });
      // Work that was in flight when Concord closed goes back on the board instead of staying stuck.
      for (const t of this.tasks) if (t.status === 'working') { t.status = 'todo'; t.owner = null; t.history.push({ at: Date.now(), by: 'concord', text: 'returned to the board after a restart' }); }
      // Leases do not survive a restart: holders must re-claim.
    } catch { /* fresh project */ }
  }
  _save() {
    if (!this.persist) return;
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.saveNow(), 400);
  }
  saveNow() {
    if (!this.persist) return;
    this._flushRevs();
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const j = { version: 1, tasks: this.tasks, memory: this.memory.items, events: this.events.slice(-1500), stats: this.stats, agents: [...this.agents.values()] };
      const tmp = path.join(this.dataDir, 'state.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(j));
      fs.renameSync(tmp, path.join(this.dataDir, 'state.json'));
      const gi = path.join(this.dataDir, '.gitignore');
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
    } catch (e) { this.emit('error-log', e.message); }
  }
  close() { clearInterval(this._sweep); clearTimeout(this._cpT); this.saveNow(); }

  // ---------- revision history on disk ----------
  _revFile(rel) { return path.join(this.dataDir, 'revs', crypto.createHash('sha1').update(rel).digest('hex').slice(0, 20) + '.json'); }
  _loadRevs(rel) {
    if (!this.persist) return null;
    try { const j = JSON.parse(fs.readFileSync(this._revFile(rel), 'utf8')); return j && j.path === rel ? j : null; } catch { return null; }
  }
  _flushRevs() {
    if (!this.persist || !this._dirtyFiles.size) return;
    const dir = path.join(this.dataDir, 'revs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { }
    for (const rel of this._dirtyFiles) {
      const f = this.files.get(rel); if (!f) continue;
      const keys = [...f.revs.keys()].sort((a, b) => b - a);
      const keep = []; let bytes = 0;
      for (const k of keys) { const t = f.revs.get(k); bytes += t.length; if (keep.length >= 5 && (keep.length >= DISK_REVS || bytes > DISK_REV_BYTES)) break; keep.push([k, t]); }
      try { const file = this._revFile(rel); fs.writeFileSync(file + '.tmp', JSON.stringify({ path: rel, rev: f.rev, revs: keep, history: f.history.slice(-200) })); fs.renameSync(file + '.tmp', file); } catch (e) { this.emit('error-log', e.message); }
    }
    this._dirtyFiles.clear();
  }

  // ---------- checkpoints (private git history of the whole project) ----------
  async checkpoint(message = 'Checkpoint', meta = {}) {
    if (!this.checkpoints) return { ok: false, message: 'Checkpoints are off for this project.' };
    this.saveNow();
    try {
      const r = await this.checkpoints.snapshot(message, meta);
      if (r.ok && r.changed) this._event('checkpoint', { agent: meta.agent || 'concord', sha: r.sha, text: `checkpoint: ${message}` });
      return r;
    } catch (e) { this.emit('error-log', 'checkpoint failed: ' + e.message); return { ok: false, message: e.message }; }
  }
  _checkpointSoon(message, meta) { clearTimeout(this._cpT); this._cpT = setTimeout(() => this.checkpoint(message, meta), 1500); if (this._cpT.unref) this._cpT.unref(); }
  async listCheckpoints(limit) { return this.checkpoints ? this.checkpoints.list(limit) : []; }
  async restoreCheckpoint(sha, agent = 'user') {
    if (!this.checkpoints) return { ok: false, message: 'Checkpoints are off.' };
    if (this.leases.length) return { ok: false, message: 'Pause the team first: agents still hold reservations.' };
    this.saveNow();
    const r = await this.checkpoints.restore(sha);
    if (r.ok) {
      for (const [rel] of this.files) { try { this._entry(rel, this._abs(rel).abs); } catch { } if (!fs.existsSync(this._abs(rel).abs)) this.files.delete(rel); }
      this._event('checkpoint', { agent, sha, text: `restored the project to checkpoint ${String(sha).slice(0, 7)}` });
    }
    return r;
  }

  _event(type, data) {
    const e = { id: uid('e'), type, at: Date.now(), ...data };
    this.events.push(e);
    if (this.events.length > 3000) this.events.splice(0, 1000);
    this.emit('event', e);
    this._save();
    return e;
  }

  // ---------- agents ----------
  registerAgent({ id, name, model = '', provider = '', kind = 'external', color, role = '' }) {
    id = String(id || name || uid('agent')).replace(/[^\w.@-]/g, '-').slice(0, 48);
    const prev = this.agents.get(id);
    const a = { id, name: name || id, model, provider, kind, role, color: color || (prev && prev.color) || PALETTE[this.agents.size % PALETTE.length], online: true, seen: Date.now(), status: (prev && prev.status) || 'idle', joined: (prev && prev.joined) || Date.now() };
    this.agents.set(id, a);
    this._event('agent', { agent: id, text: prev ? `${a.name} reconnected` : `${a.name} joined${model ? ' on ' + model : ''}` });
    return a;
  }
  // Token meter: every built-in model call reports its usage here (totals and per agent).
  recordUsage(agent, u) {
    if (!u) return;
    this.stats.tokensIn = (this.stats.tokensIn || 0) + (u.input || 0);
    this.stats.tokensCached = (this.stats.tokensCached || 0) + (u.cached || 0);
    this.stats.tokensOut = (this.stats.tokensOut || 0) + (u.output || 0);
    this.stats.calls = (this.stats.calls || 0) + 1;
    const a = this.agents.get(agent);
    if (a) { a.tokens = a.tokens || { input: 0, cached: 0, output: 0 }; a.tokens.input += u.input || 0; a.tokens.cached += u.cached || 0; a.tokens.output += u.output || 0; }
    this.emit('event', { id: uid('u'), type: 'usage', transient: true, at: Date.now(), agent, input: u.input || 0, cached: u.cached || 0, output: u.output || 0 });
    this._save();
  }

  touch(agent, status) {
    const a = this.agents.get(agent);
    if (!a) return this.registerAgent({ id: agent });
    a.seen = Date.now(); a.online = true;
    if (status && a.status !== status) { a.status = status; this.emit('event', { id: uid('e'), type: 'agent-status', agent, status, at: Date.now(), transient: true }); }
    for (const l of this.leases) if (l.agent === agent) l.expiresAt = Date.now() + this.leaseTtlMs;
    return a;
  }
  setAgentOffline(agent) {
    const a = this.agents.get(agent); if (!a) return;
    a.online = false; a.status = 'offline';
    this.releaseAll(agent, 'went offline');
    this._event('agent', { agent, text: `${a.name} left` });
  }
  removeAgent(agent) { this.releaseAll(agent, 'removed'); this.agents.delete(agent); this._event('agent', { agent, text: `${agent} removed` }); }

  // ---------- files ----------
  _abs(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = path.resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`Path is outside the project: ${rel}`);
    const parts = path.relative(this.root, abs).split(path.sep);
    if (parts.some((p) => p === '.concord' || p === '.git')) throw new Error(`Concord does not edit ${rel}`);
    return { abs, rel: path.relative(this.root, abs).split(path.sep).join('/') };
  }
  _entry(rel, abs) {
    let f = this.files.get(rel);
    let st = null;
    try { st = fs.statSync(abs); } catch { /* missing */ }
    if (st && st.isDirectory()) throw new Error(`${rel} is a folder`);
    if (st && st.size > MAX_FILE) throw new Error(`${rel} is too large (${Math.round(st.size / 1024)} KB)`);
    if (!f) {
      if (!st) return null;
      const text = fs.readFileSync(abs, 'utf8');
      const saved = this._loadRevs(rel);
      if (saved && saved.revs && saved.revs.length) {
        // Pick up where the last session left off, so revision numbers and undo history survive a restart.
        const revs = new Map(saved.revs.map(([k, t]) => [Number(k), t]));
        f = { rev: saved.rev, text: revs.get(saved.rev) ?? text, revs, mtime: st.mtimeMs, history: saved.history || [] };
        this.files.set(rel, f);
        if (text !== f.text) this._commit(rel, f, text, { agent: 'disk', message: 'changed while Concord was closed', baseRev: f.rev });
        return f;
      }
      f = { rev: 1, text, revs: new Map([[1, text]]), mtime: st.mtimeMs, history: [{ rev: 1, agent: 'disk', message: 'opened', at: Date.now() }] };
      this.files.set(rel, f);
      return f;
    }
    // Someone edited the file outside Concord (an editor, git): take it in as a new revision.
    if (st && st.mtimeMs !== f.mtime) {
      const disk = fs.readFileSync(abs, 'utf8');
      f.mtime = st.mtimeMs;
      if (disk !== f.text) this._commit(rel, f, disk, { agent: 'disk', message: 'changed on disk', baseRev: f.rev });
    }
    if (!st && f.text !== null) { /* deleted on disk */ }
    return f;
  }
  exists(rel) { const { abs } = this._abs(rel); return fs.existsSync(abs); }

  listFiles({ dir = '', limit = 20000 } = {}) {
    const out = [];
    const start = this._abs(dir || '.').abs;
    const walk = (d) => {
      if (out.length >= limit) return;
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      ents.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of ents) {
        if (IGNORE.has(e.name) || e.name.startsWith('.') && e.name !== '.env.example' && e.name !== '.gitignore') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const rel = path.relative(this.root, p).split(path.sep).join('/');
          let size = 0; try { size = fs.statSync(p).size; } catch { }
          const f = this.files.get(rel);
          out.push({ path: rel, size, rev: f ? f.rev : 1, leases: this.leases.filter((l) => l.path === rel).length });
        }
        if (out.length >= limit) return;
      }
    };
    walk(start);
    return out;
  }

  readFile(relIn, { agent, numbered = false } = {}) {
    const { abs, rel } = this._abs(relIn);
    const f = this._entry(rel, abs);
    if (!f) return { path: rel, exists: false, rev: 0, text: '', leases: [] };
    if (agent) this.touch(agent);
    const text = f.text;
    return {
      path: rel, exists: true, rev: f.rev, text,
      numbered: numbered ? splitLines(text).map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n') : undefined,
      lines: splitLines(text).length,
      leases: this.leasesFor(rel),
    };
  }
  symbols(relIn) {
    const { abs, rel } = this._abs(relIn);
    const f = this._entry(rel, abs);
    if (!f) return [];
    return findSymbols(f.text, rel).map((s) => ({ ...s, heldBy: this._holder(rel, s.start - 1, s.end) }));
  }
  history(relIn, limit = 50) {
    const { rel } = this._abs(relIn);
    const f = this.files.get(rel);
    return f ? f.history.slice(-limit).reverse() : [];
  }
  textAt(relIn, rev) { const { rel } = this._abs(relIn); const f = this.files.get(rel); return f ? f.revs.get(Number(rev)) ?? null : null; }

  // Submit an edit. Either `content` (the whole new file as the agent wants it) or `edits` ([{old,new}] / [{startLine,endLine,text}]),
  // both relative to `baseRev`, the revision the agent read. Returns { ok, rev, rebased } or { ok:false, reason, ... fresh text }.
  submit({ agent = 'user', path: relIn, baseRev, content, edits, message = '' }) {
    const { abs, rel } = this._abs(relIn);
    if (agent) this.touch(agent, 'editing');
    let f = this._entry(rel, abs);
    if (!f) {
      // Creating a file.
      if (Number(baseRev || 0) !== 0) return this._reject(agent, rel, 'stale', 'The file does not exist (it may have been deleted). Read it again or create it with baseRev 0.', null);
      const holder = this.leases.find((l) => l.path === rel && l.agent !== agent);
      if (holder) return this._reject(agent, rel, 'leased', `${this._name(holder.agent)} has reserved ${rel}.`, null, holder);
      const text = content != null ? String(content) : applyEdits('', edits);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      f = { rev: 0, text: '', revs: new Map([[0, '']]), mtime: 0, history: [] };
      this.files.set(rel, f);
      return this._commit(rel, f, text, { agent, message: message || 'created file', baseRev: 0 });
    }
    baseRev = Number(baseRev);
    if (!Number.isFinite(baseRev)) baseRev = f.rev;
    const base = f.revs.get(baseRev);
    if (base == null) return this._reject(agent, rel, 'stale', `Revision ${baseRev} is too old to merge. Here is the current file; redo your change on it.`, f);
    let incoming;
    try { incoming = content != null ? String(content) : applyEdits(base, edits); }
    catch (e) { return this._reject(agent, rel, 'bad_edit', e.message, f); }
    if (incoming === base) return { ok: true, rev: f.rev, noop: true, message: 'No change.' };

    const B = splitLines(base), O = splitLines(f.text), T = splitLines(incoming);
    const A = baseRev === f.rev ? [] : hunks(B, O);
    const inc = hunks(B, T);
    // Leases: incoming change must not touch lines reserved by another agent.
    const landed = mapHunksToCurrent(inc, A);
    for (const m of landed) {
      const l = this._blocking(rel, agent, m);
      if (l) { this.stats.blocked++; return this._reject(agent, rel, 'leased', `Lines ${m.start + 1}-${Math.max(m.start + 1, m.end)} are reserved by ${this._name(l.agent)} (${l.label}). Pick other lines, wait, or ask on the board.`, f, l); }
    }
    let merged;
    if (baseRev === f.rev) merged = T;
    else {
      const r = merge3(B, O, T);
      if (!r.ok) { this.stats.conflicts++; return this._reject(agent, rel, 'conflict', `Another agent changed the same lines since revision ${baseRev}. Here is the current file (revision ${f.rev}); redo your change on it.`, f, null, r.conflicts); }
      merged = r.lines;
    }
    return this._commit(rel, f, joinLines(merged), { agent, message, baseRev });
  }

  _commit(rel, f, text, { agent, message, baseRev }) {
    const oldLines = splitLines(f.text), newLines = splitLines(text);
    const hs = hunks(oldLines, newLines);
    // Move every lease on this file with the code it covers.
    for (const l of this.leases) {
      if (l.path !== rel || l.kind === 'file') continue;
      const r = mapRange({ start: l.start, end: l.end }, hs, l.agent === agent);
      l.start = r.start; l.end = r.end;
    }
    const rebased = baseRev !== f.rev && agent !== 'disk';
    f.rev += 1; f.text = text; f.revs.set(f.rev, text);
    if (f.revs.size > KEEP_REVS) f.revs.delete(Math.min(...f.revs.keys()));
    let add = 0, del = 0; for (const h of hs) { add += h.lines.length; del += h.end - h.start; }
    f.history.push({ rev: f.rev, agent, message: String(message || '').slice(0, 200), at: Date.now(), add, del, baseRev, rebased });
    if (f.history.length > 300) f.history.splice(0, 100);
    this._dirtyFiles.add(rel);
    if (agent !== 'disk') {
      const { abs } = this._abs(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.concord-tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, abs);
      try { f.mtime = fs.statSync(abs).mtimeMs; } catch { }
      this.stats.commits++; if (rebased) this.stats.rebased++;
    }
    const first = hs[0];
    this._event('commit', { agent, path: rel, rev: f.rev, baseRev, rebased, add, del, line: first ? first.start + 1 : 1, text: message || `edited ${rel}` });
    return { ok: true, path: rel, rev: f.rev, rebased, add, del, message: rebased ? `Merged on top of newer changes (your base ${baseRev}, now revision ${f.rev}).` : `Saved as revision ${f.rev}.` };
  }

  _reject(agent, rel, reason, message, f, lease, conflicts) {
    this._event('reject', { agent, path: rel, reason, text: message.split('\n')[0], holder: lease ? lease.agent : undefined });
    return { ok: false, reason, message, path: rel, rev: f ? f.rev : 0, current: f ? f.text : undefined, conflicts, heldBy: lease ? { agent: lease.agent, name: this._name(lease.agent), label: lease.label, startLine: lease.start + 1, endLine: lease.end } : undefined };
  }

  // Undo: bring a file back to an earlier revision, as a new revision (so the undo can be undone too).
  revertFile({ agent = 'user', path: relIn, rev }) {
    const { abs, rel } = this._abs(relIn);
    const f = this._entry(rel, abs);
    if (!f) return { ok: false, message: `${rel} does not exist.` };
    const old = f.revs.get(Number(rev));
    if (old == null) return { ok: false, message: `Revision ${rev} is no longer kept. Use a project checkpoint instead.` };
    const other = this.leases.find((l) => l.path === rel && l.agent !== agent);
    if (other) return { ok: false, reason: 'leased', message: `${this._name(other.agent)} is working in ${rel} (${other.label}). Pause the team or wait, then restore.` };
    if (old === f.text) return { ok: true, rev: f.rev, noop: true, message: 'Already at that content.' };
    return this._commit(rel, f, old, { agent, message: `restored revision ${rev}`, baseRev: f.rev });
  }
  revisions(relIn) { const { rel } = this._abs(relIn); const f = this.files.get(rel); return f ? [...f.revs.keys()].sort((a, b) => b - a) : []; }

  deleteFile({ agent = 'user', path: relIn }) {
    const { abs, rel } = this._abs(relIn);
    const other = this.leases.find((l) => l.path === rel && l.agent !== agent);
    if (other) return { ok: false, reason: 'leased', message: `${this._name(other.agent)} holds part of ${rel}.` };
    try { fs.unlinkSync(abs); } catch (e) { return { ok: false, reason: 'missing', message: e.message }; }
    this.files.delete(rel);
    this.leases = this.leases.filter((l) => l.path !== rel);
    this._event('commit', { agent, path: rel, rev: 0, add: 0, del: 0, text: `deleted ${rel}`, deleted: true });
    return { ok: true };
  }

  // ---------- leases ----------
  _name(agent) { const a = this.agents.get(agent); return a ? a.name : agent; }
  leasesFor(rel) { return this.leases.filter((l) => l.path === rel).map((l) => this._pub(l)); }
  _pub(l) { return { id: l.id, agent: l.agent, name: this._name(l.agent), color: (this.agents.get(l.agent) || {}).color, path: l.path, kind: l.kind, symbol: l.symbol, label: l.label, startLine: l.kind === 'file' ? 1 : l.start + 1, endLine: l.kind === 'file' ? null : l.end, reason: l.reason, taskId: l.taskId, expiresAt: l.expiresAt, at: l.at }; }
  allLeases() { return this.leases.map((l) => this._pub(l)); }
  _holder(rel, s, e) { const l = this.leases.find((x) => x.path === rel && (x.kind === 'file' || (x.start < e && s < x.end))); return l ? { agent: l.agent, name: this._name(l.agent) } : null; }
  _blocking(rel, agent, m) {
    for (const l of this.leases) {
      if (l.path !== rel || l.agent === agent) continue;
      if (l.kind === 'file') return l;
      if (m.start < l.end && l.start < m.end) return l;                 // touches reserved lines
      if (m.insert && l.start < m.start && m.start < l.end) return l;  // inserts inside a reserved block
    }
    return null;
  }

  // scope: { path, symbol? , startLine?, endLine? }  (no symbol and no lines = whole file)
  acquire({ agent, path: relIn, symbol, startLine, endLine, reason = '', taskId, ttlMs }) {
    if (!agent) throw new Error('agent is required');
    const { abs, rel } = this._abs(relIn);
    this.touch(agent);
    const f = this._entry(rel, abs);
    let kind = 'file', start = 0, end = 0, label = 'whole file';
    if (symbol) {
      if (!f) return { ok: false, reason: 'missing', message: `${rel} does not exist yet, so it has no symbol ${symbol}. Reserve the whole file instead.` };
      const s = resolveSymbol(f.text, rel, symbol);
      if (!s) return { ok: false, reason: 'no_symbol', message: `No function or class named ${symbol} in ${rel}. Available: ${findSymbols(f.text, rel).map((x) => x.name).slice(0, 30).join(', ') || 'none found'}.` };
      kind = 'symbol'; start = s.start - 1; end = s.end; label = `${s.kind} ${symbol}`;
    } else if (startLine != null) {
      const n = f ? splitLines(f.text).length : 0;
      start = Math.max(0, Number(startLine) - 1); end = Math.min(Math.max(start + 1, Number(endLine || startLine)), Math.max(n, start + 1));
      kind = 'lines'; label = `lines ${start + 1}-${end}`;
    }
    for (const l of this.leases) {
      if (l.path !== rel || l.agent === agent) continue;
      const clash = l.kind === 'file' || kind === 'file' || (start < l.end && l.start < end);
      if (clash) {
        this._event('reject', { agent, path: rel, reason: 'leased', text: `wanted ${label}, held by ${this._name(l.agent)}`, holder: l.agent });
        return { ok: false, reason: 'leased', message: `${this._name(l.agent)} already holds ${l.label} in ${rel}${l.reason ? ' (' + l.reason + ')' : ''}.`, heldBy: this._pub(l) };
      }
    }
    // Replace this agent's own overlapping lease on the same file.
    this.leases = this.leases.filter((l) => !(l.agent === agent && l.path === rel && (kind === 'file' || l.kind === 'file' || (start < l.end && l.start < end))));
    const lease = { id: uid('L'), agent, path: rel, kind, symbol, start, end, label, reason: String(reason).slice(0, 160), taskId, at: Date.now(), expiresAt: Date.now() + (ttlMs || this.leaseTtlMs) };
    this.leases.push(lease);
    this._event('lease', { agent, path: rel, lease: lease.id, text: `reserved ${label} in ${rel}`, label });
    return { ok: true, lease: this._pub(lease), rev: f ? f.rev : 0 };
  }
  release({ agent, leaseId, path: relIn }) {
    const before = this.leases.length;
    const rel = relIn ? this._abs(relIn).rel : null;
    const gone = this.leases.filter((l) => (leaseId ? l.id === leaseId : true) && (rel ? l.path === rel : true) && (!agent || l.agent === agent));
    this.leases = this.leases.filter((l) => !gone.includes(l));
    for (const l of gone) this._event('release', { agent: l.agent, path: l.path, text: `released ${l.label} in ${l.path}` });
    return { ok: true, released: before - this.leases.length };
  }
  releaseAll(agent, why = '') {
    const gone = this.leases.filter((l) => l.agent === agent);
    if (!gone.length) return 0;
    this.leases = this.leases.filter((l) => l.agent !== agent);
    this._event('release', { agent, text: `released ${gone.length} reservation${gone.length > 1 ? 's' : ''}${why ? ' (' + why + ')' : ''}` });
    return gone.length;
  }
  _expireLeases() {
    const now = Date.now();
    const gone = this.leases.filter((l) => l.expiresAt < now);
    if (!gone.length) return;
    this.leases = this.leases.filter((l) => l.expiresAt >= now);
    for (const l of gone) this._event('release', { agent: l.agent, path: l.path, text: `${l.label} in ${l.path} expired` });
  }

  // ---------- board ----------
  createTask({ title, detail = '', files = [], priority = 'normal', kind = 'task', parent = null, createdBy = 'user', model }) {
    if (!title) throw new Error('title is required');
    const t = { id: 'T' + (this.tasks.length + 1) + '-' + Math.random().toString(36).slice(2, 5), title: String(title).slice(0, 200), detail: String(detail).slice(0, 4000), files: [].concat(files || []), priority, kind, parent, model, status: 'todo', owner: null, createdBy, at: Date.now(), updated: Date.now(), notes: [], history: [{ at: Date.now(), by: createdBy, text: 'created' }] };
    this.tasks.push(t);
    this._event('task', { agent: createdBy, task: t.id, text: `added task “${t.title}”` });
    return t;
  }
  claimTask({ agent, taskId }) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false, message: `No task ${taskId}` };
    if (t.owner && t.owner !== agent && !['done', 'todo'].includes(t.status)) return { ok: false, message: `${this._name(t.owner)} already claimed “${t.title}”.`, owner: t.owner };
    if (t.status === 'done') return { ok: false, message: 'That task is already done.' };
    t.owner = agent; t.status = 'working'; t.updated = Date.now();
    t.history.push({ at: Date.now(), by: agent, text: 'claimed' });
    this.touch(agent, 'working');
    this._event('task', { agent, task: t.id, text: `claimed “${t.title}”` });
    return { ok: true, task: t };
  }
  nextTask(agent) {
    const prio = { high: 0, normal: 1, low: 2 };
    const open = this.tasks.filter((t) => t.status === 'todo' && !t.owner && t.kind !== 'goal')
      .sort((a, b) => (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1) || a.at - b.at);
    for (const t of open) { const r = this.claimTask({ agent, taskId: t.id }); if (r.ok) return t; }
    return null;
  }
  updateTask({ agent = 'user', taskId, status, note, title, detail, owner, priority }) {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false, message: `No task ${taskId}` };
    if (status) { t.status = status; if (status === 'todo') t.owner = owner === undefined ? null : owner; }
    if (owner !== undefined && status !== 'todo') t.owner = owner;
    if (title) t.title = title;
    if (detail != null) t.detail = detail;
    if (priority) t.priority = priority;
    if (note) t.notes.push({ at: Date.now(), by: agent, text: String(note).slice(0, 2000) });
    t.updated = Date.now();
    const text = status ? `moved “${t.title}” to ${status}` : note ? `noted on “${t.title}”` : `updated “${t.title}”`;
    t.history.push({ at: Date.now(), by: agent, text: status ? `status → ${status}${note ? ': ' + note : ''}` : (note || 'edited') });
    if (status === 'done' || status === 'review') { this.release({ agent: t.owner || agent }); this.touch(t.owner || agent, 'idle'); this._checkpointSoon(`${this._name(t.owner || agent)} finished “${t.title}”`, { agent: t.owner || agent, task: t.id }); }
    this._event('task', { agent, task: t.id, text });
    return { ok: true, task: t };
  }
  deleteTask({ taskId, agent = 'user' }) { const t = this.tasks.find((x) => x.id === taskId); this.tasks = this.tasks.filter((x) => x.id !== taskId); if (t) this._event('task', { agent, task: taskId, text: `removed “${t.title}”` }); return { ok: !!t }; }

  // ---------- memory ----------
  remember({ agent = 'user', kind, title, body, tags, files }) {
    const it = this.memory.add({ kind, title, body, tags, files, agent });
    this._event('memory', { agent, memory: it.id, text: `remembered: ${it.title || it.body.slice(0, 60)}` });
    return it;
  }
  recall({ query = '', limit = 8, kind } = {}) { return this.memory.search(query, { limit, kind }); }
  forget({ id, agent = 'user' }) { const ok = this.memory.remove(id); if (ok) this._event('memory', { agent, text: 'removed a memory' }); return { ok }; }

  // ---------- overview ----------
  snapshot() {
    return {
      root: this.root,
      name: path.basename(this.root),
      agents: [...this.agents.values()],
      tasks: this.tasks,
      leases: this.allLeases(),
      memory: this.memory.items.slice(-300),
      events: this.events.slice(-200),
      stats: this.stats,
    };
  }
  briefing(agent) {
    const mine = this.leases.filter((l) => l.agent === agent).map((l) => `${l.path} (${l.label})`);
    const others = this.leases.filter((l) => l.agent !== agent).map((l) => `${this._name(l.agent)}: ${l.path} ${l.label}`);
    const tasks = this.tasks.filter((t) => t.status !== 'done').map((t) => `[${t.id}] ${t.status}${t.owner ? ' by ' + this._name(t.owner) : ''}: ${t.title}`);
    const conv = this.memory.items.filter((m) => m.kind === 'convention' || m.kind === 'decision').slice(-12).map((m) => `- (${m.kind}) ${m.title}${m.body ? ': ' + m.body.slice(0, 200) : ''}`);
    return [
      `Project: ${path.basename(this.root)}`,
      `Open tasks:\n${tasks.join('\n') || '(none)'}`,
      `Your reservations: ${mine.join('; ') || 'none'}`,
      `Reserved by others (do not edit these lines): ${others.join('; ') || 'none'}`,
      `Team conventions and decisions:\n${conv.join('\n') || '(none yet)'}`,
    ].join('\n\n');
  }
}

module.exports = { Coordinator, PALETTE };
