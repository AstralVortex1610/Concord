// Fake desktop bridge for headless screenshots.
const { contextBridge } = require('electron');
const presets = require('../src/agents/providers.json');
const profiles = [
  { id: 'p1', name: 'Claude Opus', provider: 'anthropic', style: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', hasKey: true, keyHint: '••••9f2a' },
  { id: 'p2', name: 'GPT', provider: 'openai', style: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', hasKey: true, keyHint: '••••k3Qe' },
  { id: 'p3', name: 'DeepSeek', provider: 'deepseek', style: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro', hasKey: true, keyHint: '••••77b1' },
  { id: 'p4', name: 'Qwen', provider: 'qwen', style: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', hasKey: true, keyHint: '••••a01c' },
  { id: 'p5', name: 'Local Ollama', provider: 'ollama', style: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', hasKey: false, keyHint: '' },
];
const agents = [
  { id: 'nova', name: 'Nova', role: 'Architect: plans and reviews', profileId: 'p1', enabled: true, color: '#ff7a59' },
  { id: 'atlas', name: 'Atlas', role: 'Backend and API', profileId: 'p2', enabled: true, color: '#46d6b0' },
  { id: 'lyra', name: 'Lyra', role: 'Frontend and styles', profileId: 'p3', enabled: true, color: '#ffc94d' },
  { id: 'orion', name: 'Orion', role: 'Writes tests', profileId: 'p4', enabled: true, color: '#8f7bff' },
];
const settings = { profiles, agents, routing: { enabled: true, planning: 'p1', small: 'p5', review: 'p3' }, commands: { mode: 'safe', timeoutSec: 120 }, recent: ['C:\\Users\\Affan\\code\\nebula-shop', 'C:\\Users\\Affan\\code\\orbit'] };
const ok = async (x) => x;
contextBridge.exposeInMainWorld('desktop', {
  info: ok.bind(null, { version: '0.3.0-beta.1', port: Number(process.env.CONCORD_PORT || 4317), exe: 'C:\\Users\\Affan\\Apps\\Concord\\Concord.exe', resources: 'C:\\Users\\Affan\\Apps\\Concord\\resources', packaged: true }),
  settings: ok.bind(null, settings), presets: ok.bind(null, presets),
  pickProject: ok.bind(null, { ok: false }), openProject: ok.bind(null, { ok: true }), revealProject: ok, saveProfile: ok, deleteProfile: ok,
  testProfile: ok.bind(null, { ok: true, message: 'claude-opus-5-5 answered in 0.8s: “ready”' }), listModels: ok.bind(null, { ok: true, models: [] }),
  saveAgent: ok, deleteAgent: ok, saveRouting: ok, startTeam: ok.bind(null, { ok: true }), stopTeam: ok.bind(null, { ok: true }),
  teamStatus: ok.bind(null, { running: true, logs: {} }), plan: ok.bind(null, { ok: true, tasks: 5 }), copy: ok, open: ok, saveCommands: ok, openLogs: ok, diag: ok.bind(null, { version: '0.3.0-beta.1', electron: '38.2.0', os: 'Windows_NT 10.0.26100 x64', agents: 4, models: 'anthropic, openai, deepseek, qwen, ollama', commands: 'safe', logTail: '', email: 'affanm2010@gmail.com' }), setTheme: ok, win: () => {}, on: () => {},
});
