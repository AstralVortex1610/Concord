// Live check against a REAL model (not part of npm test).
//   LIVE_BASE=http://127.0.0.1:11434/v1 LIVE_MODEL=qwen2.5:1.5b node test/live-model.js
//   LIVE_STYLE=anthropic LIVE_BASE=https://api.anthropic.com/v1 LIVE_MODEL=... LIVE_KEY=... node test/live-model.js
const fs = require('fs'); const os = require('os'); const path = require('path');
const { Coordinator } = require('../src/core/coordinator');
const { Team } = require('../src/agents/team');
const llm = require('../src/agents/llm');

const profile = { id: 'live', style: process.env.LIVE_STYLE || 'openai', baseUrl: process.env.LIVE_BASE || 'http://127.0.0.1:11434/v1', model: process.env.LIVE_MODEL || 'qwen2.5:1.5b', apiKey: process.env.LIVE_KEY || '', maxTokens: 1024, temperature: 0.2 };
const AGENTS = Number(process.env.LIVE_AGENTS || 1);
const LIMIT = Number(process.env.LIVE_MINUTES || 12) * 60000;

(async () => {
  const t0 = Date.now();
  console.log(`live test: ${profile.model} at ${profile.baseUrl}`);
  console.log('  ping:', (await llm.testProfile(profile)).message);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-live-'));
  fs.writeFileSync(path.join(root, 'math.js'), "// Small math helpers.\nfunction square(x) {\n  return x * x;\n}\n\nmodule.exports = { square };\n");
  fs.writeFileSync(path.join(root, 'check.js'), "const m = require('./math');\nif (m.square(3) !== 9) throw new Error('square broken');\nif (typeof m.cube !== 'function' || m.cube(2) !== 8) throw new Error('cube missing or wrong');\nconsole.log('all good');\n");
  const c = new Coordinator({ root });
  const agents = Array.from({ length: AGENTS }, (_, i) => ({ id: 'live-' + i, name: ['Nova', 'Atlas', 'Echo'][i] || 'A' + i, profileId: 'live', enabled: true, maxSteps: 14, color: '#ff7a59' }));
  const team = new Team({ coordinator: c, getAgents: () => agents, getProfiles: () => new Map([['live', profile]]), getRouting: () => ({ lean: true }), getCommands: () => ({ mode: 'safe', timeoutSec: 60 }) });
  c.createTask({ title: 'Add a cube(x) function to math.js', detail: 'Add function cube(x) that returns x * x * x, export it next to square, then run the command "node check.js" and make sure it prints "all good".', files: ['math.js'], priority: 'high' });
  c.on('event', (e) => { if (e.type === 'agent-log' && e.kind !== 'think') console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${e.agent} ${e.kind}: ${String(e.text).slice(0, 150)}`); if (e.type === 'command') console.log(`  [cmd] ${e.text}`); });
  team.start();
  while (Date.now() - t0 < LIMIT && c.tasks.some((t) => !['done', 'review', 'blocked'].includes(t.status))) await new Promise((r) => setTimeout(r, 2000));
  team.stop();
  await new Promise((r) => setTimeout(r, 3000)); // let the task-finished checkpoint land
  await new Promise((r) => setTimeout(r, 3000)); // let the task-finished checkpoint land
  const text = fs.readFileSync(path.join(root, 'math.js'), 'utf8');
  let verdict = 'FAIL';
  try { delete require.cache[path.join(root, 'math.js')]; const m = require(path.join(root, 'math.js')); verdict = m.cube && m.cube(2) === 8 && m.square(3) === 9 ? 'PASS' : 'FAIL'; } catch (e) { verdict = 'FAIL (' + e.message + ')'; }
  console.log('\n--- math.js ---\n' + text);
  console.log('tasks:', c.tasks.map((t) => `${t.status}: ${t.title}`).join(' | '));
  console.log('stats:', JSON.stringify(c.stats));
  console.log(`checkpoints: ${(await c.listCheckpoints()).length}`);
  console.log(`LIVE RESULT: ${verdict} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  c.close(); process.exit(verdict === 'PASS' ? 0 : 1);
})().catch((e) => { console.error('LIVE ERROR', e); process.exit(2); });
