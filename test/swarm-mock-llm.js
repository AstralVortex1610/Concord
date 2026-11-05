// A mock OpenAI-compatible model server that behaves like a real coding model inside Concord:
// the planner returns a product design, builders read files, reserve their section, edit it against the revision
// they read (redoing the edit on fresh text when Concord bounces it), share a memory and finish.
const http = require('http');
const { design, steps, block, filled } = require('./swarm-product');

function lastCall(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const tc = m.tool_calls[m.tool_calls.length - 1];
      const res = messages.slice(i + 1).find((x) => x.role === 'tool' && x.tool_call_id === tc.id);
      let args = {}; try { args = JSON.parse(tc.function.arguments); } catch { }
      return { name: tc.function.name, args, result: res ? String(res.content) : '' };
    }
  }
  return null;
}

function brain(messages) {
  const sys = String(messages[0].content || '');
  if (/lead architect of a swarm/.test(sys)) return { text: JSON.stringify(design) };
  const first = String(messages[1].content || '');
  const title = (/Your task \[[^\]]+\]: (.*)/.exec(first) || [])[1] || '';
  const plan = steps[title];
  const results = messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  const done = results.filter((r) => /Saved as revision|Merged on top/.test(r)).length;
  const last = lastCall(messages);
  if (!plan) return { tool: 'finish_task', args: { summary: 'Checked: nothing to fix.', status: 'done' } };
  if (done >= plan.length) {
    if (!results.some((r) => /Saved to shared memory|remembered/i.test(r)) && last.name !== 'memory_write') return { tool: 'memory_write', args: { kind: 'fact', title: `${title.split(':')[0]} is in place`, body: plan.map((s) => `${s.file}#${s.section}`).join(', ') } };
    return { tool: 'finish_task', args: { summary: `${title}: ${plan.map((s) => s.file + '#' + s.section).join(', ')}.`, status: 'done' } };
  }
  const st = plan[done];
  const say = done === 0 && (!last || last.name !== 'read_file') ? `I'll fill the ${st.section} section${plan.length > 1 ? 's' : ''} for ${title.toLowerCase()}.` : '';
  if (last && last.name === 'reserve' && last.args.path === st.file && /Reserved/.test(last.result)) {
    const rev = +(/revision (\d+)/.exec(last.result) || [0, 0])[1];
    return { text: say, tool: 'edit_file', args: { path: st.file, baseRev: rev, edits: [{ old: block(st.file, st.section), new: filled(st.file, st.section, st.body) }], message: `${st.section} in ${st.file}` } };
  }
  if (last && last.name === 'read_file' && last.args.path === st.file && /revision \d+/.test(last.result)) {
    const ln = new RegExp(`^\\s*(\\d+)\\| .*section:${st.section}\\b`, 'm').exec(last.result);
    const end = new RegExp(`^\\s*(\\d+)\\| .*/section:${st.section}\\b`, 'm').exec(last.result);
    if (ln && end) return { text: say, tool: 'reserve', args: { path: st.file, startLine: +ln[1], endLine: +end[1], reason: st.section } };
    const rev = +(/revision (\d+)/.exec(last.result) || [0, 0])[1];
    return { text: say, tool: 'edit_file', args: { path: st.file, baseRev: rev, edits: [{ old: block(st.file, st.section), new: filled(st.file, st.section, st.body) }], message: `${st.section} in ${st.file}` } };
  }
  return { text: say, tool: 'read_file', args: { path: st.file } };
}

function startMock({ delay = [0, 0] } = {}) {
  let n = 0;
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', async () => {
      const j = JSON.parse(b || '{}');
      res.setHeader('Content-Type', 'application/json');
      if (!req.url.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
      const t = brain(j.messages);
      const ms = delay[0] + Math.random() * (delay[1] - delay[0]);
      if (ms) await new Promise((r) => setTimeout(r, /lead architect/.test(j.messages[0].content) ? ms * 3 : ms));
      n++;
      const msg = { role: 'assistant', content: t.text || '' };
      if (t.tool) msg.tool_calls = [{ id: 'c' + n, type: 'function', function: { name: t.tool, arguments: JSON.stringify(t.args) } }];
      res.end(JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 900 + (n % 7) * 120, completion_tokens: 140 } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

module.exports = { startMock, brain };
