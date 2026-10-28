// Token benchmark: the same 3-agent job on one 400-line file, run with the token saver off and on.
// A scripted mock model plays each agent: read, reserve, edit, verify, edit a shared changelog (forcing a clash), verify, finish.
// We measure every prompt the agents send, and how much of it repeats the previous prompt (what prompt caching makes cheap).
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { Coordinator } = require('../src/core/coordinator');
const { Team } = require('../src/agents/team');

const FUNCS = 24;
function makeFile() {
  let s = '// Shop core\n// changelog start\n// changelog end\n\n';
  for (let i = 0; i < FUNCS; i++) {
    s += `export function f${i}(cart, opts = {}) {\n  return 0;\n`;
    for (let k = 0; k < 13; k++) s += `  // step ${k}: validate input ${i}.${k}, normalise totals, keep currency in paise\n`;
    s += '}\n\n';
  }
  return s;
}

function run(lean) {
  return new Promise((resolve) => {
    const stats = { calls: 0, chars: 0, fresh: 0 };
    const prev = new Map();
    const mock = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const j = JSON.parse(b);
        const msgs = j.messages.map((m) => JSON.stringify(m));
        const tools = JSON.stringify(j.tools || []);
        const title = /Your task \[[^\]]+\]: (.*)/.exec(j.messages[1].content)[1];
        const fn = /f\d+/.exec(title)[0];
        // Prefix that repeats the previous prompt of this agent (tools + identical leading messages).
        const p = prev.get(fn) || [];
        let same = tools.length; let k = 0;
        while (k < msgs.length && k < p.length && msgs[k] === p[k]) same += msgs[k++].length;
        const total = tools.length + msgs.reduce((s, m) => s + m.length, 0);
        stats.calls++; stats.chars += total; stats.fresh += total - (p.length ? same : 0);
        prev.set(fn, msgs);
        const results = j.messages.filter((m) => m.role === 'tool').map((m) => m.content);
        const all = results.join('\n');
        const revs = [...all.matchAll(/revision (\d+)/g)].map((m) => +m[1]);
        const rev = revs[revs.length - 1];
        const step = results.length;
        const last = results[results.length - 1] || '';
        let t;
        const script = [
          () => ({ name: 'read_file', args: { path: 'shop.js' } }),
          ...(lean ? [() => ({ name: 'read_file', args: { path: 'shop.js', symbol: fn } })] : []),
          () => ({ name: 'reserve', args: { path: 'shop.js', symbol: fn, reason: title } }),
          () => ({ name: 'edit_file', args: { path: 'shop.js', baseRev: rev, edits: [{ old: `export function ${fn}(cart, opts = {}) {\n  return 0;`, new: `export function ${fn}(cart, opts = {}) {\n  if (!cart) return 0;\n  return 1;` }], message: `guard ${fn}` } }),
          () => ({ name: 'read_file', args: { path: 'shop.js' } }),
          () => ({ name: 'memory_search', args: { query: 'currency convention' } }),
          () => ({ name: 'edit_file', args: { path: 'shop.js', baseRev: rev, edits: [{ old: '// changelog end', new: `// ${fn}: added guard\n// changelog end` }], message: `log ${fn}` } }),
        ];
        if (step < script.length) t = script[step]();
        else if (/^REJECTED/.test(last)) t = { name: 'edit_file', args: { path: 'shop.js', baseRev: rev, edits: [{ old: '// changelog end', new: `// ${fn}: added guard\n// changelog end` }], message: `log ${fn} (retry)` } };
        else if (!results.slice(script.length).some((r) => /^shop\.js  revision/.test(r))) t = { name: 'read_file', args: { path: 'shop.js' } };
        if (!t) t = { name: 'finish_task', args: { summary: `${fn} done`, status: 'done' } };
        const promptTok = Math.round(total / 4), cachedTok = p.length ? Math.round(same / 4) : 0;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + stats.calls, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }] } }], usage: { prompt_tokens: promptTok, completion_tokens: 40, prompt_tokens_details: { cached_tokens: cachedTok } } }));
      });
    });
    mock.listen(0, async () => {
      const port = mock.address().port;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-tok-'));
      fs.writeFileSync(path.join(root, 'shop.js'), makeFile());
      const c = new Coordinator({ root, persist: false });
      const profiles = new Map([['p', { style: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'mock' }]]);
      const agents = ['nova', 'atlas', 'lyra', 'orion', 'echo', 'vega'].map((id) => ({ id, name: id, profileId: 'p', enabled: true }));
      const team = new Team({ coordinator: c, getAgents: () => agents, getProfiles: () => profiles, getRouting: () => ({ lean }) });
      for (let i = 0; i < 6; i++) c.createTask({ title: `Harden f${i * 4}` });
      team.start();
      const t0 = Date.now();
      while (c.tasks.some((t) => t.status !== 'done') && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
      team.stop();
      const final = fs.readFileSync(path.join(root, 'shop.js'), 'utf8');
      assert(c.tasks.every((t) => t.status === 'done'), 'tasks not done: ' + JSON.stringify(c.tasks.map((t) => [t.title, t.status])));
      assert.strictEqual((final.match(/if \(!cart\) return 0;/g) || []).length, 6, 'every guard landed');
      assert.strictEqual((final.match(/: added guard/g) || []).length, 6, 'every changelog line landed');
      assert(c.stats.tokensIn > 0 && c.stats.calls === stats.calls, 'token meter recorded usage');
      mock.close();
      resolve({ ...stats, conflicts: c.stats.conflicts, meterIn: c.stats.tokensIn, meterCached: c.stats.tokensCached });
    });
  });
}

(async () => {
  console.log('\nTest 7: token saver. Same 6-agent job on a 400-line file, saver off vs on');
  const off = await run(false);
  const on = await run(true);
  const tok = (ch) => Math.round(ch / 4);
  const pct = (a, b) => Math.round(100 * (1 - b / a));
  console.log(`  off: ${off.calls} model calls, ${tok(off.chars).toLocaleString()} prompt tokens, ${tok(off.fresh).toLocaleString()} not repeatable from cache, ${off.conflicts} clashes caught`);
  console.log(`  on:  ${on.calls} model calls, ${tok(on.chars).toLocaleString()} prompt tokens, ${tok(on.fresh).toLocaleString()} not repeatable from cache, ${on.conflicts} clashes caught`);
  console.log(`  ✓ prompt tokens down ${pct(off.chars, on.chars)}%; same result: all 6 guards and 6 changelog lines landed both times`);
  console.log(`  ✓ token meter recorded ${on.meterIn.toLocaleString()} input tokens, ${Math.round(100 * on.meterCached / on.meterIn)}% served from cache`);
  assert(on.chars < off.chars * 0.6, 'token saver should cut prompt tokens by more than 40%');
  fs.writeFileSync(path.join(__dirname, 'token-bench.json'), JSON.stringify({ off, on }, null, 1));
  console.log('\nToken test passed.');
  process.exit(0);
})();
