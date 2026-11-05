// Swarm Build: one brief in, a real working product out.
// A planner model designs the product and lays down a skeleton (with section markers so many agents can fill the
// SAME files at once), the built-in team (and any outside MCP agent) builds it through Concord's merges, leases,
// memory and board, then Concord checks the result for real: broken links, missing files, and runtime errors from
// actually loading the page. Problems become fix tasks for the swarm, up to a few rounds, until the product runs.
const fs = require('fs');
const path = require('path');
const { chat } = require('./llm');

const PLAN_SYSTEM = `You are the lead architect of a swarm of AI coding agents that build a complete, working product AT THE SAME TIME in one folder.
The product must run by opening its entry HTML file in a browser: plain HTML, CSS and JavaScript, no build step, no npm, no frameworks from a CDN unless essential. It must look polished and modern and actually work (real interactivity, real logic, saved state in localStorage when useful).

Design it so several agents can work in parallel, even inside the same file:
- Give every file a SKELETON: a short starting version that already links everything together, with clearly marked empty sections, e.g. in HTML "<!-- section:hero -->\\n<section id=\\"hero\\"></section>\\n<!-- /section:hero -->", in CSS "/* section:hero */\\n/* /section:hero */", in JS "// section:board\\n// /section:board". Skeletons stay under 60 lines each.
- Then write tasks: one per section or feature, each naming the files and the exact section markers it fills. Several tasks may share a file (that is fine, Concord merges them), but never the same section.
- Add a first task that sets shared design tokens (CSS variables for colors, fonts, spacing) and a last-but-parallel task that wires interactions together if needed.
- 4 to 9 tasks. Each task detail says precisely what done looks like.

Reply with JSON only:
{"name":"short product name","entry":"index.html","summary":"one line","files":[{"path":"index.html","purpose":"...","skeleton":"..."}],"tasks":[{"title":"...","detail":"...","files":["index.html","styles.css"],"priority":"high|normal|low"}],"conventions":["short rules every agent must follow"]}`;

