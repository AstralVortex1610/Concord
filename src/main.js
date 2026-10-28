// Concord desktop app: window, coordinator, local server, built-in agent team, IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, clipboard, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { Coordinator } = require('./core/coordinator');
const { createServer } = require('./server/http');
const { Settings } = require('./settings');
const { Team } = require('./agents/team');
const llm = require('./agents/llm');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let coordinator = null;
let team = null;
let port = 4317;
const settings = new Settings(app.getPath('userData'), safeStorage);
const FEEDBACK_EMAIL = 'affanm2010@gmail.com';

// ---------- log file (Help > Open logs) ----------
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'concord.log');
function logLine(level, msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${String(msg).slice(0, 4000)}\n`);
  } catch { }
}
process.on('uncaughtException', (e) => { logLine('crash', e.stack || e.message); });
process.on('unhandledRejection', (e) => { logLine('error', (e && e.stack) || String(e)); });
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

const server = createServer({
  getCoordinator: () => coordinator,
  staticDir: path.join(__dirname, '..', 'renderer'),
  port: settings.s.port || 4317,
  onPlan: (goal) => planGoal(goal),
  onRestore: (sha) => restoreCheckpoint(sha),
});

async function restoreCheckpoint(sha) {
  if (!coordinator) return { ok: false, message: 'Open a project first.' };
  if (team && team.active) return { ok: false, message: 'Pause the team before restoring a checkpoint.' };
  for (const a of settings.s.agents) coordinator.releaseAll(a.id, 'restoring a checkpoint');
  const r = await coordinator.restoreCheckpoint(sha);
  logLine('info', `restore ${sha}: ${JSON.stringify(r)}`);
  return r;
}

function openProject(dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: false, message: 'That folder does not exist.' };
  if (team) team.stop();
  if (coordinator) { coordinator.close(); coordinator.removeAllListeners(); }
  coordinator = new Coordinator({ root: dir });
  coordinator.on('error-log', (m) => logLine('error', m));
  logLine('info', `opened ${dir} (v${app.getVersion()})`);
  team = new Team({
    coordinator,
    getAgents: () => settings.s.agents,
    getProfiles: () => {
      const m = settings.profilesMap();
      for (const [, p] of m) { const pr = llm.preset(p.provider); p.providerName = pr ? pr.name : p.providerName; }
      return m;
    },
    getRouting: () => settings.s.routing,
    getCommands: () => settings.s.commands,
  });
  coordinator.on('event', (e) => { if (e.type === 'agent-log' && e.kind === 'error') logLine('agent', `${e.agent}: ${e.text}`); });
  for (const a of settings.s.agents) {
    const p = settings.s.profiles.find((x) => x.id === a.profileId);
    coordinator.registerAgent({ id: a.id, name: a.name, model: p ? p.model : '', provider: p ? p.provider : '', kind: 'builtin', color: a.color, role: a.role });
    coordinator.agents.get(a.id).online = false; coordinator.agents.get(a.id).status = 'idle';
  }
  settings.addRecent(dir);
  send('project', { root: dir });
  return { ok: true, root: dir };
}

async function planGoal(goal) {
  if (!team) throw new Error('Open a project first.');
  const n = await team.plan(goal);
  return n;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b0b12', title: 'Concord', icon: ICON,
    frame: false, titleBarStyle: 'hidden', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.once('ready-to-show', () => win.show());
  if (process.env.CONCORD_SMOKE) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const r = await win.webContents.executeJavaScript("JSON.stringify({ view: window.__S && window.__S.view, project: document.getElementById('projectName').textContent, presets: window.__S && window.__S.presets.length, agents: document.querySelectorAll('.lane').length })");
    console.log('SMOKE', r); app.quit();
  }, 2500));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('maximize', () => send('win', { max: true }));
  win.on('unmaximize', () => send('win', { max: false }));
}

// ---------- IPC ----------
const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { ok: false, message: e.message }; } });
h('app:info', () => ({ version: app.getVersion(), port, root: coordinator ? coordinator.root : null, exe: process.execPath, packaged: app.isPackaged, resources: process.resourcesPath, platform: process.platform }));
h('settings:get', () => settings.public());
h('presets', () => llm.PRESETS);
h('project:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open a project folder', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  return openProject(r.filePaths[0]);
});
h('project:open', (dir) => openProject(dir));
h('project:reveal', () => coordinator && shell.openPath(coordinator.root));
h('profile:save', (p) => { const id = settings.saveProfile(p); refreshAgents(); return { ok: true, id }; });
h('profile:delete', (id) => { settings.deleteProfile(id); return { ok: true }; });
h('profile:test', async (p) => {
  const stored = p.id ? settings.profileWithKey(p.id) : null;
  const prof = { ...(stored || {}), ...p, apiKey: p.apiKey || (stored && stored.apiKey) || '' };
  return llm.testProfile(prof);
});
h('profile:models', async (p) => {
  const stored = p.id ? settings.profileWithKey(p.id) : null;
  return { ok: true, models: await llm.listModels({ ...(stored || {}), ...p, apiKey: p.apiKey || (stored && stored.apiKey) || '' }) };
});
h('agent:save', (a) => { const id = settings.saveAgent(a); refreshAgents(); return { ok: true, id }; });
h('agent:delete', (id) => { settings.deleteAgent(id); if (team) team.stopAgent(id); if (coordinator) coordinator.removeAgent(id); return { ok: true }; });
h('routing:save', (r) => { settings.setRouting(r); return { ok: true }; });
h('team:start', () => {
  if (!team) return { ok: false, message: 'Open a project first.' };
  const ready = settings.s.agents.filter((a) => a.enabled && settings.s.profiles.find((p) => p.id === a.profileId));
  if (!ready.length) return { ok: false, message: 'Add an agent with a model connection first (Agents tab).' };
  coordinator.checkpoint('Before the team started', { agent: 'user', kind: 'start' });
  team.start(); return { ok: true, running: true };
});
h('team:stop', () => { if (team) team.stop(); if (coordinator) for (const a of settings.s.agents) { coordinator.releaseAll(a.id, 'team paused'); coordinator.touch(a.id, 'idle'); } return { ok: true, running: false }; });
h('team:status', () => ({ running: !!(team && team.active), logs: team ? Object.fromEntries(team.logs) : {} }));
h('team:plan', async (goal) => ({ ok: true, tasks: await planGoal(goal) }));
h('commands:save', (c) => { settings.setCommands(c); return { ok: true }; });
h('logs:open', () => { fs.mkdirSync(LOG_DIR, { recursive: true }); return shell.openPath(LOG_DIR); });
h('diag', () => {
  const os = require('os');
  let tail = ''; try { tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-30).join('\n'); } catch { }
  return { version: app.getVersion(), electron: process.versions.electron, os: `${os.type()} ${os.release()} ${os.arch()}`, agents: settings.s.agents.length, models: settings.s.profiles.map((p) => p.provider).join(', '), commands: settings.s.commands.mode, project: !!coordinator, logTail: tail.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]'), email: FEEDBACK_EMAIL };
});
h('clip', (t) => { clipboard.writeText(String(t)); return { ok: true }; });
h('open', (u) => shell.openExternal(u));
h('theme', (t) => { settings.set('theme', t); return { ok: true }; });
ipcMain.on('win', (_e, cmd) => { if (!win) return; if (cmd === 'min') win.minimize(); else if (cmd === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize()); else if (cmd === 'close') win.close(); });

function refreshAgents() {
  if (!coordinator) return;
  for (const a of settings.s.agents) {
    const p = settings.s.profiles.find((x) => x.id === a.profileId);
    const cur = coordinator.agents.get(a.id);
    if (cur) Object.assign(cur, { name: a.name, color: a.color, role: a.role, model: p ? p.model : '', provider: p ? p.provider : '', kind: 'builtin' });
    else { coordinator.registerAgent({ id: a.id, name: a.name, model: p ? p.model : '', provider: p ? p.provider : '', kind: 'builtin', color: a.color, role: a.role }); coordinator.agents.get(a.id).online = false; }
  }
  coordinator._event('agent', { agent: 'user', text: 'updated the team', transient: true });
  if (team) team.refresh();
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  logLine('info', `Concord ${app.getVersion()} starting on ${process.platform}`);
  try { port = await server.listen(); }
  catch (e) { logLine('crash', 'server: ' + e.message); dialog.showErrorBox('Concord could not start', `The local server could not start: ${e.message}`); app.quit(); return; }
  if (settings.s.lastProject && fs.existsSync(settings.s.lastProject)) openProject(settings.s.lastProject);
  createWindow();
});
app.on('window-all-closed', () => { if (team) team.stop(); if (coordinator) coordinator.close(); app.quit(); });
