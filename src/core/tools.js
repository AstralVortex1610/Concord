// The Concord toolset. Built-in agents, MCP clients and the HTTP API all call these same tools.
const fs = require('fs');
const path = require('path');
const { splitLines, hunks } = require('./merge');
const { findSymbols } = require('./symbols');

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d });
const int = (d) => ({ type: 'integer', description: d });

const TOOLS = [
  { name: 'concord_briefing', description: 'Start here. Shows open tasks, who holds which files or functions, and the team conventions. Call it before you plan work and whenever you are unsure what others are doing.', parameters: S({}) },
  { name: 'list_files', description: 'List files in the project (or a sub folder) with their revision and how many reservations they have.', parameters: S({ dir: str('Folder relative to the project root. Empty for the whole project.') }) },
  { name: 'read_file', description: 'Read a file with line numbers. Returns its revision number: pass that as baseRev when you edit, so Concord can merge your change with edits other agents made meanwhile. Also lists who has reserved which lines. To save tokens: read one function with symbol, a slice with startLine/endLine, or only what changed since a revision you already have with sinceRev.', parameters: S({ path: str('File path relative to the project root.'), startLine: int('Optional first line to show.'), endLine: int('Optional last line to show.'), symbol: str('Optional function or class name: shows just that code.'), sinceRev: int('Optional revision you already read: shows only the lines that changed since then.') }, ['path']) },
  { name: 'find_symbols', description: 'List the functions and classes in a file with their line ranges and who holds each.', parameters: S({ path: str('File path.') }, ['path']) },
  { name: 'search_code', description: 'Search the project text for a word or phrase (case-insensitive). Returns matching lines with file and line number.', parameters: S({ query: str('Text to find.'), dir: str('Optional folder to limit the search.') }, ['query']) },
  { name: 'reserve', description: 'Reserve what you are about to change so no other agent edits it: a function or class (symbol), a line range, or the whole file (give only path). Reservations follow the code as the file changes and expire after 10 minutes without activity. Reserve the smallest scope you need.', parameters: S({ path: str('File path.'), symbol: str('Function or class name, e.g. "parseConfig" or "Cart.total".'), startLine: int('First line of a range.'), endLine: int('Last line of a range.'), reason: str('Short note shown on the board.') }, ['path']) },
  { name: 'release', description: 'Release your reservations (one file, or all of them when path is empty) when you are done so others can work there.', parameters: S({ path: str('Optional file path.') }) },
  { name: 'edit_file', description: 'Change an existing file by exact replacement. Each edit replaces `old` (copied exactly from the file, unique, a few lines) with `new`. baseRev is the revision you read. If others changed different lines meanwhile Concord merges automatically; if your lines changed or are reserved by someone else, you get the fresh file and must redo the edit.', parameters: S({ path: str('File path.'), baseRev: int('Revision number from read_file.'), edits: { type: 'array', items: S({ old: str('Exact existing text to replace.'), new: str('Replacement text.') }, ['old', 'new']) }, message: str('One line describing the change.') }, ['path', 'baseRev', 'edits']) },
  { name: 'write_file', description: 'Create a new file (baseRev 0) or replace a whole file (baseRev from read_file). Prefer edit_file for small changes to existing files.', parameters: S({ path: str('File path.'), baseRev: int('0 to create, otherwise the revision you read.'), content: str('The full file content.'), message: str('One line describing the change.'), overwrite: { type: 'boolean', description: 'Set true only when you really mean to remove most of the existing file.' } }, ['path', 'baseRev', 'content']) },
  { name: 'delete_file', description: 'Delete a file nobody else has reserved.', parameters: S({ path: str('File path.') }, ['path']) },
  { name: 'board_list', description: 'List tasks on the shared board with status and owner.', parameters: S({ status: str('Optional filter: todo, working, review, done, blocked.') }) },
  { name: 'task_create', description: 'Add a task to the shared board (split big work into small tasks other agents can pick up).', parameters: S({ title: str('Short task title.'), detail: str('What done looks like.'), files: { type: 'array', items: { type: 'string' }, description: 'Files it will likely touch.' }, priority: str('high, normal or low.') }, ['title']) },
  { name: 'task_claim', description: 'Claim a task so others know you are on it. Fails if someone else already has it.', parameters: S({ taskId: str('Task id, e.g. T3-x1y.') }, ['taskId']) },
  { name: 'task_update', description: 'Update a task: set status (working, review, done, blocked, todo) and/or add a note. Moving to done or review releases your reservations.', parameters: S({ taskId: str('Task id.'), status: str('New status.'), note: str('Progress note or result summary.') }, ['taskId']) },
  { name: 'memory_search', description: 'Search the shared project memory: decisions, conventions, facts and lessons other agents saved.', parameters: S({ query: str('What you want to know.'), kind: str('Optional: decision, convention, fact, lesson, todo.') }, ['query']) },
  { name: 'memory_write', description: 'Save something every agent should know: a decision and why, a convention (naming, style, structure), a fact about the code, or a lesson learned.', parameters: S({ kind: str('decision, convention, fact, lesson or todo.'), title: str('One line.'), body: str('Details.'), tags: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } } }, ['kind', 'title']) },
];

