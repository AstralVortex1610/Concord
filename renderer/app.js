// Concord dashboard. Runs inside the desktop app (window.desktop present) or in any browser at http://127.0.0.1:<port>/.
(() => {
  const D = window.desktop || null;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (p, body) => { const r = await fetch('/api' + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); return r.json(); };
  const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); if (s < 5) return 'just now'; if (s < 60) return Math.floor(s) + 's ago'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return Math.floor(s / 86400) + 'd ago'; };
  const initials = (n) => String(n || '?').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const toast = (msg, c) => { const t = document.createElement('div'); t.className = 'toast'; if (c) t.style.setProperty('--c', c); t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4200); };

  const S = { snap: null, view: 'score', file: null, fileData: null, memKind: '', memQ: '', settings: null, presets: [], info: {}, running: false, notes: [], thoughts: {}, clientTab: 'claude', port: location.port || 4317 };
  if (!D) document.body.classList.add('browser');

  // ---------- theme ----------
  const theme = localStorage.getItem('concord-theme') || 'dark';
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; localStorage.setItem('concord-theme', t); };

  // ---------- window controls ----------
  $$('#winctl button').forEach((b) => (b.onclick = () => D && D.win(b.dataset.win)));

  // ---------- navigation ----------
  function show(view) {
    if (!S.snap && !['agents', 'connect'].includes(view)) view = 'welcome';
    if (view === 'safety' && !S.snap) view = 'welcome';
    S.view = view;
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + view));
    $$('.rail button[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    render(true);
  }
  $$('.rail button[data-view]').forEach((b) => (b.onclick = () => show(b.dataset.view)));

  // ---------- data ----------
  const agentOf = (id) => (S.snap && S.snap.agents.find((a) => a.id === id)) || { id, name: id === 'user' ? 'You' : id === 'disk' ? 'Disk' : id, color: id === 'user' ? '#efe9dc' : '#8f8ba3' };
  const colorOf = (id) => agentOf(id).color || '#8f8ba3';

  async function loadSnap() {
    try {
      const r = await fetch('/api/snapshot');
      if (!r.ok) { S.snap = null; return; }
      const prev = S.snap;
      S.snap = await r.json();
      if (!prev) seedNotes();
      bumpStats(prev);
    } catch { S.snap = null; }
  }
  let snapT = null;
  let memDirty = false;
  const reload = () => { clearTimeout(snapT); snapT = setTimeout(async () => { await loadSnap(); render(false); }, 120); };

  function seedNotes() {
    const cut = Date.now() - WINDOW;
    S.notes = (S.snap.events || []).filter((e) => e.at > cut && e.agent).map(noteFromEvent).filter(Boolean);
  }
  const WINDOW = 60000; // one minute of history across the lane
  function noteFromEvent(e) {
    const kind = e.type === 'commit' ? (e.rebased ? 'merge' : 'commit') : e.type === 'lease' ? 'lease' : e.type === 'release' ? 'release' : e.type === 'reject' ? 'reject' : e.type === 'task' ? 'task' : e.type === 'memory' ? 'memory' : null;
    if (!kind) return null;
    return { id: e.id, agent: e.agent, kind, at: e.at, big: (e.add || 0) + (e.del || 0) > 8, text: e.text, y: 18 + ((hash(e.id) % 4) * 18) };
  }
  const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };

  // ---------- live events ----------
  function connectEvents() {
    const es = new EventSource('/api/events');
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === 'hello' || e.type === 'project') { reload(); return; }
      if (e.type === 'agent-log') {
        if (e.kind === 'think' || e.kind === 'start' || e.kind === 'done' || e.kind === 'error') S.thoughts[e.agent] = { text: e.text, at: e.at, kind: e.kind };
        if (e.kind === 'error') toast(`${agentOf(e.agent).name}: ${e.text}`, '#ff5b6e');
        if (S.view === 'score') updateThought(e.agent);
        return;
      }
      if (e.type === 'usage') {
        if (S.snap) {
          const st = S.snap.stats; st.tokensIn = (st.tokensIn || 0) + e.input; st.tokensCached = (st.tokensCached || 0) + e.cached; st.tokensOut = (st.tokensOut || 0) + e.output;
          const a = S.snap.agents.find((x) => x.id === e.agent); if (a) { a.tokens = a.tokens || { input: 0, cached: 0, output: 0 }; a.tokens.input += e.input; a.tokens.cached += e.cached; a.tokens.output += e.output; }
          if (S.view === 'score') { renderStats(); renderLanes(true); }
        }
        return;
      }
      if (e.type === 'agent-status') { if (S.snap) { const a = S.snap.agents.find((x) => x.id === e.agent); if (a) { a.status = e.status; a.online = true; } } if (S.view === 'score') renderLanes(true); return; }
      const n = noteFromEvent(e); if (n) { n.born = true; S.notes.push(n); }
      if (S.snap) { S.snap.events.push(e); if (S.snap.events.length > 300) S.snap.events.splice(0, 100); }
      if (e.type === 'commit' && S.file && e.path === S.file) loadFile(S.file, e.agent);
      if (e.type === 'commit') flashTree(e.path);
      if (e.type === 'memory') memDirty = true;
      if (S.view === 'score') prependFeed(e);
      reload();
    };
    es.onerror = () => { setLive(false); };
    es.onopen = () => setLive(true);
  }
  function setLive(on) { const c = $('#liveChip'); c.classList.toggle('on', on && S.running); c.querySelector('span').textContent = on ? (S.running ? 'Team live' : 'Connected') : 'Reconnecting…'; }

  // ---------- render ----------
  function render(full) {
    const has = !!S.snap;
    $('#projectName').textContent = has ? S.snap.name : 'No project';
    $('#projectPill').classList.toggle('on', has);
    $('#projectPill').title = has ? S.snap.root : 'Open a project';
    const open = has ? S.snap.tasks.filter((t) => t.status !== 'done' && t.kind !== 'plan').length : 0;
    $('#taskBadge').textContent = open || '';
    if (S.view === 'welcome') renderWelcome();
    if (S.view === 'score') { renderStats(); renderLanes(); if (full) renderFeed(); }
    if (S.view === 'board') renderBoard();
    if (S.view === 'files') { if (full) renderFiles(); else refreshTree(); }
    if (S.view === 'memory' && (full || memDirty)) { memDirty = false; renderMemory(); }
    if (S.view === 'agents') renderAgents();
    if (S.view === 'connect') renderConnect();
    if (S.view === 'safety' && full) renderSafety();
  }

  function renderWelcome() {
    $('#browserNote').classList.toggle('hide', !!D);
    $('#openBtn').classList.toggle('hide', !D);
    const rec = (S.settings && S.settings.recent) || [];
    $('#recentList').innerHTML = rec.length ? `<div class="lbl">Recent projects</div>` + rec.map((r) => `<button data-dir="${esc(r)}"><svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z" /></svg><div><b>${esc(r.split(/[\\/]/).pop())}</b><small>${esc(r)}</small></div></button>`).join('') : '';
    $$('#recentList button').forEach((b) => (b.onclick = () => openDir(b.dataset.dir)));
  }

  // Stats
  const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n || 0));
  let lastStats = {};
  function statVals() {
    const s = S.snap; if (!s) return {};
    return {
      online: s.agents.filter((a) => a.online && a.id !== 'user').length,
      total: s.agents.filter((a) => a.id !== 'user').length,
      commits: s.stats.commits || 0,
      merged: s.stats.rebased || 0,
      saved: (s.stats.conflicts || 0) + (s.stats.blocked || 0),
      open: s.tasks.filter((t) => t.status !== 'done' && t.kind !== 'plan').length,
      tokens: (s.stats.tokensIn || 0) + (s.stats.tokensOut || 0),
      cachedPct: s.stats.tokensIn ? Math.round((100 * (s.stats.tokensCached || 0)) / s.stats.tokensIn) : 0,
      done: s.tasks.filter((t) => t.status === 'done' && t.kind !== 'plan').length,
    };
  }
  function bumpStats() { const v = statVals(); S._bump = Object.keys(v).filter((k) => lastStats[k] !== undefined && v[k] > lastStats[k]); lastStats = v; }
  function renderStats() {
    const v = statVals();
    const tile = (key, k, val, small, c) => `<div class="stat card ${S._bump && S._bump.includes(key) ? 'bump' : ''}" style="--c:${c}"><div class="k">${k}</div><div class="v">${val}${small ? `<small>${small}</small>` : ''}</div></div>`;
    $('#stats').innerHTML = tile('online', 'Agents live', v.online, `/ ${v.total}`, 'var(--mint)') + tile('commits', 'Edits landed', v.commits, '', 'var(--coral)') + tile('merged', 'Auto-merged', v.merged, 'same file', 'var(--gold)') + tile('saved', 'Overwrites stopped', v.saved, '', 'var(--red)') + tile('open', 'Open tasks', v.open, `${v.done} done`, 'var(--violet)') + tile('tokens', 'Tokens used', fmtTok(v.tokens), v.tokens ? `${v.cachedPct}% cached` : 'token saver on', 'var(--sky)');
    S._bump = [];
  }

  // Lanes
  function renderLanes(statusOnly) {
    const s = S.snap; if (!s) return;
    const agents = s.agents.filter((a) => a.id !== 'user' && a.id !== 'disk').sort((a, b) => (b.online - a.online) || (a.kind === 'builtin' ? -1 : 1));
    const box = $('#lanes');
    if (!agents.length) { box.innerHTML = `<div class="empty-lanes"><h3>No agents yet</h3>Add built-in agents in <b>Agents</b>, or connect Claude Code, Cursor and friends from <b>Connect</b>. They'll appear here as lanes.</div>`; return; }
    const sig = agents.map((a) => a.id).join('|');
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.innerHTML = agents.map((a) => `<div class="lane" data-agent="${esc(a.id)}" style="--c:${a.color}"><div class="who"></div><div class="track"><div class="thought"></div><div class="scopes"></div></div></div>`).join('');
    }
    for (const a of agents) {
      const lane = box.querySelector(`.lane[data-agent="${CSS.escape(a.id)}"]`);
      if (!lane) continue;
      const task = s.tasks.find((t) => t.owner === a.id && ['working', 'claimed'].includes(t.status));
      const st = a.online ? (a.status || 'idle') : 'offline';
      lane.querySelector('.who').innerHTML = `<div class="orb ${st}">${esc(initials(a.name))}</div><div class="nm"><span>${esc(a.name)}</span>${a.kind === 'external' ? '<span class="tag ext">MCP</span>' : '<span class="tag">built-in</span>'}</div><div class="model">${esc(a.model || 'no model yet')}${a.tokens ? ` · ${fmtTok(a.tokens.input + a.tokens.output)} tok` : ''}</div><div class="st"><b>${esc(st)}</b><span>${task ? '· ' + esc(task.title) : ''}</span></div>`;
      if (!statusOnly) {
        const mine = s.leases.filter((l) => l.agent === a.id);
        lane.querySelector('.scopes').innerHTML = mine.map((l) => `<span class="scope">${esc(l.path.split('/').pop())} · ${esc(l.symbol || (l.kind === 'file' ? 'whole file' : `L${l.startLine}-${l.endLine}`))}</span>`).join('');
      }
      updateThought(a.id);
    }
  }
  function updateThought(agent) {
    const lane = document.querySelector(`.lane[data-agent="${CSS.escape(agent)}"] .thought`);
    if (!lane) return;
    const t = S.thoughts[agent];
    lane.textContent = t && Date.now() - t.at < 60000 ? '“' + t.text.replace(/\s+/g, ' ').slice(0, 160) + '”' : '';
  }

  // Animate notes sliding along each lane.
  function tick() {
    if (S.view === 'score' && S.snap) {
      const now = Date.now();
      S.notes = S.notes.filter((n) => now - n.at < WINDOW + 2000);
      const tracks = {};
      $$('.lane').forEach((l) => (tracks[l.dataset.agent] = l.querySelector('.track')));
      const seen = new Set();
      for (const n of S.notes) {
        const tr = tracks[n.agent]; if (!tr) continue;
        let el = n.el;
        if (!el || el.parentNode !== tr) {
          el = document.createElement('i');
          el.className = `note ${n.kind}${n.big ? ' big' : ''}${n.born ? ' born' : ''}`;
          el.title = `${agentOf(n.agent).name}: ${n.text || n.kind}`;
          tr.appendChild(el); n.el = el;
        }
        seen.add(el);
        const w = tr.clientWidth;
        const x = w - 26 - ((now - n.at) / WINDOW) * (w - 40);
        el.style.transform = `translate(${x}px, ${n.y + 8}px)`;
        el.style.opacity = x < 30 ? Math.max(0, x / 30) : 1;
      }
      $$('.track .note').forEach((el) => { if (!seen.has(el)) el.remove(); });
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // Feed
  const EV_ICON = {
    commit: '<path d="M5 12l4 4 10-10" />', lease: '<rect x="6" y="10" width="12" height="9" rx="2" /><path d="M9 10V7a3 3 0 016 0v3" />', release: '<rect x="6" y="10" width="12" height="9" rx="2" /><path d="M9 10V7a3 3 0 015.8-1" />',
    reject: '<path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" />', task: '<rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 12l3 3 5-6" />', memory: '<path d="M12 3c4.5 0 8 2 8 4.5S16.5 12 12 12 4 10 4 7.5 7.5 3 12 3zM4 7.5V12c0 2.5 3.5 4.5 8 4.5s8-2 8-4.5V7.5" />', agent: '<circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" />', command: '<path d="M4 6l6 6-6 6M12 18h8" />', checkpoint: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" />',
  };
  const evHTML = (e) => {
    const a = agentOf(e.agent);
    let body = esc(e.text || e.type);
    if (e.type === 'commit') body = `${e.rebased ? 'merged an edit into' : 'edited'} <code>${esc(e.path)}</code> <span class="plus">+${e.add || 0}</span> <span class="minus">−${e.del || 0}</span>${e.text && !/^edited /.test(e.text) ? ' · ' + esc(e.text) : ''}`;
    if (e.type === 'command') body = `<span style="color:${e.ok ? 'var(--mint)' : 'var(--red)'}">${esc(e.text)}</span>`;
    if (e.type === 'checkpoint') { body = esc(e.text); if (S.view === 'safety') renderSafety(); }
    if (e.type === 'reject') body = `was stopped from overwriting <code>${esc(e.path || '')}</code>: ${esc(e.text)}`;
    return `<div class="ev ${e.type}" style="--c:${a.color}"><div class="ic"><svg viewBox="0 0 24 24">${EV_ICON[e.type] || EV_ICON.agent}</svg></div><div><b>${esc(a.name)}</b> ${body}<div class="t" data-at="${e.at}">${ago(e.at)}</div></div></div>`;
  };
  function renderFeed() {
    const evs = (S.snap.events || []).filter((e) => !e.transient).slice(-80).reverse();
    $('#feed').innerHTML = evs.map(evHTML).join('') || '<div class="empty" style="margin:10px">Nothing yet. Start the team or connect an agent.</div>';
    $('#feedCount').textContent = `${S.snap.events.length} events`;
  }
  function prependFeed(e) { if (e.transient) return; const f = $('#feed'); const em = f.querySelector('.empty'); if (em) em.remove(); f.insertAdjacentHTML('afterbegin', evHTML(e)); while (f.children.length > 80) f.lastChild.remove(); }
  setInterval(() => $$('[data-at]').forEach((x) => (x.textContent = ago(+x.dataset.at))), 5000);

  // ---------- Board ----------
  const COLS = [['todo', 'To do', 'var(--sky)'], ['working', 'Working', 'var(--coral)'], ['review', 'Review', 'var(--gold)'], ['done', 'Done', 'var(--mint)']];
  function taskCard(t) {
    const o = t.owner ? agentOf(t.owner) : null;
    const held = S.snap.leases.filter((l) => l.agent === t.owner && (l.taskId === t.id || t.status === 'working'));
    const fresh = !seenCards.has(t.id + t.status); seenCards.add(t.id + t.status);
    return `<div class="tcard ${t.status}${fresh ? ' new' : ''}" draggable="true" data-id="${esc(t.id)}" style="--c:${o ? o.color : 'var(--coral)'}"><div class="tt">${esc(t.title)}</div>${t.detail ? `<div class="td">${esc(t.detail)}</div>` : ''}<div class="meta"><i class="prio ${t.priority}" title="${t.priority} priority"></i>${o ? `<span class="owner" style="--c:${o.color}"><i>${esc(initials(o.name))}</i>${esc(o.name)}</span>` : ''}${held.slice(0, 3).map((l) => `<span class="fchip">${esc(l.path.split('/').pop())}${l.symbol ? '·' + esc(l.symbol) : ''}</span>`).join('')}${!held.length ? (t.files || []).slice(0, 2).map((f) => `<span class="fchip">${esc(String(f).split('/').pop())}</span>`).join('') : ''}</div></div>`;
  }
  const seenCards = new Set();
  function renderBoard() {
    const s = S.snap; if (!s) return;
    const tasks = s.tasks.filter((t) => t.kind !== 'plan');
    const sig = JSON.stringify([tasks.map((t) => [t.id, t.status, t.owner, t.title, t.updated]), s.leases.map((l) => l.id), s.agents.map((a) => a.color)]);
    if ($('#kanban').dataset.sig === sig) return;
    $('#kanban').dataset.sig = sig;
    const blocked = tasks.filter((t) => t.status === 'blocked');
    $('#kanban').innerHTML = COLS.map(([k, label, c]) => {
      const list = tasks.filter((t) => t.status === k || (k === 'working' && t.status === 'claimed')).sort((a, b) => b.updated - a.updated);
      return `<div class="col" data-col="${k}" style="--c:${c}"><div class="col-head"><i></i>${label}<span class="ct">${list.length}</span></div>${list.map(taskCard).join('') || '<div class="empty small">' + (k === 'todo' ? 'Add a task or plan a goal' : 'Nothing here') + '</div>'}</div>`;
    }).join('') + (blocked.length ? `<div class="col blocked-strip" data-col="blocked" style="--c:var(--red);grid-column:1/-1;min-height:0"><div class="col-head"><i></i>Blocked<span class="ct">${blocked.length}</span></div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:9px">${blocked.map(taskCard).join('')}</div></div>` : '');
    $$('.tcard').forEach((c) => {
      c.onclick = () => openTask(c.dataset.id);
      c.ondragstart = (e) => { e.dataTransfer.setData('text', c.dataset.id); c.classList.add('dragging'); };
      c.ondragend = () => c.classList.remove('dragging');
    });
    $$('.col').forEach((col) => {
      col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
      col.ondragleave = () => col.classList.remove('over');
      col.ondrop = async (e) => { e.preventDefault(); col.classList.remove('over'); await api('/task/update', { taskId: e.dataTransfer.getData('text'), status: col.dataset.col, agent: 'user' }); reload(); };
    });
  }
  $('#addTask').onsubmit = async (e) => { e.preventDefault(); const v = $('#newTask').value.trim(); if (!v || !S.snap) return; await api('/task', { title: v, priority: $('#newPrio').value }); $('#newTask').value = ''; reload(); };
  function openTask(id) {
    const t = S.snap.tasks.find((x) => x.id === id); if (!t) return;
    const o = t.owner ? agentOf(t.owner) : null;
    $('#drawerCard').innerHTML = `<div class="row" style="justify-content:space-between"><span class="tag">${esc(t.id)} · ${esc(t.status)}</span><button class="btn ghost sm" id="dClose">Close</button></div><h2>${esc(t.title)}</h2><p class="muted">${esc(t.detail || 'No details.')}</p>${o ? `<span class="owner" style="--c:${o.color}"><i>${esc(initials(o.name))}</i>${esc(o.name)}</span>` : ''}
      <div class="acts">${['todo', 'working', 'review', 'done', 'blocked'].map((st) => `<button class="btn sm ${st === t.status ? 'primary' : ''}" data-st="${st}">${st}</button>`).join('')}<button class="btn sm danger" id="dDel">Delete</button></div>
      <h3 style="margin-top:18px">Notes</h3><div class="log">${t.notes.map((n) => `<div><small>${esc(agentOf(n.by).name)} · ${ago(n.at)}</small>${esc(n.text)}</div>`).join('') || '<div class="muted">No notes yet.</div>'}</div>
      <form id="dNote" class="row gap" style="margin-top:10px"><input id="dNoteIn" placeholder="Add a note for the agent…" style="flex:1" /><button class="btn sm">Add</button></form>
      <h3 style="margin-top:18px">History</h3><div class="log">${t.history.slice().reverse().map((h) => `<div><small>${esc(agentOf(h.by).name)} · ${ago(h.at)}</small>${esc(h.text)}</div>`).join('')}</div>`;
    $('#drawer').classList.add('on');
    $('#dClose').onclick = () => $('#drawer').classList.remove('on');
    $$('[data-st]', $('#drawerCard')).forEach((b) => (b.onclick = async () => { await api('/task/update', { taskId: id, status: b.dataset.st, agent: 'user' }); await loadSnap(); render(); openTask(id); }));
    $('#dDel').onclick = async () => { await api('/task/delete', { taskId: id }); $('#drawer').classList.remove('on'); reload(); };
    $('#dNote').onsubmit = async (e) => { e.preventDefault(); const v = $('#dNoteIn').value.trim(); if (!v) return; await api('/task/update', { taskId: id, note: v, agent: 'user' }); await loadSnap(); openTask(id); };
  }

  // ---------- Files ----------
  let fileList = [];
  async function renderFiles() {
    if (!S.snap) return;
    fileList = await api('/files');
    drawTree();
    if (S.file) drawCode(); else if (fileList[0]) loadFile(fileList[0].path);
  }
  function drawTree() {
    const q = $('#fileFilter').value.toLowerCase();
    const groups = {};
    for (const f of fileList) { if (q && !f.path.toLowerCase().includes(q)) continue; const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''; (groups[d] = groups[d] || []).push(f); }
    $('#tree').innerHTML = Object.keys(groups).sort().map((d) => (d ? `<div class="fdir">${esc(d)}</div>` : '') + groups[d].map((f) => {
      const ls = S.snap.leases.filter((l) => l.path === f.path);
      return `<button class="fitem ${f.path === S.file ? 'on' : ''}" data-path="${esc(f.path)}"><span>${esc(f.path.split('/').pop())}</span><span class="dots" style="flex:none">${ls.map((l) => `<i style="--c:${l.color}"></i>`).join('')}</span></button>`;
    }).join('')).join('') || '<div class="empty small">No files yet. Agents will create them.</div>';
    $$('.fitem').forEach((b) => (b.onclick = () => loadFile(b.dataset.path)));
  }
  $('#fileFilter').oninput = drawTree;
  let treeT = null;
  function refreshTree() { clearTimeout(treeT); treeT = setTimeout(async () => { fileList = await api('/files'); drawTree(); if (S.fileData) drawCodeHeadOnly(); }, 250); }
  function drawCodeHeadOnly() { /* leases may have moved: refetch current file quietly */ if (S.file) api('/file?path=' + encodeURIComponent(S.file)).then((d) => { const moved = JSON.stringify(d.leases) !== JSON.stringify(S.fileData.leases); if (moved && d.rev === S.fileData.rev) { S.fileData = d; S.fresh = null; drawCode(false); } }); }
  function flashTree(p) { const b = document.querySelector(`.fitem[data-path="${CSS.escape(p)}"]`); if (b) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); } }
  async function loadFile(p, byAgent) {
    const prev = S.fileData && S.file === p ? S.fileData.text : null;
    S.file = p;
    S.fileData = await api('/file?path=' + encodeURIComponent(p));
    S.fresh = null;
    if (prev != null && byAgent) {
      const old = new Set(prev.split('\n'));
      S.fresh = { lines: new Set(S.fileData.text.split('\n').map((l, i) => (!old.has(l) ? i : -1)).filter((i) => i >= 0)), color: colorOf(byAgent) };
    }
    if (S.view === 'files') { drawTree(); drawCode(!!byAgent); }
  }
  function hl(line, ext) {
    let s = esc(line);
    if (!/^(js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|cs|rb|php|swift|kt|mjs|cjs)$/.test(ext)) return s;
    const cm = ext === 'py' || ext === 'rb' ? '#' : '//';
    const ci = line.indexOf(cm);
    let tail = '';
    if (ci >= 0 && !/["'`]/.test(line.slice(0, ci))) { tail = `<span class="tok-c">${esc(line.slice(ci))}</span>`; s = esc(line.slice(0, ci)); }
    s = s.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g, '<span class="tok-s">$1</span>')
      .replace(/\b(const|let|var|function|return|if|else|for|while|class|def|import|from|export|default|async|await|new|try|catch|throw|fn|pub|struct|impl|func|package|public|private|static|void|int|self|this|None|True|False|null|true|false|elif|in|of|lambda|yield|interface|type|enum|use|mod|match)\b(?![^<]*>)/g, '<span class="tok-k">$1</span>')
      .replace(/\b(\d+(?:\.\d+)?)\b(?![^<]*>)/g, '<span class="tok-n">$1</span>')
      .replace(/\b([A-Za-z_]\w*)(?=\()(?![^<]*>)/g, '<span class="tok-f">$1</span>');
    return s + tail;
  }
  function drawCode(tickRev) {
    const f = S.fileData; if (!f) return;
    const ext = (f.path.split('.').pop() || '').toLowerCase();
    $('#codeHead').innerHTML = `<span class="path">${esc(f.path)}</span><span class="rev ${tickRev ? 'tick' : ''}">rev ${f.rev}</span><span class="grow"></span>${f.leases.map((l) => `<span class="owner" style="--c:${l.color}"><i>${esc(initials(l.name))}</i>${esc(l.label)}</span>`).join('')}`;
    if (!f.exists) { $('#codeBody').innerHTML = '<div class="empty" style="margin:20px">This file was deleted.</div>'; return; }
    const lines = f.text.split('\n');
    const own = new Array(lines.length).fill(null);
    const starts = {};
    for (const l of f.leases) { const s = l.kind === 'file' ? 0 : l.startLine - 1, e = l.kind === 'file' ? lines.length : l.endLine; for (let i = s; i < e && i < lines.length; i++) own[i] = l; starts[s] = l; }
    const body = $('#codeBody'); const top = body.scrollTop;
    body.innerHTML = lines.map((ln, i) => {
      const l = own[i]; const fr = S.fresh && S.fresh.lines.has(i);
      return `<div class="ln ${l ? 'held' : ''} ${fr ? 'fresh' : ''}" style="${l ? `--c:${l.color};` : fr ? `--c:${S.fresh.color};` : ''}"><span class="no">${i + 1}</span><span class="tx">${hl(ln, ext) || ' '}</span>${starts[i] ? `<span class="who-tag">${esc(starts[i].name)} · ${esc(starts[i].symbol || starts[i].label)}</span>` : ''}</div>`;
    }).join('');
    body.scrollTop = top;
    if (S.fresh && S.fresh.lines.size && tickRev) { const first = body.querySelector('.ln.fresh'); if (first && (first.offsetTop < body.scrollTop || first.offsetTop > body.scrollTop + body.clientHeight - 40)) body.scrollTo({ top: first.offsetTop - 120, behavior: 'smooth' }); }
    $('#fileSide').innerHTML = `<h3>Functions</h3>${(f.symbols || []).map((s) => `<div class="sym" data-line="${s.start}" style="--c:${s.heldBy ? colorOf(s.heldBy.agent) : 'transparent'}"><i style="width:7px;height:7px;border-radius:50%;background:var(--c);border:1px solid var(--line2)"></i><span>${esc(s.name)}</span><small>${s.start}-${s.end}</small></div>`).join('') || '<div class="muted small">None found.</div>'}
      <h3 style="margin-top:20px">Revisions</h3>${(f.history || []).map((h) => `<div class="hist" style="--c:${colorOf(h.agent)}"><i></i><div><b>${esc(agentOf(h.agent).name)}</b> · rev ${h.rev}${h.rebased ? ' · <span style="color:var(--gold)">merged</span>' : ''}<div class="m">${esc(h.message || '')} <span class="plus">+${h.add || 0}</span> <span class="minus">−${h.del || 0}</span> · ${ago(h.at)}</div>${h.rev !== f.rev && (f.revs || []).includes(h.rev) ? `<button class="mini" data-restore="${h.rev}">Restore</button>` : h.rev === f.rev ? '<span class="cur">current</span>' : ''}</div></div>`).join('')}`;
    $$('#fileSide [data-restore]').forEach((b) => (b.onclick = async () => { const r = await api('/file/revert', { path: f.path, rev: +b.dataset.restore }); toast(r.ok ? (r.noop ? 'Already at that version' : `Restored revision ${b.dataset.restore} as revision ${r.rev}`) : r.message, r.ok ? '#46d6b0' : '#ff5b6e'); if (r.ok) loadFile(f.path, 'user'); }));
    $$('#fileSide .sym').forEach((s) => (s.onclick = () => { const el = body.children[+s.dataset.line - 1]; if (el) body.scrollTo({ top: el.offsetTop - 60, behavior: 'smooth' }); }));
  }

  // ---------- Memory ----------
  const KCOL = { decision: 'var(--coral)', convention: 'var(--mint)', fact: 'var(--sky)', lesson: 'var(--gold)', todo: 'var(--violet)' };
  const seenMem = new Set();
  async function renderMemory() {
    if (!S.snap) return;
    $('#memKinds').innerHTML = ['', 'decision', 'convention', 'fact', 'lesson', 'todo'].map((k) => `<button class="chip ${S.memKind === k ? 'on' : ''}" data-k="${k}">${k || 'everything'}</button>`).join('');
    $$('#memKinds .chip').forEach((c) => (c.onclick = () => { S.memKind = c.dataset.k; renderMemory(); }));
    const list = await api(`/memory/search?q=${encodeURIComponent(S.memQ)}&kind=${S.memKind}`);
    const sig = JSON.stringify(list.map((m) => m.id + m.score));
    if ($('#memGrid').dataset.sig === sig) return;
    $('#memGrid').dataset.sig = sig;
    $('#memGrid').innerHTML = list.map((m) => { const a = agentOf(m.agent); const fresh = !seenMem.has(m.id); seenMem.add(m.id); return `<div class="mem${fresh ? ' new' : ''}" style="--c:${KCOL[m.kind] || 'var(--mut)'}"><div class="kind">${esc(m.kind)}</div><h4>${esc(m.title)}</h4>${m.body ? `<p>${esc(m.body)}</p>` : ''}<div class="by"><span class="owner" style="--c:${a.color}"><i>${esc(initials(a.name))}</i>${esc(a.name)}</span>${ago(m.at)}${m.score ? `<span class="score">· match ${m.score}</span>` : ''}</div><button class="btn ghost sm del" data-id="${m.id}">Remove</button></div>`; }).join('') || `<div class="empty">${S.memQ ? 'Nothing matches that yet.' : 'Shared memory is empty. Agents save decisions and conventions here as they work.'}</div>`;
    $$('#memGrid .del').forEach((b) => (b.onclick = async () => { await api('/memory/delete', { id: b.dataset.id }); renderMemory(); }));
  }
  let mq = null; $('#memQuery').oninput = (e) => { S.memQ = e.target.value; clearTimeout(mq); mq = setTimeout(renderMemory, 180); };
  $('#memAdd').onsubmit = async (e) => { e.preventDefault(); const title = $('#memTitle').value.trim(); if (!title || !S.snap) return; await api('/memory', { kind: $('#memKind').value, title, body: $('#memBody').value.trim(), agent: 'user' }); $('#memTitle').value = ''; $('#memBody').value = ''; renderMemory(); };

  // ---------- Agents & models ----------
  const PCOL = { global: ['#ff7a59', '#ffc94d'], china: ['#ff5fa2', '#ff7a59'], local: ['#46d6b0', '#4fb3ff'], any: ['#8f7bff', '#c58cff'] };
  const logo = (p, size) => { const c = PCOL[(p && p.region) || 'any'] || PCOL.any; return `<div class="logo" style="background:linear-gradient(135deg,${c[0]},${c[1]})${size ? `;width:${size}px;height:${size}px` : ''}">${esc(initials((p && p.name) || '?'))}</div>`; };
  function renderAgents() {
    if (!D) { $('#profiles').innerHTML = '<div class="empty">Open the Concord desktop app to add models and agents. API keys never leave the app.</div>'; $('#agentList').innerHTML = ''; $('#routing').innerHTML = ''; return; }
    const st = S.settings; if (!st) return;
    const pre = (id) => S.presets.find((p) => p.id === id);
    $('#profiles').innerHTML = st.profiles.map((p) => `<div class="prof">${logo(pre(p.provider))}<div style="min-width:0"><div class="nm">${esc(p.name)}</div><div class="mm">${esc((pre(p.provider) || {}).name || 'Custom')} · ${esc(p.model)} ${p.hasKey ? '· key ' + esc(p.keyHint) : p.provider === 'ollama' || p.provider === 'lmstudio' ? '' : '· <span style="color:var(--red)">no key</span>'}</div></div><div class="acts"><button class="btn sm" data-edit="${p.id}">Edit</button></div></div>`).join('') || '<div class="empty">No models yet. Connect one from any lab: OpenAI, Anthropic, Gemini, DeepSeek, Qwen, Kimi, GLM, local Ollama and more.</div>';
    $$('[data-edit]').forEach((b) => (b.onclick = () => profileModal(st.profiles.find((p) => p.id === b.dataset.edit))));
    const opts = (sel) => `<option value="">— pick a model —</option>` + st.profiles.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} (${esc(p.model)})</option>`).join('');
    $('#agentList').innerHTML = st.agents.map((a) => `<div class="agent-row" data-id="${a.id}"><div class="orb" style="--c:${a.color}">${esc(initials(a.name))}</div><div class="fields"><input class="a-name" value="${esc(a.name)}" placeholder="Name" /><select class="a-prof">${opts(a.profileId)}</select><input class="a-role role" value="${esc(a.role)}" placeholder="Role, e.g. frontend specialist, writes tests, reviewer" /></div><div class="row gap"><label class="switch" title="On the team"><input type="checkbox" class="a-on" ${a.enabled ? 'checked' : ''} /><i></i></label><button class="btn ghost sm a-del" title="Remove">✕</button></div></div>`).join('') || '<div class="empty">No agents yet. Add a few and give each a model. They can all use different labs.</div>';
    $$('.agent-row').forEach((row) => {
      const a = st.agents.find((x) => x.id === row.dataset.id);
      const save = async () => { await D.saveAgent({ ...a, name: row.querySelector('.a-name').value.trim() || a.name, profileId: row.querySelector('.a-prof').value, role: row.querySelector('.a-role').value, enabled: row.querySelector('.a-on').checked }); S.settings = await D.settings(); reload(); };
      row.querySelectorAll('input,select').forEach((el) => (el.onchange = save));
      row.querySelector('.a-del').onclick = async () => { await D.deleteAgent(a.id); S.settings = await D.settings(); renderAgents(); reload(); };
    });
    const r = st.routing || {};
    $('#routeOn').checked = !!r.enabled;
    $('#leanOn').checked = r.lean !== false;
    const cm = (st.commands && st.commands.mode) || 'safe';
    $('#cmdMode').value = cm;
    const CH = { off: 'Agents edit code but never run anything.', safe: 'Agents may run tests, builds, linters and read-only git (npm test, pytest, go test, tsc, eslint…). One command at a time, 2-minute limit.', all: 'Agents may run any command in the project folder, except a blocked list (deleting drives, git push, piping downloads into a shell). Use with care.' };
    $('#cmdHint').textContent = CH[cm];
    $('#cmdMode').onchange = async () => { await D.saveCommands({ mode: $('#cmdMode').value, timeoutSec: (st.commands && st.commands.timeoutSec) || 120 }); S.settings = await D.settings(); renderAgents(); };
    const rows = [['planning', 'Planning', 'Splitting goals into tasks. Use your strongest model.'], ['small', 'Small edits', 'Typos, renames, tweaks. A fast cheap model is plenty.'], ['review', 'Review & tests', 'Checking work. A careful model from another lab catches more.']];
    $('#routing').innerHTML = rows.map(([k, t, d]) => `<div class="route"><b>${t}</b><p>${d}</p><select data-r="${k}"><option value="">Agent's own model</option>${st.profiles.map((p) => `<option value="${p.id}" ${r[k] === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>`).join('');
    const saveR = async () => { const o = { enabled: $('#routeOn').checked, lean: $('#leanOn').checked }; $$('[data-r]').forEach((s) => (o[s.dataset.r] = s.value)); await D.saveRouting(o); S.settings = await D.settings(); };
    $$('[data-r]').forEach((s) => (s.onchange = saveR)); $('#routeOn').onchange = saveR; $('#leanOn').onchange = saveR;
  }
  $('#addAgent').onclick = async () => { if (!D) return; const st = S.settings; await D.saveAgent({ profileId: st.profiles[0] ? st.profiles[0].id : '' }); S.settings = await D.settings(); renderAgents(); reload(); };
  $('#addProfile').onclick = () => profileModal(null);

  function profileModal(existing) {
    let region = existing ? ((S.presets.find((p) => p.id === existing.provider) || {}).region || 'any') : 'global';
    let sel = existing ? S.presets.find((p) => p.id === existing.provider) || S.presets.find((p) => p.id === 'custom') : null;
    const draw = () => {
      const list = S.presets.filter((p) => (region === 'all' ? true : region === 'any' ? p.region === 'any' : p.region === region));
      $('#modalCard').innerHTML = `<div class="row" style="justify-content:space-between"><div><h2>${existing ? 'Edit connection' : 'Connect a model'}</h2><div class="sub">Pick a lab, paste your key, choose a model. Keys are encrypted on this PC.</div></div><button class="btn ghost sm" id="mClose">Close</button></div>
        <div class="prov-tabs">${[['global', 'US & Europe'], ['china', 'China'], ['local', 'On this PC'], ['any', 'Custom'], ['all', 'All']].map(([k, l]) => `<button class="chip ${region === k ? 'on' : ''}" data-reg="${k}">${l}</button>`).join('')}</div>
        <div class="prov-grid">${list.map((p) => `<button class="prov ${sel && sel.id === p.id ? 'on' : ''}" data-p="${p.id}">${logo(p)}<div>${esc(p.name.replace(/ \(.*\)/, ''))}<small>${esc(p.style === 'anthropic' ? 'native Anthropic API' : p.region === 'local' ? 'local, free' : p.region === 'china' ? 'China' : 'OpenAI-compatible')}</small></div></button>`).join('')}</div>
        ${sel ? `<div class="form">
          <label>Name<input id="fName" value="${esc(existing ? existing.name : sel.name.replace(/ \(.*\)/, '') + (sel.models[0] ? ' · ' + sel.models[0] : ''))}" /></label>
          <label>Model<input id="fModel" list="fModels" value="${esc(existing ? existing.model : sel.models[0] || '')}" placeholder="model id" /><datalist id="fModels">${sel.models.map((m) => `<option value="${esc(m)}">`).join('')}</datalist><span class="hint"><a id="fFetch">Load models from the provider</a></span></label>
          <label class="full">Base URL<input id="fBase" value="${esc(existing ? existing.baseUrl : sel.baseUrl)}" placeholder="https://…/v1" />${(sel.altBaseUrls || []).length ? `<span class="hint">Other endpoints: ${sel.altBaseUrls.map((a, i) => `<a data-alt="${i}">${esc(a.label)}</a>`).join(' · ')}</span>` : ''}</label>
          <label class="full">API key<input id="fKey" type="password" placeholder="${existing && existing.hasKey ? 'Saved (' + esc(existing.keyHint) + '). Leave empty to keep it.' : sel.region === 'local' ? 'Not needed for local models' : 'Paste your key'}" /><span class="hint">${sel.keyUrl ? `Get a key: <a data-open="${esc(sel.keyUrl)}">${esc(sel.keyUrl.replace(/^https?:\/\//, '').slice(0, 60))}</a>` : ''} ${sel.notes && sel.notes.length < 140 && !/unverified/i.test(sel.notes) ? '· ' + esc(sel.notes) : /unverified/i.test(sel.notes || '') ? '· Endpoint not confirmed from official docs; check your console.' : ''}</span></label>
          <label>API style<select id="fStyle"><option value="openai" ${((existing && existing.style) || sel.style) === 'openai' ? 'selected' : ''}>OpenAI-compatible</option><option value="anthropic" ${((existing && existing.style) || sel.style) === 'anthropic' ? 'selected' : ''}>Anthropic Messages</option></select></label>
          <label>Max output tokens<input id="fMax" value="${esc(existing ? existing.maxTokens : '')}" placeholder="default" /></label>
        </div>` : '<p class="muted" style="margin-top:16px">Choose a provider above.</p>'}
        <div class="modal-foot">${existing ? '<button class="btn danger sm" id="mDel">Delete</button>' : ''}<span class="test-out" id="tOut"></span>${sel ? '<button class="btn" id="mTest">Test</button><button class="btn primary" id="mSave">Save</button>' : ''}</div>`;
      $('#mClose').onclick = () => $('#modal').classList.remove('on');
      $$('[data-reg]').forEach((b) => (b.onclick = () => { region = b.dataset.reg; draw(); }));
      $$('[data-p]').forEach((b) => (b.onclick = () => { sel = S.presets.find((p) => p.id === b.dataset.p); existing = existing && existing.provider === sel.id ? existing : existing ? { ...existing, provider: sel.id, baseUrl: sel.baseUrl, model: sel.models[0] || '', style: sel.style, name: '' } : null; draw(); }));
      $$('[data-open]').forEach((a) => (a.onclick = () => D.open(a.dataset.open)));
      $$('[data-alt]').forEach((a) => (a.onclick = () => { const alt = sel.altBaseUrls[+a.dataset.alt]; $('#fBase').value = alt.baseUrl; if (alt.style === 'anthropic' || alt.style === 'openai') $('#fStyle').value = alt.style; }));
      const form = () => ({ id: existing && existing.id, name: $('#fName').value.trim(), provider: sel.id, providerName: sel.name, baseUrl: $('#fBase').value.trim(), model: $('#fModel').value.trim(), apiKey: $('#fKey').value, style: $('#fStyle').value, maxTokens: $('#fMax').value.trim() });
      const out = (m, ok) => { const o = $('#tOut'); o.textContent = m; o.className = 'test-out ' + (ok ? 'ok' : 'bad'); };
      if ($('#mTest')) $('#mTest').onclick = async () => { out('Testing…', true); const r = await D.testProfile(form()); out(r.message, r.ok); };
      if ($('#fFetch')) $('#fFetch').onclick = async () => { out('Loading models…', true); const r = await D.listModels(form()); if (r.ok && r.models.length) { $('#fModels').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join(''); out(`${r.models.length} models found. Start typing in Model.`, true); } else out(r.message || 'No list available; type the model id.', false); };
      if ($('#mSave')) $('#mSave').onclick = async () => { const f = form(); if (!f.model) return out('Add a model id.', false); await D.saveProfile(f); S.settings = await D.settings(); $('#modal').classList.remove('on'); renderAgents(); toast('Model connection saved'); };
      if ($('#mDel')) $('#mDel').onclick = async () => { await D.deleteProfile(existing.id); S.settings = await D.settings(); $('#modal').classList.remove('on'); renderAgents(); };
    };
    draw();
    $('#modal').classList.add('on');
  }
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') $('#modal').classList.remove('on'); };

  // ---------- Connect ----------
  function renderConnect() {
    const base = `http://127.0.0.1:${S.port}`;
    $('#mcpUrl').textContent = `${base}/mcp`;
    $('#restUrl').textContent = `${base}/api`;
    const exe = S.info.exe || 'C:\\Users\\you\\Concord\\Concord.exe';
    const bridge = S.info.packaged ? `${S.info.resources}\\app.asar\\src\\server\\mcp-stdio.js` : 'C:\\path\\to\\concord\\src\\server\\mcp-stdio.js';
    const j = (o) => JSON.stringify(o, null, 2);
    const C = {
      claude: ['Claude Code', `claude mcp add --transport http concord "${base}/mcp?agent=claude-code"`, 'Run in your terminal inside the project. Then ask Claude to "use concord".'],
      codex: ['Codex', `# ~/.codex/config.toml\n[mcp_servers.concord]\ncommand = ${JSON.stringify(exe)}\nargs = [${JSON.stringify(bridge)}, "--agent", "codex", "--port", "${S.port}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }`, 'Uses Concord itself as the bridge, so you do not need Node installed.'],
      cursor: ['Cursor', `// .cursor/mcp.json\n${j({ mcpServers: { concord: { url: `${base}/mcp?agent=cursor` } } })}`, 'Put this in your project or in ~/.cursor/mcp.json.'],
      cline: ['Cline', j({ mcpServers: { concord: { type: 'streamableHttp', url: `${base}/mcp?agent=cline` } } }), 'Cline → MCP Servers → Configure → paste into cline_mcp_settings.json.'],
      gemini: ['Gemini CLI', `// ~/.gemini/settings.json\n${j({ mcpServers: { concord: { httpUrl: `${base}/mcp?agent=gemini-cli` } } })}`, 'Restart Gemini CLI, then run /mcp to see Concord.'],
      vscode: ['VS Code', `// .vscode/mcp.json\n${j({ servers: { concord: { type: 'http', url: `${base}/mcp?agent=copilot` } } })}`, 'For GitHub Copilot agent mode.'],
      windsurf: ['Windsurf', j({ mcpServers: { concord: { serverUrl: `${base}/mcp?agent=windsurf` } } }), 'Windsurf → MCP → View raw config.'],
      stdio: ['Any stdio client', j({ mcpServers: { concord: { command: exe, args: [bridge, '--agent', 'my-agent', '--port', String(S.port)], env: { ELECTRON_RUN_AS_NODE: '1' } } } }), 'For tools that only launch MCP servers as a command.'],
      rest: ['REST / scripts', `# read a file (note its revision)\ncurl -s -X POST ${base}/api/tool/read_file -H "Content-Type: application/json" -d "{\\"agent\\":\\"my-bot\\",\\"args\\":{\\"path\\":\\"src/app.js\\"}}"\n\n# edit against that revision\ncurl -s -X POST ${base}/api/tool/edit_file -H "Content-Type: application/json" -d "{\\"agent\\":\\"my-bot\\",\\"args\\":{\\"path\\":\\"src/app.js\\",\\"baseRev\\":3,\\"edits\\":[{\\"old\\":\\"foo()\\",\\"new\\":\\"bar()\\"}]}}"\n\n# all tools: GET ${base}/api/tools   live events: GET ${base}/api/events`, 'Every MCP tool is also POST /api/tool/<name>.'],
    };
    $('#clientTabs').innerHTML = Object.entries(C).map(([k, v]) => `<button class="${S.clientTab === k ? 'on' : ''}" data-tab="${k}">${v[0]}</button>`).join('');
    $$('#clientTabs button').forEach((b) => (b.onclick = () => { S.clientTab = b.dataset.tab; renderConnect(); }));
    const cur = C[S.clientTab];
    $('#snippet').textContent = cur[1]; $('#snippetHint').textContent = cur[2];
    $('#rules').textContent = RULES;
  }
  const RULES = `# Working in this project with Concord
Several AI agents edit this project at the same time. Concord keeps them from overwriting each other.
- Use ONLY the concord MCP tools to read and change project files (read_file, reserve, edit_file, write_file). Do not use your built-in file edit or write tools for project files.
- Start with concord_briefing. Claim a task on the board (task_claim) or add one (task_create).
- read_file gives a revision number. Pass it as baseRev to edit_file.
- reserve the function or lines you will change before editing. Never edit lines another agent reserved.
- If an edit comes back REJECTED, redo your change on the fresh file it returns.
- Save decisions and conventions with memory_write; check memory_search before making new ones.
- When finished, task_update to done (this releases your reservations).`;
  const copy = (t) => { if (D) D.copy(t); else navigator.clipboard.writeText(t); toast('Copied'); };
  $$('[data-copy]').forEach((b) => (b.onclick = () => copy($(b.dataset.copy).textContent)));
  $('#copySnippet').onclick = () => copy($('#snippet').textContent);
  $('#writeRules').onclick = async () => { if (!S.snap) return toast('Open a project first', '#ff5b6e'); const r = await api('/tool/write_file', { agent: 'user', args: { path: 'CONCORD.md', baseRev: 0, content: RULES + '\n', message: 'house rules for agents' } }); toast(/REJECTED/.test(r.text) ? 'CONCORD.md already exists' : 'Added CONCORD.md to the project'); };

  // ---------- Safety: checkpoints ----------
  async function renderSafety() {
    if (!S.snap) return;
    const r = await api('/checkpoints');
    if (!r.ready) { $('#cpList').innerHTML = '<div class="empty">Checkpoints need Git. Install Git for Windows (git-scm.com), restart Concord, and every finished task will be snapshotted automatically.</div>'; $('#cpNow').disabled = true; return; }
    $('#cpNow').disabled = false;
    const list = r.list || [];
    $('#cpList').innerHTML = list.map((c, i) => `<div class="cp" style="--c:${colorOf(c.agent || 'user')}"><i></i><div class="cp-main"><b>${esc(c.message)}</b><small>${esc(c.short)} · ${new Date(c.at).toLocaleString()} · ${ago(c.at)}</small></div>${i === 0 ? '<span class="cur">latest</span>' : `<button class="btn sm" data-cpv="${c.sha}">Changes</button><button class="btn sm" data-cpr="${c.sha}">Restore</button>`}</div>`).join('') || '<div class="empty">No checkpoints yet. One is taken when the team starts and after every finished task.</div>';
    $$('[data-cpv]').forEach((b) => (b.onclick = async () => { const ch = await api('/checkpoint/changes?sha=' + b.dataset.cpv); $('#cpDetail').innerHTML = `<h3 style="margin-top:18px">Since ${esc(b.dataset.cpv.slice(0, 7))}</h3><div class="cp-files">${ch.map((l) => { const [k, ...f] = l.split('\t'); return `<div><span class="k ${k[0]}">${esc(k[0])}</span>${esc(f.join(' → '))}</div>`; }).join('') || '<div class="muted small">No differences.</div>'}</div>`; }));
    $$('[data-cpr]').forEach((b) => (b.onclick = async () => {
      if (S.running) return toast('Pause the team first.', '#ffc94d');
      if (!confirm('Put the whole project back to this checkpoint? Concord snapshots the current state first, so you can undo this.')) return;
      const x = await api('/checkpoint/restore', { sha: b.dataset.cpr });
      toast(x.ok ? `Project restored. Undo with the “Before restoring” checkpoint.` : x.message, x.ok ? '#46d6b0' : '#ff5b6e');
      S.file = null; S.fileData = null; renderSafety(); reload();
    }));
  }
  $('#cpNow').onclick = async () => { const r = await api('/checkpoint', { message: 'Manual checkpoint' }); toast(r.ok ? (r.changed === false ? 'Nothing changed since the last checkpoint' : 'Checkpoint saved') : r.message, r.ok ? '#46d6b0' : '#ff5b6e'); renderSafety(); };

  // ---------- Beta feedback ----------
  async function feedbackModal() {
    const d = D ? await D.diag() : { version: 'browser', os: navigator.userAgent, email: 'affanm2010@gmail.com', logTail: '' };
    const diag = `Concord ${d.version} · ${d.os}${d.electron ? ' · Electron ' + d.electron : ''}\nAgents: ${d.agents ?? '?'} · Providers: ${d.models || 'none'} · Commands: ${d.commands || '?'}`;
    $('#modalCard').innerHTML = `<div class="row" style="justify-content:space-between"><div><h2>Concord is in beta</h2><div class="sub">Thanks for trying it early. Tell us what broke, what confused you, or what you wish it did.</div></div><button class="btn ghost sm" id="mClose">Close</button></div>
      <div class="form"><label class="full">Your feedback<textarea id="fbText" rows="6" placeholder="What happened? What did you expect?"></textarea></label>
      <label class="full">Attach diagnostics<pre class="snippet" style="max-height:120px">${esc(diag)}${d.logTail ? '\n\nRecent log:\n' + esc(d.logTail) : ''}</pre><span class="hint">No API keys or code are included. Long tokens are redacted.</span></label></div>
      <div class="modal-foot">${D ? '<button class="btn ghost" id="fbLogs">Open log folder</button>' : ''}<button class="btn" id="fbCopy">Copy diagnostics</button><button class="btn" id="fbMail">Email instead</button><button class="btn primary" id="fbSend">Open GitHub issue</button></div>`;
    $('#mClose').onclick = () => $('#modal').classList.remove('on');
    if ($('#fbLogs')) $('#fbLogs').onclick = () => D.openLogs();
    $('#fbCopy').onclick = () => copy(diag + (d.logTail ? '\n\n' + d.logTail : ''));
    const fbBody = () => `${$('#fbText').value}\n\n---\n${diag}\n\n${(d.logTail || '').slice(-1500)}`;
    const go = (u) => { if (D) D.open(u); else window.open(u, '_blank'); };
    $('#fbSend').onclick = () => { const t = ($('#fbText').value.split('\n')[0] || 'Beta feedback').slice(0, 80); go(`https://github.com/AstralVortex1610/concord/issues/new?labels=beta&title=${encodeURIComponent(t)}&body=${encodeURIComponent(fbBody().slice(0, 5000))}`); toast('Opening GitHub…'); };
    $('#fbMail').onclick = () => { go(`mailto:${d.email}?subject=${encodeURIComponent('Concord beta feedback (' + d.version + ')')}&body=${encodeURIComponent(fbBody())}`); toast('Opening your email app…'); };
    $('#modal').classList.add('on');
  }
  $('#feedbackBtn').onclick = feedbackModal;
  $('#welcomeFeedback').onclick = feedbackModal;

  // ---------- project + team ----------
  async function openDir(dir) { const r = await D.openProject(dir); if (!r.ok) return toast(r.message, '#ff5b6e'); await afterOpen(); }
  async function afterOpen() { S.file = null; S.fileData = null; S.notes = []; await loadSnap(); S.settings = D ? await D.settings() : null; show('score'); }
  $('#openBtn').onclick = async () => { const r = await D.pickProject(); if (r.ok) afterOpen(); };
  $('#projectPill').onclick = async () => { if (!D) return; const r = await D.pickProject(); if (r.ok) afterOpen(); };
  function setRunning(on) {
    S.running = on;
    const b = $('#teamBtn');
    b.className = 'btn ' + (on ? 'stop' : 'primary');
    b.innerHTML = on ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" /></svg><span>Pause team</span>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg><span>Start team</span>';
    setLive(true);
  }
  $('#teamBtn').onclick = async () => {
    if (!D) return toast('Start the team from the Concord app.', '#ffc94d');
    if (S.running) { await D.stopTeam(); setRunning(false); toast('Team paused. Reservations released.'); return; }
    const r = await D.startTeam();
    if (!r.ok) { toast(r.message, '#ff5b6e'); if (/agent/i.test(r.message)) show('agents'); return; }
    setRunning(true); toast('Team is live. Agents are picking up tasks.', '#46d6b0');
  };
  $('#goalBtn').onclick = planGoal;
  $('#goalInput').onkeydown = (e) => { if (e.key === 'Enter') planGoal(); };
  async function planGoal() {
    const g = $('#goalInput').value.trim(); if (!g) return;
    if (!D) return toast('Planning needs the Concord app.', '#ffc94d');
    $('#goalBtn').disabled = true; $('#goalBtn').textContent = 'Planning…';
    const r = await D.plan(g);
    $('#goalBtn').disabled = false; $('#goalBtn').textContent = 'Plan it';
    if (r.ok) { $('#goalInput').value = ''; toast(`Planned ${r.tasks} tasks. ${S.running ? 'Agents are on it.' : 'Press Start team when ready.'}`, '#ffc94d'); reload(); }
    else toast(r.message, '#ff5b6e');
  }

  // ---------- boot ----------
  (async () => {
    if (D) {
      S.info = await D.info(); S.port = S.info.port; S.settings = await D.settings(); S.presets = await D.presets();
      const st = await D.teamStatus(); setRunning(st.running);
      D.on('project', () => afterOpen());
    }
    await loadSnap();
    connectEvents();
    show(S.snap ? 'score' : 'welcome');
    if (window.__concordReady) window.__concordReady();
  })();
  window.__S = S; window.__show = show; window.__openTask = openTask; window.__profileModal = profileModal; window.__loadFile = loadFile;
})();