const FALLBACK = (name) => ({
  name, entry: 'index.html', summary: name,
  files: [
    { path: 'index.html', purpose: 'page', skeleton: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${name}</title>\n<link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n<!-- section:header -->\n<header id="header"></header>\n<!-- /section:header -->\n<!-- section:main -->\n<main id="main"></main>\n<!-- /section:main -->\n<!-- section:footer -->\n<footer id="footer"></footer>\n<!-- /section:footer -->\n<script src="app.js"></script>\n</body>\n</html>\n` },
    { path: 'styles.css', purpose: 'styles', skeleton: `/* section:tokens */\n:root {}\n/* /section:tokens */\n/* section:layout */\n/* /section:layout */\n/* section:components */\n/* /section:components */\n` },
    { path: 'app.js', purpose: 'behaviour', skeleton: `// section:state\n// /section:state\n// section:ui\n// /section:ui\n` },
  ],
  tasks: [],
  conventions: [],
});

function slug(s) { return String(s || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'product'; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Swarm {
  constructor({ coordinator, team, probe, log }) {
    this.c = coordinator;
    this.team = team;
    this.probe = probe || null;      // async (url) => [{ kind, message, source, line }]  (desktop: a hidden browser window)
    this.log = log || (() => {});
    this.state = { phase: 'idle' };
    this._watch = null;
    this.maxRounds = 3;
  }

  status() {
    const s = this.state;
    const tasks = (s.taskIds || []).map((id) => this.c.tasks.find((t) => t.id === id)).filter(Boolean);
    return { ...s, tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner, files: t.files })) };
  }

  _set(patch, text) {
    Object.assign(this.state, patch, { updated: Date.now() });
    this.c._event('swarm', { agent: this.state.planner || 'concord', phase: this.state.phase, text: text || `swarm: ${this.state.phase}`, entry: this.state.entry, name: this.state.name, round: this.state.round || 0, transient: false });
  }

  _planner() {
    const agents = this.team.getAgents().filter((a) => a.enabled);
    if (!agents.length) throw new Error('Add at least one agent with a model connection first (Agents tab).');
    const r = this.team.getRouting() || {};
    return agents.find((a) => a.profileId === r.planning) || agents[0];
  }

  async start(brief, { builders } = {}) {
    brief = String(brief || '').trim();
    if (!brief) throw new Error('Describe what the swarm should build.');
    if (['planning', 'scaffold', 'building', 'checking'].includes(this.state.phase)) throw new Error('A swarm build is already running.');
    const planner = this._planner();
    this.state = { phase: 'planning', brief, planner: planner.id, started: Date.now(), round: 0, taskIds: [], issues: [], builders: builders || null };
    this._set({}, `swarm: planning “${brief.slice(0, 80)}”`);
    this.team._say(planner.id, 'start', `Designing the product for “${brief.slice(0, 100)}”`);
    try {
      const design = await this._design(brief, planner);
      await this._scaffold(design, planner);
      this._makeTasks(design, planner);
      this._set({ phase: 'building' }, `swarm: ${this.state.taskIds.length} agents' tasks on the board, building`);
      if (!this.team.active) { try { this.c.checkpoint && this.c.checkpoint('Before the swarm build', { agent: 'user', kind: 'start' }); } catch { } this.team.start(); this.state.startedTeam = true; }
      else this.team.refresh();
      this._loop();
      return this.status();
    } catch (e) {
      this._set({ phase: 'error', error: e.message }, `swarm: stopped, ${e.message}`);
      throw e;
    }
  }

  async _design(brief, planner) {
    const profile = this.team.profileFor(planner, { kind: 'plan', title: brief });
    const existing = this.c.listFiles({}).filter((f) => !f.path.startsWith('.concord')).slice(0, 80).map((f) => f.path);
    const r = await chat({ profile, messages: [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Build this: ${brief}\n\nFiles already in the folder:\n${existing.join('\n') || '(empty folder)'}\n\nTeam size: ${this.team.getAgents().filter((a) => a.enabled).length} agents.` },
    ] });
    this.c.recordUsage && this.c.recordUsage(planner.id, r.usage, profile.model);
    let j = null;
    try { j = JSON.parse((/\{[\s\S]*\}/.exec(r.text || '') || ['{}'])[0]); } catch { }
    const name = (j && j.name) || brief.split(/\s+/).slice(0, 3).join(' ');
    const d = j && Array.isArray(j.tasks) && j.tasks.length ? j : { ...FALLBACK(name), tasks: [] };
    d.name = String(d.name || name).slice(0, 60);
    d.entry = String(d.entry || 'index.html').replace(/^\/+/, '');
    d.files = (d.files || []).filter((f) => f && f.path && !/\.\.|^\//.test(f.path)).slice(0, 12);
    if (!d.files.some((f) => f.path === d.entry)) d.files.unshift(FALLBACK(d.name).files[0]);
    if (!d.tasks.length) d.tasks = [
      { title: 'Design tokens, layout, header and footer', detail: `Visual identity for: ${brief}. Fill the tokens and layout sections of styles.css and the header and footer sections of index.html.`, files: ['styles.css', 'index.html'], priority: 'high' },
      { title: 'Main content and its styles', detail: `Build the main section of index.html and the components section of styles.css for: ${brief}.`, files: ['index.html', 'styles.css'] },
      { title: 'State and behaviour', detail: `Write the state and ui sections of app.js so the product actually works: ${brief}. Save state in localStorage.`, files: ['app.js'] },
    ];
    this.state.name = d.name; this.state.entry = d.entry; this.state.summary = d.summary || '';
    this.team._say(planner.id, 'think', `Plan: ${d.name}. ${d.files.length} files, ${d.tasks.length} parallel tasks.`);
    return d;
  }

  async _scaffold(d, planner) {
    this._set({ phase: 'scaffold' }, `swarm: laying down the skeleton of ${d.name}`);
    this.c.remember({ agent: planner.id, kind: 'decision', title: `Product: ${d.name}`, body: `${this.state.brief}\nEntry: ${d.entry}. ${d.summary || ''}\nFiles: ${d.files.map((f) => `${f.path} (${f.purpose || ''})`).join('; ')}` });
    for (const cv of (d.conventions || []).slice(0, 8)) this.c.remember({ agent: planner.id, kind: 'convention', title: String(cv).slice(0, 200) });
    this.c.remember({ agent: planner.id, kind: 'convention', title: 'Fill only your own section markers', body: 'Files are shared. Edit inside the section markers your task names, keep the markers, and never rewrite a whole shared file.' });
    for (const f of d.files) {
      const cur = this.c.readFile(f.path);
      if (cur.exists && cur.text.trim()) continue;
      const content = String(f.skeleton || '').trim() ? String(f.skeleton).replace(/\r\n/g, '\n') + (String(f.skeleton).endsWith('\n') ? '' : '\n') : `\n`;
      this.c.submit({ agent: planner.id, path: f.path, baseRev: cur.exists ? cur.rev : 0, content, message: `skeleton for ${f.path}` });
      await sleep(250);
    }
  }

  _makeTasks(d, planner) {
    const root = this.c.createTask({ title: `Swarm build: ${d.name}`, kind: 'goal', detail: this.state.brief, createdBy: planner.id });
    this.state.rootTask = root.id;
    for (const t of d.tasks.slice(0, 12)) {
      const task = this.c.createTask({ title: String(t.title).slice(0, 200), detail: `${t.detail || ''}\n\nProduct: ${d.name}. ${this.state.brief}\nEntry file: ${d.entry}. Work inside your section markers; other agents are editing the other sections of the same files right now.`, files: t.files || [], priority: t.priority || 'normal', parent: root.id, createdBy: planner.id });
      this.state.taskIds.push(task.id);
    }
  }

  _loop() {
    clearInterval(this._watch);
    this._watch = setInterval(() => this._tick().catch((e) => this.log('swarm tick: ' + e.message)), 1500);
  }

  async _tick() {
    if (this.state.phase !== 'building' || this._busy) return;
    const tasks = this.state.taskIds.map((id) => this.c.tasks.find((t) => t.id === id)).filter(Boolean);
    if (tasks.some((t) => t.status === 'todo' || t.status === 'working')) return;
    this._busy = true;
    try { await this.check(); } finally { this._busy = false; }
  }

  // Real checks of the built product. Returns the issues found.
  async check() {
    this._set({ phase: 'checking' }, `swarm: checking ${this.state.name || 'the product'} (round ${this.state.round + 1})`);
    const issues = [...this.staticIssues()];
    if (this.probe && this.state.entry) {
      try { for (const e of await this.probe(this.state.entry)) issues.push({ file: e.source ? e.source.replace(/^.*\/preview\//, '').split('?')[0] : this.state.entry, message: `${e.kind === 'console' ? 'Console error' : e.kind === 'load' ? 'Failed to load' : 'Runtime error'}: ${e.message}${e.line ? ' (line ' + e.line + ')' : ''}` }); }
      catch (e) { this.log('probe: ' + e.message); }
    }
    const seen = new Set(); const uniq = issues.filter((i) => { const k = i.file + i.message; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
    this.state.issues = uniq;
    if (!uniq.length || this.state.round + 1 >= this.maxRounds) {
      clearInterval(this._watch);
      const ok = !uniq.length;
      this.state.finished = Date.now();
      this._set({ phase: 'live', ok }, ok ? `swarm: ${this.state.name} is built and runs clean` : `swarm: ${this.state.name} is built, ${uniq.length} issue${uniq.length > 1 ? 's' : ''} left after ${this.maxRounds} rounds`);
      if (this.state.startedTeam && this.team.active) this.team.stop();
      try { this.c.checkpoint && this.c.checkpoint(`Swarm built ${this.state.name}`, { agent: 'concord' }); } catch { }
      return uniq;
    }
    this.state.round++;
    // Group issues by file so one agent fixes one file's problems.
    const byFile = new Map(); for (const i of uniq) { const a = byFile.get(i.file) || []; a.push(i.message); byFile.set(i.file, a); }
    for (const [file, msgs] of byFile) {
      const t = this.c.createTask({ title: `Fix ${msgs.length} problem${msgs.length > 1 ? 's' : ''} in ${file}`, detail: `Concord loaded the product and found:\n- ${msgs.join('\n- ')}\n\nFix the cause (create a missing file if needed). Keep other agents' work intact.`, files: [file], priority: 'high', parent: this.state.rootTask, createdBy: 'concord' });
      this.state.taskIds.push(t.id);
    }
    this._set({ phase: 'building' }, `swarm: ${uniq.length} problem${uniq.length > 1 ? 's' : ''} found, sent back to the swarm`);
    return uniq;
  }

  // Missing local files referenced from HTML/CSS, empty sections, and JS that does not parse.
  staticIssues() {
    const out = [];
    const files = this.c.listFiles({}).map((f) => f.path).filter((p) => !p.startsWith('.concord'));
    const has = new Set(files);
    for (const p of files) {
      const ext = path.extname(p).toLowerCase();
      if (!['.html', '.htm', '.css', '.js', '.mjs'].includes(ext)) continue;
      const f = this.c.readFile(p); if (!f.exists) continue;
      const text = f.text;
      const refs = [];
      if (ext === '.html' || ext === '.htm') { for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)/gi)) refs.push(m[1]); }
      if (ext === '.css') { for (const m of text.matchAll(/url\(\s*["']?([^"')#?]+)/gi)) refs.push(m[1]); }
      if (ext === '.js' || ext === '.mjs') { for (const m of text.matchAll(/\bimport\s[^'"]*["'](\.[^"']+)["']/g)) refs.push(m[1]); }
      for (const r of refs) {
        if (/^(https?:|data:|mailto:|tel:|javascript:|\/\/)/i.test(r) || !r.trim()) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(p), r.replace(/^\//, '')));
        if (!has.has(target)) out.push({ file: p, message: `references ${r}, which does not exist` });
      }
      if (ext === '.js') { try { new Function(text.replace(/^\s*(import|export)\b.*$/gm, '')); } catch (e) { out.push({ file: p, message: `JavaScript does not parse: ${e.message}` }); } }
      for (const m of text.matchAll(/(?:<!--|\/\*|\/\/)\s*section:([\w-]+)\s*(?:-->|\*\/)?\s*\n([\s\S]*?)(?:<!--|\/\*|\/\/)\s*\/section:\1/g)) {
        const inner = m[2].replace(/<(\w+)[^>]*>\s*<\/\1>/g, '').replace(/:root\s*\{\s*\}/g, '').trim();
        if (!inner) out.push({ file: p, message: `section “${m[1]}” is still empty` });
      }
    }
    return out;
  }

  stop() {
    clearInterval(this._watch);
    if (this.state.startedTeam && this.team.active) this.team.stop();
    if (this.state.phase && this.state.phase !== 'idle' && this.state.phase !== 'live') this._set({ phase: 'stopped' }, 'swarm: stopped');
    return this.status();
  }
}

module.exports = { Swarm, slug, PLAN_SYSTEM };
