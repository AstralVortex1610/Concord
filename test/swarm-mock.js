// Swarm Build end to end: a planner designs a product, 4 agents build it in parallel through Concord (the same
// files at the same time), Concord checks it, and the result is a real, complete, working set of files.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { Coordinator } = require('../src/core/coordinator');
const { Team } = require('../src/agents/team');
const { Swarm } = require('../src/agents/swarm');
const { startMock } = require('./swarm-mock-llm');
const { design, steps } = require('./swarm-product');

(async () => {
  console.log('\nTest 8: Swarm Build — one brief, 4 agents, one real product, zero lost edits');
  const { server, port } = await startMock({ delay: [5, 40] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-swarm-'));
  const c = new Coordinator({ root, persist: false });
  const profiles = new Map([['p1', { style: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'mock-model' }]]);
  const agents = ['nova', 'atlas', 'lyra', 'orion'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), profileId: 'p1', enabled: true }));
  const team = new Team({ coordinator: c, getAgents: () => agents, getProfiles: () => profiles });
  const sw = new Swarm({ coordinator: c, team });
  const phases = [];
  c.on('event', (e) => { if (e.type === 'swarm') phases.push(e.phase); });
  await sw.start('A pomodoro focus timer with tasks and stats');
  const t0 = Date.now();
  while (sw.state.phase !== 'live' && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100));
  team.stop(); server.close();
  assert.strictEqual(sw.state.phase, 'live', 'swarm should finish, got ' + sw.state.phase + ' ' + JSON.stringify(sw.state.issues));
  assert.ok(sw.state.ok, 'product should pass checks: ' + JSON.stringify(sw.state.issues));
  // Every section every agent wrote is in the files on disk: nothing was overwritten.
  let sections = 0;
  for (const list of Object.values(steps)) for (const s of list) { const text = fs.readFileSync(path.join(root, s.file), 'utf8'); assert.ok(text.includes(s.body), `missing ${s.file}#${s.section}`); sections++; }
  // The JavaScript is valid and the HTML links resolve.
  new Function(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  assert.deepStrictEqual(sw.staticIssues(), []);
  const owners = new Set(c.tasks.filter((t) => t.parent === sw.state.rootTask).map((t) => t.owner));
  console.log(`  phases: ${[...new Set(phases)].join(' → ')}`);
  console.log(`  ${sections} sections in 3 shared files by ${owners.size} agents · commits ${c.stats.commits}, auto-merged ${c.stats.rebased}, clashes caught ${c.stats.conflicts + c.stats.blocked}`);
  assert.ok(owners.size >= 3, 'several agents should have built it');
  assert.ok(c.stats.rebased > 0, 'agents should have edited the same files at the same time');
  // A broken product is caught and sent back as a fix task.
  fs.writeFileSync(path.join(root, 'index.html'), fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('</body>', '<script src="missing.js"></script>\n</body>'));
  await new Promise((r) => setTimeout(r, 50));
  c.readFile('index.html');
  const issues = sw.staticIssues();
  assert.ok(issues.some((i) => /missing\.js/.test(i.message)), 'missing file should be caught');
  console.log(`  broken link caught: ${issues[0].message}`);
  console.log('  PASS');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