function numbered(text, from = 1, to) {
  const lines = String(text).split('\n');
  const s = Math.max(1, from || 1), e = Math.min(lines.length, to || lines.length);
  return lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(4)}| ${l}`).join('\n');
}

function searchCode(c, query, dir) {
  const q = String(query || '').toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const f of c.listFiles({ dir })) {
    if (f.size > 600000 || /\.(png|jpe?g|gif|ico|pdf|zip|exe|dll|woff2?|ttf|mp[34]|lock)$/i.test(f.path)) continue;
    let text; try { text = c.readFile(f.path).text; } catch { continue; }
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((l, i) => { if (hits.length < 80 && l.toLowerCase().includes(q)) hits.push(`${f.path}:${i + 1}: ${l.trim().slice(0, 200)}`); });
    if (hits.length >= 80) break;
  }
  return hits;
}

// ---------- token saver helpers ----------
const LONG_FILE = 220;   // lines; longer files are read as an outline first
// What changed in a file since a revision the agent already has, as numbered current lines with a little context.
// Returns null when the full file would be about as cheap, or the old revision is gone.
function delta(c, rel, sinceRev, text, rev) {
  if (sinceRev === rev) return `--- unchanged since rev ${sinceRev}: the copy you already read is current.`;
  const old = c.textAt(rel, sinceRev);
  if (old == null) return null;
  const O = splitLines(old), N = splitLines(text);
  const hs = hunks(O, N);
  if (!hs.length) return `--- no line changes since rev ${sinceRev}.`;
  // Map each hunk to current line numbers.
  let shift = 0; const spans = [];
  for (const h of hs) { const ns = h.start + shift; spans.push([Math.max(1, ns + 1 - 2), Math.min(N.length, ns + h.lines.length + 2), h]); shift += h.lines.length - (h.end - h.start); }
  const merged = [];
  for (const sp of spans) { const l = merged[merged.length - 1]; if (l && sp[0] <= l[1] + 1) { l[1] = Math.max(l[1], sp[1]); l[2] += (sp[2].end - sp[2].start); } else merged.push([sp[0], sp[1], sp[2].end - sp[2].start]); }
  let body = '', removedOnly = 0;
  for (const [s0, e0, del] of merged) {
    if (e0 < s0) { removedOnly += del; continue; }
    body += `@@ now lines ${s0}-${e0}${del ? ` (replaced ${del} old line${del > 1 ? 's' : ''})` : ''}\n${numbered(text, s0, e0)}\n`;
  }
  if (body.length > text.length * 0.6) return null;
  return `--- changes since rev ${sinceRev} (other lines are as you last read them, but line numbers may have shifted)${removedOnly ? `; ${removedOnly} line(s) were deleted` : ''}:\n${body}`;
}

// Run a tool for an agent. Always returns a string (for models) plus structured data.
function runTool(c, agent, name, args = {}, ctx = {}) {
  const a = args || {};
  const out = (data, text) => ({ data, text: text ?? JSON.stringify(data, null, 1) });
  switch (name) {
    case 'concord_briefing': return out(null, c.briefing(agent));
    case 'list_files': { const fl = c.listFiles({ dir: a.dir || '' }); return out(fl, fl.map((f) => `${f.path}  (rev ${f.rev}${f.leases ? ', ' + f.leases + ' reserved' : ''})`).join('\n') || '(empty project)'); }
    case 'read_file': {
      const f = c.readFile(a.path, { agent });
      if (!f.exists) return out(f, `${f.path} does not exist yet. Create it with write_file and baseRev 0.`);
      const held = f.leases.map((l) => `  ${l.name}${l.agent === agent ? ' (you)' : ''}: ${l.label}${l.kind === 'file' ? '' : ` [lines ${l.startLine}-${l.endLine}]`}`).join('\n');
      const head = `${f.path}  revision ${f.rev}  (${f.lines} lines)\n${held ? 'Reserved:\n' + held + '\n' : ''}`;
      const data = { path: f.path, rev: f.rev, lines: f.lines, leases: f.leases };
      const seen = ctx.seen;
      if (a.symbol) {
        const sym = findSymbols(f.text, f.path).find((x) => x.name === a.symbol || x.name.endsWith('.' + a.symbol));
        if (sym) return out(data, `${head}--- ${sym.kind} ${sym.name}, lines ${sym.start}-${sym.end}\n${numbered(f.text, sym.start, sym.end)}`);
      }
      if (a.startLine || a.endLine) return out(data, `${head}---\n${numbered(f.text, a.startLine, a.endLine)}`);
      const since = Number(a.sinceRev) || (ctx.lean && seen ? seen.get(f.path) : 0);
      if (since) {
        const d = delta(c, f.path, since, f.text, f.rev);
        if (d) { if (seen) seen.set(f.path, f.rev); return out({ ...data, delta: true }, head + d); }
      }
      if (ctx.lean && f.lines > LONG_FILE) {
        const syms = findSymbols(f.text, f.path);
        if (syms.length >= 3) return out({ ...data, outline: true }, `${head}--- long file, outline only (to save tokens). Read what you need with symbol, or startLine/endLine.\n${syms.map((x) => `  ${x.kind} ${x.name}  lines ${x.start}-${x.end}`).join('\n')}\n--- first lines\n${numbered(f.text, 1, 30)}`);
      }
      if (seen) seen.set(f.path, f.rev);
      return out(data, `${head}---\n${numbered(f.text)}`);
    }
    case 'find_symbols': { const s = c.symbols(a.path); return out(s, s.map((x) => `${x.kind} ${x.name}  lines ${x.start}-${x.end}${x.heldBy ? '  held by ' + x.heldBy.name : ''}`).join('\n') || 'No functions or classes found.'); }
    case 'search_code': { const h = searchCode(c, a.query, a.dir); return out(h, h.join('\n') || 'No matches.'); }
    case 'reserve': { const r = c.acquire({ agent, path: a.path, symbol: a.symbol, startLine: a.startLine, endLine: a.endLine, reason: a.reason }); return out(r, r.ok ? `Reserved ${r.lease.label} in ${r.lease.path}${r.lease.endLine ? ` (lines ${r.lease.startLine}-${r.lease.endLine})` : ''}. File is at revision ${r.rev}.` : r.message); }
    case 'release': { const r = c.release({ agent, path: a.path || undefined }); return out(r, `Released ${r.released} reservation(s).`); }
    case 'edit_file':
    case 'write_file': {
      if (name === 'write_file' && Number(a.baseRev) > 0 && !a.overwrite) {
        // Guard against a model replacing a whole file with a fragment (a common small-model mistake).
        const cur = c.textAt(a.path, Number(a.baseRev));
        if (cur != null) {
          const keep = new Set(String(a.content || '').split('\n').map((l) => l.trim()).filter(Boolean));
          const old = cur.split('\n').map((l) => l.trim()).filter(Boolean);
          const lost = old.filter((l) => !keep.has(l));
          if (old.length >= 4 && lost.length / old.length > 0.5) return out({ ok: false, reason: 'would_erase' }, `REJECTED (would_erase): this write_file would delete ${lost.length} of ${old.length} existing lines of ${a.path}, e.g. "${lost[0].slice(0, 80)}". To add or change code, use edit_file with a small "old" snippet. If you really want to replace most of the file, call write_file again with overwrite: true.`);
        }
      }
      const r = c.submit({ agent, path: a.path, baseRev: a.baseRev, edits: name === 'edit_file' ? a.edits : undefined, content: name === 'write_file' ? a.content : undefined, message: a.message });
      if (r.ok) return out(r, r.noop ? 'No change was needed.' : `${r.message} (+${r.add} −${r.del} lines)`);
      let fresh = r.current != null ? `\n\nCurrent ${r.path} at revision ${r.rev}:\n${numbered(r.current)}` : '';
      if (r.current != null && ctx.lean) {
        // Token saver: the agent already holds its base revision, so send only what others changed since then.
        const d = Number(a.baseRev) ? delta(c, r.path, Number(a.baseRev), r.current, r.rev) : null;
        if (d) fresh = `\n\n${d}\nRedo your edit on revision ${r.rev} (use baseRev ${r.rev}).`;
        if (ctx.seen) ctx.seen.set(r.path, r.rev);
      }
      const conf = r.conflicts ? '\n\nClashing region(s): ' + r.conflicts.map((x) => `around line ${x.start}`).join(', ') : '';
      return out({ ...r, current: undefined }, `REJECTED (${r.reason}): ${r.message}${conf}${fresh}`);
    }
    case 'delete_file': { const r = c.deleteFile({ agent, path: a.path }); return out(r, r.ok ? `Deleted ${a.path}.` : r.message); }
    case 'board_list': { const ts = c.tasks.filter((t) => !a.status || t.status === a.status); return out(ts, ts.map((t) => `[${t.id}] ${t.status.padEnd(7)} ${t.owner ? '@' + c._name(t.owner) + ' ' : ''}${t.title}${t.detail ? ' — ' + t.detail.slice(0, 140) : ''}`).join('\n') || 'The board is empty.'); }
    case 'task_create': { const t = c.createTask({ title: a.title, detail: a.detail, files: a.files, priority: a.priority || 'normal', createdBy: agent }); return out(t, `Added task ${t.id}: ${t.title}`); }
    case 'task_claim': { const own = c.tasks.find((t) => t.id === a.taskId && t.owner === agent && t.status === 'working'); if (own) return out({ ok: true, task: own }, `You already own ${a.taskId}. Do not claim it again: start the work now (read_file the files it needs).`); const r = c.claimTask({ agent, taskId: a.taskId }); return out(r, r.ok ? `You now own ${a.taskId}: ${r.task.title}` : r.message); }
    case 'task_update': { const r = c.updateTask({ agent, taskId: a.taskId, status: a.status, note: a.note }); return out(r, r.ok ? `Updated ${a.taskId}${a.status ? ' → ' + a.status : ''}.` : r.message); }
    case 'memory_search': { const r = c.recall({ query: a.query, kind: a.kind }); return out(r, r.map((m) => `(${m.kind}, by ${c._name(m.agent)}) ${m.title}${m.body ? '\n   ' + m.body.slice(0, 500).replace(/\n/g, '\n   ') : ''}`).join('\n') || 'Nothing in memory about that yet.'); }
    case 'memory_write': { const m = c.remember({ agent, kind: a.kind, title: a.title, body: a.body, tags: a.tags, files: a.files }); return out(m, `Saved to shared memory (${m.kind}): ${m.title}`); }
    default: throw new Error(`Unknown tool ${name}`);
  }
}

const openAITools = (extra = []) => [...TOOLS, ...extra].map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

module.exports = { TOOLS, runTool, openAITools, numbered, delta };
