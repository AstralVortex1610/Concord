// Built-in agents end to end, against mock OpenAI-compatible and mock Anthropic servers.
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { Coordinator } = require('../src/core/coordinator');
const { Team } = require('../src/agents/team');

// The "model": reads the conversation and decides the next tool call.
function brain(texts, taskTitle) {
  const fn = /function (\w+)/.exec(taskTitle)[1];
  const all = texts.join('\n');
  if (!/revision \d+/.test(all)) return { name: 'read_file', args: { path: 'app.js' } };
  if (!/Reserved function/.test(all)) return { name: 'reserve', args: { path: 'app.js', symbol: fn, reason: taskTitle } };
  if (!/Saved as revision|Merged on top/.test(all)) {
    const revs = [...all.matchAll(/revision (\d+)/g)].map((m) => +m[1]);
    return { name: 'edit_file', args: { path: 'app.js', baseRev: revs[revs.length - 1], edits: [{ old: `function ${fn}() {\n  return 0;`, new: `function ${fn}() {\n  // implemented by agent\n  return 42;` }], message: `implement ${fn}` } };
  }
  if (!/Saved to shared memory/.test(all)) return { name: 'memory_write', args: { kind: 'convention', title: `${fn} returns 42`, body: 'agreed' } };
  return { name: 'finish_task', args: { summary: `Implemented ${fn}.`, status: 'done' } };
}
let calls = { openai: 0, anthropic: 0 };
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    const j = JSON.parse(b);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/chat/completions')) {
      calls.openai++;
      assert(req.headers.authorization === 'Bearer sk-test');
      const task = j.messages[1].content; const title = /Your task \[[^\]]+\]: (.*)/.exec(task)[1];
      const texts = j.messages.filter((m) => m.role === 'tool').map((m) => m.content);
      const t = brain(texts, title);
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + calls.openai, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }] } }] }));
    }
    if (req.url.endsWith('/messages')) {
      calls.anthropic++;
      assert(req.headers['x-api-key'] === 'ak-test' && req.headers['anthropic-version'] && j.system && j.max_tokens);
      const first = j.messages[0].content.find((c) => c.type === 'text').text; const title = /Your task \[[^\]]+\]: (.*)/.exec(first)[1];
      const texts = j.messages.flatMap((m) => m.content.filter((c) => c.type === 'tool_result').map((c) => c.content));
      const t = brain(texts, title);
      return res.end(JSON.stringify({ content: [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'tu' + calls.anthropic, name: t.name, input: t.args }], stop_reason: 'tool_use' }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
mock.listen(0, async () => {
  const port = mock.address().port;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-team-'));
  fs.writeFileSync(path.join(root, 'app.js'), 'function alpha() {\n  return 0;\n}\n\nfunction beta() {\n  return 0;\n}\n\nfunction gamma() {\n  return 0;\n}\n');
  const c = new Coordinator({ root, persist: false });
  const profiles = new Map([
    ['p1', { style: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'mock-gpt' }],
    ['p2', { style: 'anthropic', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'ak-test', model: 'mock-claude' }],
  ]);
  const agents = [{ id: 'nova', name: 'Nova', profileId: 'p1', enabled: true }, { id: 'atlas', name: 'Atlas', profileId: 'p2', enabled: true }, { id: 'echo', name: 'Echo', profileId: 'p1', enabled: true }];
  const team = new Team({ coordinator: c, getAgents: () => agents, getProfiles: () => profiles });
  for (const f of ['alpha', 'beta', 'gamma']) c.createTask({ title: `Implement function ${f}` });
  console.log('\nTest 6: 3 built-in agents (OpenAI-style and native Anthropic) take tasks from the board and edit one file together');
  team.start();
  const t0 = Date.now();
  while (c.tasks.some((t) => t.status !== 'done') && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
  team.stop();
  const final = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert(c.tasks.every((t) => t.status === 'done'), JSON.stringify(c.tasks.map((t) => [t.title, t.status, t.notes])));
  assert((final.match(/return 42/g) || []).length === 3, final);
  assert(calls.openai > 0 && calls.anthropic > 0);
  assert(c.leases.length === 0);
  console.log(`  ✓ all 3 tasks done, all 3 functions implemented in the shared file (${calls.openai} OpenAI calls, ${calls.anthropic} Anthropic calls)`);
  console.log(`  ✓ shared memory has ${c.memory.items.length} conventions; reservations released after finishing`);
  console.log('\nTeam test passed.');
  mock.close(); process.exit(0);
});
