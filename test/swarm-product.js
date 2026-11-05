// A real product for the Swarm Build tests and demo: "Tempo", a pomodoro focus timer with tasks and stats.
// The mock models below build it section by section, in parallel, through Concord, exactly like real models would.
const design = {
  name: 'Tempo', entry: 'index.html', summary: 'A focus timer with a task list and session stats.',
  files: [
    { path: 'index.html', purpose: 'page structure', skeleton: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tempo</title>
<link rel="stylesheet" href="styles.css" />
</head>
<body>
<!-- section:header -->
<header id="header"></header>
<!-- /section:header -->
<main class="grid">
<!-- section:timer -->
<section id="timer"></section>
<!-- /section:timer -->
<!-- section:tasks -->
<section id="tasks"></section>
<!-- /section:tasks -->
<!-- section:stats -->
<section id="stats"></section>
<!-- /section:stats -->
</main>
<!-- section:footer -->
<footer id="footer"></footer>
<!-- /section:footer -->
<script src="app.js"></script>
</body>
</html>
` },
    { path: 'styles.css', purpose: 'look', skeleton: `/* section:tokens */
/* /section:tokens */

/* section:layout */
/* /section:layout */

/* section:timer */
/* /section:timer */

/* section:tasks */
/* /section:tasks */

/* section:stats */
/* /section:stats */
` },
    { path: 'app.js', purpose: 'behaviour', skeleton: `// section:state
// /section:state

// section:timer
// /section:timer

// section:tasks
// /section:tasks

// section:stats
// /section:stats
` },
  ],
  tasks: [
    { title: 'Design tokens, layout, header and footer', detail: 'Warm dark palette, type scale, grid; brand header and footer.', files: ['styles.css', 'index.html'], priority: 'high' },
    { title: 'Focus timer: ring, controls and countdown', detail: 'SVG progress ring, start/pause/reset, focus and break modes.', files: ['index.html', 'styles.css', 'app.js'] },
    { title: 'Task list with add, done and delete', detail: 'Tasks saved in localStorage, pick the active task.', files: ['index.html', 'styles.css', 'app.js'] },
    { title: 'Session stats: today, streak and weekly bars', detail: 'Counts focus sessions, renders a 7-day bar chart.', files: ['index.html', 'styles.css', 'app.js'] },
    { title: 'Shared state and persistence', detail: 'One store object saved to localStorage, with a tiny event bus.', files: ['app.js'], priority: 'high' },
  ],
  conventions: ['All state lives in the shared store in app.js (store.get / store.set).', 'Colors only through the CSS variables in the tokens section.'],
};

const S = (file, section, body) => ({ file, section, body });
const steps = {
  'Design tokens, layout, header and footer': [
    S('styles.css', 'tokens', `:root {
  --bg: #12101a; --card: #1c1927; --line: #2c2838; --tx: #f4ede1; --mut: #9a93ab;
  --focus: #ff7a59; --break: #46d6b0; --gold: #ffc94d;
  --r: 22px; --font: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: radial-gradient(1200px 600px at 10% -10%, #2a1d2e, transparent), var(--bg); color: var(--tx); font: 15px/1.5 var(--font); min-height: 100vh; }
button { font: inherit; cursor: pointer; }`),
    S('styles.css', 'layout', `.grid { display: grid; grid-template-columns: 1.15fr 1fr; grid-template-rows: auto auto; gap: 18px; padding: 0 32px 24px; max-width: 1180px; margin: 0 auto; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--r); padding: 22px 24px; box-shadow: 0 30px 60px -40px #000; }
#header { display: flex; align-items: center; gap: 14px; padding: 22px 32px; max-width: 1180px; margin: 0 auto; }
#header .logo { width: 34px; height: 34px; border-radius: 11px; background: conic-gradient(var(--focus), var(--gold), var(--break), var(--focus)); }
#header h1 { margin: 0; font-size: 22px; letter-spacing: -.02em; }
#header p { margin: 0 0 0 auto; color: var(--mut); }
#footer { text-align: center; color: var(--mut); font-size: 13px; padding: 10px 0 28px; }`),
    S('index.html', 'header', `<header id="header"><div class="logo"></div><h1>Tempo</h1><p>Deep work, one tomato at a time.</p></header>`),
    S('index.html', 'footer', `<footer id="footer">Built by a swarm of agents with Concord · your data stays in this browser</footer>`),
  ],
  'Focus timer: ring, controls and countdown': [
    S('index.html', 'timer', `<section id="timer" class="card timer">
  <div class="modes"><button data-mode="focus" class="on">Focus 25</button><button data-mode="break">Break 5</button></div>
  <div class="ring"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" class="track" /><circle cx="60" cy="60" r="52" class="bar" id="ringBar" /></svg><div class="time" id="time">25:00</div><div class="now" id="nowTask">No task picked</div></div>
  <div class="controls"><button id="startBtn" class="primary">Start</button><button id="resetBtn">Reset</button></div>
</section>`),
    S('styles.css', 'timer', `.timer { grid-row: span 2; display: flex; flex-direction: column; align-items: center; gap: 18px; }
.modes { display: flex; gap: 6px; background: #14121c; padding: 5px; border-radius: 99px; }
.modes button { border: 0; background: transparent; color: var(--mut); padding: 7px 16px; border-radius: 99px; }
.modes button.on { background: var(--card); color: var(--tx); box-shadow: 0 0 0 1px var(--line); }
.ring { position: relative; width: min(340px, 70vw); aspect-ratio: 1; }
.ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring circle { fill: none; stroke-width: 8; }
.ring .track { stroke: var(--line); }
.ring .bar { stroke: var(--focus); stroke-linecap: round; stroke-dasharray: 326.7; transition: stroke-dashoffset .9s linear, stroke .4s; }
.time { position: absolute; inset: 0; display: grid; place-items: center; font-size: 64px; font-weight: 700; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
.now { position: absolute; left: 0; right: 0; bottom: 26%; text-align: center; color: var(--mut); font-size: 13px; }
.controls { display: flex; gap: 10px; }
.controls button { border: 1px solid var(--line); background: transparent; color: var(--tx); padding: 11px 26px; border-radius: 14px; font-weight: 600; }
.controls .primary { background: var(--focus); border-color: var(--focus); color: #1a1020; }`),
    S('app.js', 'timer', `const timer = { mode: 'focus', left: 25 * 60, running: false, t: null };
const LEN = { focus: 25 * 60, break: 5 * 60 };
function drawTimer() {
  const m = String(Math.floor(timer.left / 60)).padStart(2, '0'), s = String(timer.left % 60).padStart(2, '0');
  document.getElementById('time').textContent = m + ':' + s;
  const bar = document.getElementById('ringBar');
  bar.style.strokeDashoffset = String(326.7 * (1 - timer.left / LEN[timer.mode]));
  bar.style.stroke = timer.mode === 'focus' ? 'var(--focus)' : 'var(--break)';
  document.getElementById('startBtn').textContent = timer.running ? 'Pause' : 'Start';
}
function tick() {
  timer.left -= 1;
  if (timer.left <= 0) { if (timer.mode === 'focus') bus.emit('session'); setMode(timer.mode === 'focus' ? 'break' : 'focus'); return; }
  drawTimer();
}
function setMode(mode) {
  timer.mode = mode; timer.left = LEN[mode]; timer.running = false; clearInterval(timer.t);
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  drawTimer();
}
document.getElementById('startBtn').onclick = () => { timer.running = !timer.running; clearInterval(timer.t); if (timer.running) timer.t = setInterval(tick, 1000); drawTimer(); };
document.getElementById('resetBtn').onclick = () => setMode(timer.mode);
document.querySelectorAll('.modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
drawTimer();`),
  ],
  'Task list with add, done and delete': [
    S('index.html', 'tasks', `<section id="tasks" class="card tasks">
  <h2>Today's tasks</h2>
  <form id="taskForm"><input id="taskInput" placeholder="What are you focusing on?" autocomplete="off" /><button>Add</button></form>
  <ul id="taskList"></ul>
</section>`),
    S('styles.css', 'tasks', `.tasks h2, .stats h2 { margin: 0 0 12px; font-size: 15px; color: var(--mut); text-transform: uppercase; letter-spacing: .08em; }
#taskForm { display: flex; gap: 8px; margin-bottom: 12px; }
#taskForm input { flex: 1; background: #14121c; border: 1px solid var(--line); color: var(--tx); border-radius: 12px; padding: 10px 12px; outline: none; }
#taskForm button { border: 0; background: var(--gold); color: #1a1020; border-radius: 12px; padding: 0 16px; font-weight: 600; }
#taskList { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
#taskList li { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 12px; background: #14121c; border: 1px solid transparent; }
#taskList li.active { border-color: var(--focus); }
#taskList li.done span { text-decoration: line-through; color: var(--mut); }
#taskList li span { flex: 1; cursor: pointer; }
#taskList li b { color: var(--mut); font-weight: 500; font-size: 12px; }
#taskList button { border: 0; background: none; color: var(--mut); }`),
    S('app.js', 'tasks', `function drawTasks() {
  const list = store.get('tasks'), active = store.get('active');
  const ul = document.getElementById('taskList');
  ul.innerHTML = list.map((t) => '<li class="' + (t.done ? 'done ' : '') + (t.id === active ? 'active' : '') + '" data-id="' + t.id + '"><input type="checkbox"' + (t.done ? ' checked' : '') + ' /><span></span><b>' + t.pomos + ' 🍅</b><button title="Delete">✕</button></li>').join('');
  ul.querySelectorAll('li').forEach((li, i) => { li.querySelector('span').textContent = list[i].title; });
  const cur = list.find((t) => t.id === active);
  document.getElementById('nowTask').textContent = cur ? cur.title : 'No task picked';
}
document.getElementById('taskForm').onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById('taskInput'); const title = input.value.trim(); if (!title) return;
  const t = { id: Date.now().toString(36), title, done: false, pomos: 0 };
  store.set('tasks', [...store.get('tasks'), t]); if (!store.get('active')) store.set('active', t.id);
  input.value = '';
};
document.getElementById('taskList').onclick = (e) => {
  const li = e.target.closest('li'); if (!li) return;
  const id = li.dataset.id; let list = store.get('tasks');
  if (e.target.matches('button')) list = list.filter((t) => t.id !== id);
  else if (e.target.matches('input')) list = list.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  else store.set('active', id);
  store.set('tasks', list);
};
bus.on('change', drawTasks);
bus.on('session', () => { const a = store.get('active'); store.set('tasks', store.get('tasks').map((t) => (t.id === a ? { ...t, pomos: t.pomos + 1 } : t))); });
drawTasks();`),
  ],
  'Session stats: today, streak and weekly bars': [
    S('index.html', 'stats', `<section id="stats" class="card stats">
  <h2>This week</h2>
  <div class="kpis"><div><b id="kToday">0</b><span>sessions today</span></div><div><b id="kMinutes">0</b><span>focus minutes</span></div><div><b id="kStreak">0</b><span>day streak</span></div></div>
  <div class="bars" id="bars"></div>
</section>`),
    S('styles.css', 'stats', `.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 16px; }
.kpis b { display: block; font-size: 28px; letter-spacing: -.02em; }
.kpis span { color: var(--mut); font-size: 12.5px; }
.bars { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; align-items: end; height: 120px; }
.bars div { display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; }
.bars i { width: 100%; border-radius: 8px 8px 4px 4px; background: linear-gradient(var(--gold), var(--focus)); min-height: 4px; transition: height .5s; }
.bars span { font-size: 11px; color: var(--mut); }`),
    S('app.js', 'stats', `function dayKey(d) { return d.toISOString().slice(0, 10); }
function drawStats() {
  const log = store.get('log'), today = new Date();
  const days = [...Array(7)].map((_, i) => { const d = new Date(today); d.setDate(d.getDate() - 6 + i); return d; });
  const counts = days.map((d) => log[dayKey(d)] || 0), max = Math.max(4, ...counts);
  document.getElementById('kToday').textContent = counts[6];
  document.getElementById('kMinutes').textContent = counts.reduce((a, b) => a + b, 0) * 25;
  let streak = 0; for (let i = 6; i >= 0 && counts[i] > 0; i--) streak++;
  document.getElementById('kStreak').textContent = streak;
  document.getElementById('bars').innerHTML = days.map((d, i) => '<div><i style="height:' + Math.round((counts[i] / max) * 100) + '%"></i><span>' + 'SMTWTFS'[d.getDay()] + '</span></div>').join('');
}
bus.on('session', () => { const log = store.get('log'); const k = dayKey(new Date()); log[k] = (log[k] || 0) + 1; store.set('log', log); });
bus.on('change', drawStats);
drawStats();`),
  ],
  'Shared state and persistence': [
    S('app.js', 'state', `const bus = { ev: {}, on(n, f) { (this.ev[n] = this.ev[n] || []).push(f); }, emit(n, x) { (this.ev[n] || []).forEach((f) => f(x)); } };
const store = {
  data: Object.assign({ tasks: [{ id: 'a', title: 'Sketch the launch post', done: false, pomos: 2 }, { id: 'b', title: 'Review pull requests', done: true, pomos: 1 }], active: 'a', log: { [new Date().toISOString().slice(0, 10)]: 3 } }, JSON.parse(localStorage.getItem('tempo') || '{}')),
  get(k) { return this.data[k]; },
  set(k, v) { this.data[k] = v; localStorage.setItem('tempo', JSON.stringify(this.data)); bus.emit('change'); },
};`),
  ],
};

// Marker block for a section, exactly as it appears in the skeleton.
function block(file, section) {
  const sk = design.files.find((f) => f.path === file).skeleton;
  const lines = sk.split('\n');
  const open = lines.findIndex((l) => new RegExp(`section:${section}\\b`).test(l) && !/\/section:/.test(l));
  const close = lines.findIndex((l, i) => i > open && new RegExp(`/section:${section}\\b`).test(l));
  return lines.slice(open, close + 1).join('\n');
}
function filled(file, section, body) {
  const b = block(file, section).split('\n');
  return [b[0], body, b[b.length - 1]].join('\n');
}

module.exports = { design, steps, block, filled };
