// Swarm Build view. Every cursor is a real agent; every box it draws is an element that agent's real commit just added
// to the real product, found by diffing the live page before and after the commit. Nothing here is scripted.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PHASES = [['planning', 'Plan'], ['scaffold', 'Skeleton'], ['building', 'Build'], ['checking', 'Check'], ['live', 'Live']];
  const CURSOR_SVG = (c) => `<svg viewBox="0 0 24 24" class="sw-arrow"><path d="M4 3l15 7.5-6.6 1.7L9.6 19z" fill="${c}" stroke="#0b0b12" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

  let ctx = null;                 // { S, api, D, toast, agentOf, show }
  let st = { phase: 'idle' };     // swarm status from the server
  const cursors = new Map();      // agentId -> cursor
  let front = 0, loadN = 0, lastMap = null, reloadT = null, pending = new Map(), goLive = false, mouse = null, booted = false;

  const view = () => $('#swView');
  const frames = () => [$('#swF0'), $('#swF1')];
  const size = () => { const v = view(); return { w: v.clientWidth, h: v.clientHeight - 46 }; };

  // ---------- cursors ----------
  function cursorFor(id) {
    let c = cursors.get(id);
    if (c) return c;
    const a = ctx.agentOf(id);
    if (!a || id === 'user' || id === 'concord') return null;
    const { w, h } = size();
    const el = document.createElement('div');
    el.className = 'sw-cur';
    el.style.setProperty('--c', a.color || '#ff7a59');
    el.innerHTML = `${CURSOR_SVG(a.color || '#ff7a59')}<div class="sw-tag"><b>${esc(a.name)}</b><span>${esc(shortModel(a.model))}</span></div><div class="sw-say"></div>`;
    $('#swCursors').appendChild(el);
    const i = cursors.size;
    c = { id, el, x: w / 2 + Math.cos(i * 2.1) * 140, y: h / 2 + Math.sin(i * 2.1) * 90, vx: 0, vy: 0, tx: null, ty: null, hold: 0, i, queue: Promise.resolve(), sayT: 0 };
    cursors.set(id, c);
    return c;
  }
  const shortModel = (m) => String(m || '').replace(/^.*\//, '').slice(0, 22);
  function say(c, text, kind) {
    if (!c) return;
    const b = c.el.querySelector('.sw-say');
    b.textContent = text; b.className = 'sw-say on ' + (kind || '');
    clearTimeout(c.sayT); c.sayT = setTimeout(() => b.classList.remove('on'), kind === 'bad' ? 3200 : 2600);
  }
  function goTo(c, x, y, holdMs = 1800) { if (!c) return; c.tx = x; c.ty = y; c.hold = performance.now() + holdMs; }
  const arrive = (c, x, y, ms = 650) => new Promise((r) => { goTo(c, x, y, ms + 2600); const t0 = performance.now(); const chk = () => { if (Math.hypot(c.x - x, c.y - y) < 6 || performance.now() - t0 > ms + 500) r(); else requestAnimationFrame(chk); }; chk(); });

  let t0 = performance.now();
  function step(now) {
    const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
    const { w, h } = size();
    const list = [...cursors.values()];
    list.forEach((c, i) => {
      let tx = c.tx, ty = c.ty;
      if (tx == null || now > c.hold) {
        c.tx = null;
        // Idle: orbit the centre (or the mouse once the product is live), like a flock waiting for work.
        const cx = goLive && mouse ? mouse.x : w / 2, cy = goLive && mouse ? mouse.y : h / 2;
        const r = goLive && mouse ? 46 + i * 8 : Math.min(w, h) * (st.phase === 'idle' ? 0.2 : 0.3);
        const a = now / 3200 + i * (Math.PI * 2 / Math.max(1, list.length)) + Math.sin(now / 1700 + i) * 0.18;
        tx = cx + Math.cos(a) * r; ty = cy + Math.sin(a) * r * 0.62;
      }
      const k = 38, d = 11;
      c.vx += ((tx - c.x) * k - c.vx * d) * dt; c.vy += ((ty - c.y) * k - c.vy * d) * dt;
      // Separation so cursors never sit on top of each other.
      for (const o of list) if (o !== c) { const dx = c.x - o.x, dy = c.y - o.y, dd = dx * dx + dy * dy; if (dd < 900 && dd > 0.01) { c.vx += (dx / Math.sqrt(dd)) * 260 * dt; c.vy += (dy / Math.sqrt(dd)) * 260 * dt; } }
      c.x += c.vx * dt; c.y += c.vy * dt;
      c.el.style.transform = `translate(${c.x}px, ${c.y}px)`;
      const up = c.y > h - 50; if (up !== c.up) { c.up = up; c.el.classList.toggle('up', up); }
    });
    requestAnimationFrame(step);
  }

  // ---------- the file dock ----------
  function dockTab(p) {
    let t = $(`.sw-tab[data-p="${CSS.escape(p)}"]`);
    if (!t) {
      t = document.createElement('div'); t.className = 'sw-tab'; t.dataset.p = p;
      t.innerHTML = `<i class="sw-ext">${esc((p.split('.').pop() || '').slice(0, 4))}</i><span>${esc(p)}</span><b class="sw-rev"></b><em class="sw-holders"></em>`;
      $('#swDock').appendChild(t);
    }
    return t;
  }
  function tabPoint(p) { const t = dockTab(p); const v = view().getBoundingClientRect(); const r = t.getBoundingClientRect(); return { x: r.left - v.left + r.width * 0.55, y: r.top - v.top + 10 }; }
  function bumpTab(p, rev, color) { const t = dockTab(p); if (rev) t.querySelector('.sw-rev').textContent = 'r' + rev; t.style.setProperty('--c', color || 'var(--mint)'); t.classList.remove('hit'); void t.offsetWidth; t.classList.add('hit'); }

  // A code card that types out the lines an agent really added.
  async function typeCard(c, p, lines, color) {
    const pt = tabPoint(p);
    const card = document.createElement('div'); card.className = 'sw-code'; card.style.setProperty('--c', color);
    const { w } = size();
    card.style.left = Math.max(8, Math.min(w - 330, pt.x - 40)) + 'px'; card.style.bottom = '54px';
    card.innerHTML = `<div class="sw-code-h">${esc(p)}</div><pre></pre>`;
    $('#swLayer').appendChild(card);
    const pre = card.querySelector('pre');
    const text = lines.slice(0, 7).map((l) => l.slice(0, 64)).join('\n');
    const per = Math.max(4, Math.min(18, 900 / Math.max(1, text.length)));
    for (let i = 0; i <= text.length; i += 2) { pre.textContent = text.slice(0, i); pre.insertAdjacentHTML('beforeend', '<i class="sw-caret"></i>'); if (c) goTo(c, Math.min(w - 20, parseFloat(card.style.left) + 18 + (i % 60) * 4.5), size().h - 54 - 14 * Math.min(6, text.slice(0, i).split('\n').length), 900); await wait(per); }
    setTimeout(() => { card.classList.add('out'); setTimeout(() => card.remove(), 500); }, 1100);
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- live preview + diff ----------
  function collect(frame) {
    const out = [];
    let doc; try { doc = frame.contentDocument; } catch { return out; }
    if (!doc || !doc.body) return out;
    const all = doc.body.querySelectorAll('*');
    const vh = frame.clientHeight;
    for (let i = 0; i < all.length && i < 3000; i++) {
      const el = all[i];
      if (/^(SCRIPT|STYLE|LINK|META|BR|TEMPLATE)$/.test(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 6) continue;
      let own = ''; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent;
      const key = `${el.tagName}#${el.id}.${typeof el.className === 'string' ? el.className.trim() : ''}|${own.trim().slice(0, 40)}|${el.getAttribute('src') || ''}`;
      out.push({ el, key, r: { x: r.left, y: r.top, w: r.width, h: r.height }, vis: r.bottom > 0 && r.top < vh });
    }
    return out;
  }
  function diff(prev, now) {
    const cnt = new Map(); for (const it of prev || []) cnt.set(it.key, (cnt.get(it.key) || 0) + 1);
    const fresh = [];
    for (const it of now) { const n = cnt.get(it.key) || 0; if (n > 0) cnt.set(it.key, n - 1); else fresh.push(it); }
    const set = new Set(fresh.map((f) => f.el));
    const top = fresh.filter((f) => { for (let p = f.el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; });
    return top.sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h).slice(0, 5).sort((a, b) => a.r.y - b.r.y);
  }
  function moved(prev, now) {
    const pm = new Map(); for (const it of prev || []) if (!pm.has(it.key)) pm.set(it.key, it.r);
    const out = [];
    for (const it of now) { const r = pm.get(it.key); if (r && (Math.abs(r.w - it.r.w) > 6 || Math.abs(r.h - it.r.h) > 6) && it.vis) out.push(it); }
    return out.sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h).slice(0, 2);
  }

  function queueReload(agentId, p) {
    if (!st.entry) return;
    if (agentId) { const a = pending.get(agentId) || new Set(); a.add(p); pending.set(agentId, a); }
    clearTimeout(reloadT); reloadT = setTimeout(doReload, 320);
  }
  function doReload() {
    const [f0, f1] = frames();
    const cur = front ? f1 : f0, back = front ? f0 : f1;
    const who = pending; pending = new Map();
    let scroll = 0; try { scroll = cur.contentWindow.scrollY || 0; } catch { }
    back.onload = async () => {
      try { back.contentWindow.scrollTo(0, scroll); } catch { }
      await wait(90);
      let now = collect(back);
      const fresh = diff(lastMap, now);
      // The swarm chases the work: if the new part is below the fold, scroll there first.
      if (fresh.length && !fresh.some((f) => f.vis)) { try { back.contentWindow.scrollTo(0, Math.max(0, scroll + fresh[0].r.y - 70)); } catch { } await wait(60); now = collect(back); }
      const fresh2 = diff(lastMap, now).filter((f) => f.vis);
      const restyled = fresh2.length ? [] : moved(lastMap, now);
      // Cover every new element before the swap, so the agents can draw them in.
      const covers = fresh2.map((f) => cover(f.r, back));
      back.classList.add('front'); cur.classList.remove('front');
      front = front ? 0 : 1;
      lastMap = now;
      $('#swEmpty').classList.add('gone');
      const agents = [...who.keys()];
      if (!agents.length) { covers.forEach((cv) => reveal(cv)); return; }
      fresh2.forEach((f, i) => { const aid = agents[i % agents.length]; const c = cursorFor(aid); if (!c) return reveal(covers[i]); c.queue = c.queue.then(() => drawBox(c, f.r, covers[i])); });
      restyled.forEach((f, i) => { const c = cursorFor(agents[i % agents.length]); if (c) c.queue = c.queue.then(() => restyle(c, f.r)); });
    };
    back.src = `/preview/${st.entry}?v=${++loadN}`;
  }
  function pageBg(frame) { try { const d = frame.contentDocument; const b = getComputedStyle(d.body).backgroundColor; const h = getComputedStyle(d.documentElement).backgroundColor; const ok = (x) => x && !/rgba\(0, 0, 0, 0\)|transparent/.test(x); return ok(b) ? b : ok(h) ? h : '#ffffff'; } catch { return '#ffffff'; } }
  function cover(r, frame) { const d = document.createElement('div'); d.className = 'sw-cover'; Object.assign(d.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px', background: pageBg(frame) }); $('#swLayer').appendChild(d); return d; }
  function reveal(cv) { if (!cv) return; cv.classList.add('out'); setTimeout(() => cv.remove(), 600); }
  async function drawBox(c, r, cv) {
    const color = getComputedStyle(c.el).getPropertyValue('--c').trim();
    await arrive(c, r.x, r.y, 520);
    const box = document.createElement('div'); box.className = 'sw-box'; box.style.setProperty('--c', color);
    Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: '0px', height: '0px' });
    box.innerHTML = `<span class="sw-badge"></span>`;
    $('#swLayer').appendChild(box);
    c.el.classList.add('cross');
    const dur = Math.min(900, 380 + Math.sqrt(r.w * r.h) * 0.9), t0 = performance.now();
    await new Promise((res) => { const f = () => { const k = Math.min(1, (performance.now() - t0) / dur), e = 1 - Math.pow(1 - k, 3); const w = r.w * e, h = r.h * e; box.style.width = w + 'px'; box.style.height = h + 'px'; box.firstChild.textContent = `${Math.round(w)} × ${Math.round(h)}`; goTo(c, r.x + w, r.y + h, 600); if (k < 1) requestAnimationFrame(f); else res(); }; f(); });
    c.el.classList.remove('cross');
    box.classList.add('fill'); reveal(cv);
    await wait(380); box.classList.add('out'); setTimeout(() => box.remove(), 700);
  }
  async function restyle(c, r) {
    const color = getComputedStyle(c.el).getPropertyValue('--c').trim();
    await arrive(c, r.x + r.w * 0.5, r.y + Math.min(r.h, 40) * 0.5, 480);
    const s = document.createElement('div'); s.className = 'sw-sweep'; s.style.setProperty('--c', color);
    Object.assign(s.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    $('#swLayer').appendChild(s); setTimeout(() => s.remove(), 1100); await wait(500);
  }

  // ---------- events ----------
  function onEvent(e) {
    if (!booted) return;
    if (e.type === 'swarm') { refresh(); return; }
    const watching = ['planning', 'scaffold', 'building', 'checking', 'live'].includes(st.phase);
    if (!watching) return;
    const c = e.agent ? cursorFor(e.agent) : null;
    if (e.type === 'agent-log') {
      if (e.kind === 'think' && e.text) say(c, e.text.replace(/\s+/g, ' ').slice(0, 70));
      if (e.kind === 'start') say(c, e.text.slice(0, 70));
      if (e.kind === 'done') say(c, '✓ ' + e.text.replace(/\s+/g, ' ').slice(0, 60), 'good');
      if (e.kind === 'tool') {
        const name = (/^(\w+)\(/.exec(e.text) || [])[1]; const p = (/"path":"([^"]+)"/.exec(e.text) || [])[1];
        if (p && /read_file|find_symbols|reserve|edit_file|write_file/.test(name)) { const pt = tabPoint(p); goTo(c, pt.x + (Math.random() - 0.5) * 30, pt.y, 2200); }
        if (name === 'read_file') say(c, `reading ${p}`);
        if (name === 'reserve') { const sym = (/"symbol":"([^"]+)"/.exec(e.text) || [])[1]; say(c, `claiming ${sym || 'lines'} in ${p}`); }
        if (name === 'memory_write' || name === 'memory_search') { const { w } = size(); goTo(c, w - 70, 30, 1800); say(c, name === 'memory_write' ? 'sharing with the swarm' : 'checking shared memory'); }
        if (name === 'run_command') say(c, 'running it');
      }
      return;
    }
    if (e.type === 'lease' && e.path) { const t = dockTab(e.path); t.classList.add('held'); t.querySelector('.sw-holders').insertAdjacentHTML('beforeend', `<i style="background:${ctx.agentOf(e.agent).color}" data-a="${esc(e.agent)}"></i>`); }
    if (e.type === 'release') { document.querySelectorAll(`.sw-holders i[data-a="${CSS.escape(e.agent || '')}"]`).forEach((x) => x.remove()); }
    if (e.type === 'reject') { if (c) { c.el.classList.remove('shake'); void c.el.offsetWidth; c.el.classList.add('shake'); } say(c, e.reason === 'leased' ? 'that part is claimed, picking another' : 'clash caught, redoing on fresh code', 'bad'); }
    if (e.type === 'commit' && e.path && !e.deleted) {
      const color = ctx.agentOf(e.agent).color;
      bumpTab(e.path, e.rev, color);
      if (e.rebased) say(c, `auto-merged into ${e.path}`, 'merge');
      const isHtml = /\.html?$/i.test(e.path);
      if (!isHtml && c && e.add) {
        fetch('/api/file?path=' + encodeURIComponent(e.path)).then((r) => r.json()).then((f) => {
          const lines = String(f.text || '').split('\n').slice(Math.max(0, (e.line || 1) - 1), (e.line || 1) - 1 + Math.min(e.add, 7)).filter((l) => l.trim());
          if (lines.length) c.queue = c.queue.then(() => typeCard(c, e.path, lines, color));
        }).catch(() => {});
      }
      queueReload(e.agent, e.path);
      stats();
    }
    if (e.type === 'task') refreshSoon();
  }
  let refT = null; const refreshSoon = () => { clearTimeout(refT); refT = setTimeout(refresh, 400); };

  async function refresh() {
    const was = st.phase;
    try { st = await (await fetch('/api/swarm')).json(); } catch { st = { phase: 'idle' }; }
    if (ctx.setRunning && was !== st.phase) { if (st.phase === 'building') ctx.setRunning(true); if (['live', 'stopped', 'error'].includes(st.phase) && st.startedTeam) ctx.setRunning(false); }
    paint();
  }

  // ---------- paint ----------
  function paint() {
    const ph = st.phase || 'idle';
    const idx = PHASES.findIndex((p) => p[0] === ph);
    $('#swSteps').innerHTML = PHASES.map(([k, l], i) => `<span class="sw-step ${i < idx || ph === 'live' ? 'done' : ''} ${i === idx ? 'on' : ''}"><i>${i + 1}</i>${l}</span>`).join('<b></b>');
    $('#swUrl').textContent = st.entry ? `localhost / ${st.name || ''} / ${st.entry}` : 'swarm://blank-canvas';
    const busy = ['planning', 'scaffold', 'building', 'checking'].includes(ph);
    $('#swGo').disabled = busy; $('#swGo').innerHTML = busy ? '<span class="sw-spin"></span>Building…' : '<svg viewBox="0 0 24 24"><path d="M12 2l2.6 6.4L21 11l-6.4 2.6L12 20l-2.6-6.4L3 11l6.4-2.6z"/></svg>Build it';
    $('#swStop').classList.toggle('hide', !busy);
    $('#swOpen').classList.toggle('hide', !st.entry); $('#swLive').classList.toggle('hide', ph !== 'live');
    $('#swFolder').classList.toggle('hide', !st.entry);
    const note = $('#swNote');
    if (ph === 'live') note.innerHTML = st.ok ? `<b>${esc(st.name)}</b> is built and runs clean. Every file is real, in your project folder.` : `<b>${esc(st.name)}</b> is built. ${st.issues.length} issue${st.issues.length > 1 ? 's' : ''} left: ${esc(st.issues[0].message)}`;
    else if (ph === 'error') note.innerHTML = `<span style="color:var(--red)">${esc(st.error || 'Stopped')}</span>`;
    else if (ph === 'checking') note.textContent = 'Concord is loading the product for real and clicking around for errors…';
    else if (ph === 'planning') note.textContent = 'The planner is designing the product and splitting it so many agents can build at once…';
    else if (ph === 'building' && st.round) note.textContent = `Round ${st.round + 1}: the swarm is fixing what the check found.`;
    else if (ph === 'building') note.textContent = 'Agents are claiming sections and building the same files at the same time. Clashes merge or bounce back, never overwrite.';
    else note.textContent = 'Describe a product. A swarm of real agents, on any models you connected, plans it, builds it in parallel and checks it until it runs.';
    // Tasks
    const tasks = st.tasks || [];
    $('#swTasks').innerHTML = tasks.length ? tasks.map((t) => { const a = t.owner ? ctx.agentOf(t.owner) : null; return `<div class="sw-task ${t.status}"><i style="${a ? 'background:' + a.color : ''}"></i><span>${esc(t.title)}</span><em>${t.status === 'working' && a ? esc(a.name) : t.status}</em></div>`; }).join('') : '<div class="muted small">Tasks appear here when the planner splits the product.</div>';
    if (st.entry && !lastMap && !$('#swF0').src && !$('#swF1').src) queueReload(null);
    agentsList(); stats();
  }
  function agentsList() {
    const S = ctx.S; const list = (S.snap ? S.snap.agents.filter((a) => a.kind === 'builtin' || a.online && a.id !== 'user') : (S.settings ? S.settings.agents : []));
    $('#swAgents').innerHTML = list.length ? list.map((a) => `<div class="sw-agent" style="--c:${a.color}">${CURSOR_SVG(a.color)}<div><b>${esc(a.name)}</b><span>${esc(shortModel(a.model) || a.provider || 'model not set')}</span></div><em class="${a.status || ''}">${esc(a.status && a.status !== 'idle' ? a.status : a.kind === 'external' ? 'MCP' : '')}</em></div>`).join('') : '<div class="muted small">Add agents in the Agents tab. Mix any models.</div>';
    for (const a of list) cursorFor(a.id);
  }
  function stats() {
    const s = ctx.S.snap ? ctx.S.snap.stats : {};
    const files = document.querySelectorAll('.sw-tab').length;
    const el = st.started ? Math.round(((st.finished || Date.now()) - st.started) / 1000) : 0;
    $('#swStats').innerHTML = [['Commits', s.commits || 0], ['Auto-merged', s.rebased || 0], ['Clashes caught', (s.conflicts || 0) + (s.blocked || 0)], ['Files', files], ['Time', el ? `${Math.floor(el / 60)}:${String(el % 60).padStart(2, '0')}` : '–']].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
  }

  // ---------- actions ----------
  async function go(here) {
    const brief = $('#swBrief').value.trim();
    if (!brief) { $('#swBrief').focus(); return ctx.toast('Describe what the swarm should build.', '#ffc94d'); }
    if (!ctx.D) return ctx.toast('Swarm Build runs in the Concord app.', '#ffc94d');
    resetStage();
    st = { phase: 'planning', brief }; paint();
    const r = await ctx.D.swarmStart(brief, { newFolder: !here });
    if (r && r.ok === false) { ctx.toast(r.message, '#ff5b6e'); if (/agent/i.test(r.message)) ctx.show('agents'); }
    refresh();
  }
  function resetStage() {
    lastMap = null; pending = new Map(); goLive = false; view().classList.remove('golive');
    frames().forEach((f) => { f.removeAttribute('src'); f.classList.remove('front'); });
    $('#swLayer').innerHTML = ''; $('#swDock').innerHTML = ''; $('#swEmpty').classList.remove('gone');
  }

  function init(c) {
    ctx = c;
    $('#swGo').onclick = () => go(false);
    $('#swHere').onclick = () => go(true);
    $('#swBrief').onkeydown = (e) => { if (e.key === 'Enter') go(false); };
    $('#swStop').onclick = async () => { if (ctx.D) await ctx.D.swarmStop(); refresh(); };
    $('#swOpen').onclick = () => (ctx.D ? ctx.D.openPreview() : window.open(`/preview/${st.entry}`));
    $('#swFolder').onclick = () => ctx.D && ctx.D.revealProject();
    $('#swLive').onclick = () => { goLive = !goLive; view().classList.toggle('golive', goLive); $('#swLive').textContent = goLive ? 'Show the swarm' : 'Go live'; };
    view().addEventListener('mousemove', (e) => { const r = view().getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; });
    view().addEventListener('mouseleave', () => (mouse = null));
    document.querySelectorAll('.sw-idea').forEach((b) => (b.onclick = () => { $('#swBrief').value = b.dataset.idea; $('#swBrief').focus(); }));
    booted = true;
    requestAnimationFrame(step);
    refresh();
  }
  window.ConcordSwarm = { init, onEvent, render: () => { refresh(); }, _state: () => st, _reload: () => queueReload(null) };
})();
