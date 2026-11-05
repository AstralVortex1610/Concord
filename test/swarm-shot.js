// Headless Swarm Build run inside the real dashboard: mock models (see swarm-mock-llm.js), real coordinator, real merges,
// real live preview and the real browser check. SHOTS=1 saves screenshots over time; RECORD=dir saves every frame.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');
const { createServer } = require('../src/server/http');
const { Coordinator } = require('../src/core/coordinator');
const { Team } = require('../src/agents/team');
const { Swarm } = require('../src/agents/swarm');
const { makeProbe } = require('../src/probe');
const { startMock } = require('./swarm-mock-llm');
app.disableHardwareAcceleration();
const out = path.join(__dirname, 'shots'); fs.mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const W = +(process.env.W || 1440), H = +(process.env.H || 900);
app.whenReady().then(async () => {
  const { port: mport } = await startMock({ delay: [+(process.env.D0 || 700), +(process.env.D1 || 1500)] });
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'concord-swarm-')), 'tempo');
  fs.mkdirSync(root);
  const c = new Coordinator({ root, persist: false });
  const models = [['claude-opus-5-5', 'anthropic'], ['gpt-6.1-sol', 'openai'], ['deepseek-v4-pro', 'deepseek'], ['qwen3.8-max', 'qwen']];
  const profiles = new Map(models.map(([m, p], i) => ['p' + (i + 1), { style: 'openai', baseUrl: `http://127.0.0.1:${mport}/v1`, apiKey: 'x', model: m, provider: p }]));
  const agents = [['nova', 'Nova', '#ff7a59'], ['atlas', 'Atlas', '#46d6b0'], ['lyra', 'Lyra', '#ffc94d'], ['orion', 'Orion', '#8f7bff']].map(([id, name, color], i) => ({ id, name, color, profileId: 'p' + (i + 1), enabled: true }));
  const team = new Team({ coordinator: c, getAgents: () => agents, getProfiles: () => profiles });
  for (const a of agents) { const p = profiles.get(a.profileId); c.registerAgent({ id: a.id, name: a.name, model: p.model, provider: p.provider, kind: 'builtin', color: a.color }); c.agents.get(a.id).online = false; }
  let port = 0;
  const swarm = new Swarm({ coordinator: c, team, probe: makeProbe(BrowserWindow, () => port) });
  const s = createServer({ getCoordinator: () => c, staticDir: path.join(__dirname, '..', 'renderer'), port: 47500, getSwarm: () => swarm, onSwarmStart: (b) => swarm.start(b) });
  port = await s.listen();
  process.env.CONCORD_PORT = String(port);
  const win = new BrowserWindow({ width: W, height: H, show: false, webPreferences: { offscreen: true, preload: path.join(__dirname, 'mock-preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2) console.log('console:', msg); });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  const js = (code) => win.webContents.executeJavaScript(code);
  const snap = async (name) => { fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('shot', name, swarm.state.phase); };
  if (process.env.LIGHT) await js("document.documentElement.dataset.theme='light'");
  await js("__show('swarm')"); await wait(1500);
  await snap('s0-empty');
  await js(`document.getElementById('swBrief').value = 'A pomodoro focus timer with a task list, session stats and a cosy look'`);
  let rec = null;
  if (process.env.RECORD) {
    const dir = process.env.RECORD; fs.mkdirSync(dir, { recursive: true }); let n = 0;
    win.webContents.setFrameRate(30);
    win.webContents.on('paint', (_e, _d, img) => { fs.writeFileSync(path.join(dir, String(n++).padStart(5, '0') + '.jpg'), img.toJPEG(90)); });
    rec = dir;
  }
  await wait(800);
  await js("document.getElementById('swGo').click()");
  const t0 = Date.now(); let k = 1;
  while (swarm.state.phase !== 'live' && Date.now() - t0 < 180000) { await wait(process.env.SHOTS ? 4000 : 500); if (process.env.SHOTS) await snap('s' + k++ + '-' + swarm.state.phase); }
  await wait(3500); await snap('s9-live');
  console.log('final', JSON.stringify({ phase: swarm.state.phase, ok: swarm.state.ok, issues: swarm.state.issues, stats: c.stats, secs: (Date.now() - t0) / 1000 }));
  await js("document.getElementById('swLive').click()"); await wait(1500); await snap('s10-golive');
  fs.writeFileSync(path.join(out, 'swarm-root.txt'), root);
  app.quit();
});
