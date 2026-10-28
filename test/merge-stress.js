// Proof: many agents edit the SAME file at the same time. Zero lost edits allowed.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { Coordinator } = require('../src/core/coordinator');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);
let pass = 0; const ok = (m) => { pass++; console.log('  ✓', m); };

function freshProject(fns) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-'));
  const src = ['// shared.js — everyone edits this file', ''];
  for (const f of fns) src.push(`function ${f}() {`, `  const log = [];`, `  return log;`, `}`, '');
  fs.writeFileSync(path.join(root, 'shared.js'), src.join('\n'));
  return new Coordinator({ root, persist: false });
}

// An agent: reads, thinks (random delay), edits, submits; on reject it re-reads and retries.
async function agentLoop(c, id, rounds, makeEdit, stats) {
  for (let r = 0; r < rounds; r++) {
    for (let attempt = 0; ; attempt++) {
      const f = c.readFile('shared.js', { agent: id });
      await sleep(rnd(15));                       // other agents commit meanwhile
      const edits = makeEdit(f.text, r);
      const res = c.submit({ agent: id, path: 'shared.js', baseRev: f.rev, edits, message: `${id} round ${r}` });
      if (res.ok) { stats.ok++; if (res.rebased) stats.rebased++; break; }
      stats.retries++; stats.reasons[res.reason] = (stats.reasons[res.reason] || 0) + 1;
      if (attempt > 60) throw new Error(`${id} starved: ${res.message}`);
      await sleep(rnd(10));
    }
  }
}

(async () => {
  console.log('\nTest 1: 6 agents, each holds one function in the same file, 25 edits each, fully concurrent');
  {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    const c = freshProject(names.map((n) => 'fn_' + n));
    const stats = { ok: 0, rebased: 0, retries: 0, reasons: {} };
    for (const n of names) { c.registerAgent({ id: n }); const l = c.acquire({ agent: n, path: 'shared.js', symbol: 'fn_' + n }); assert(l.ok, l.message); }
    await Promise.all(names.map((n) => agentLoop(c, n, 25, (text, r) => [{ old: `function fn_${n}() {\n  const log = [];`, new: `function fn_${n}() {\n  const log = [];\n  log.push('${n}-${r}');` }], stats)));
    const final = fs.readFileSync(path.join(c.root, 'shared.js'), 'utf8');
    for (const n of names) for (let r = 0; r < 25; r++) assert(final.includes(`log.push('${n}-${r}');`), `lost edit ${n}-${r}`);
    new Function(final + '\n;return 1')();
    ok(`150/150 edits present, file still valid JS, ${stats.rebased} auto-rebased, ${stats.retries} retries ${JSON.stringify(stats.reasons)}`);
    for (const n of names) { const l = c.leases.find((x) => x.agent === n); const body = final.split('\n').slice(l.start, l.end).join('\n'); assert(body.includes(`function fn_${n}()`) && body.includes(`'${n}-24'`), `lease drifted for ${n}`); }
    ok('every lease still covers exactly its own function after 150 merges');
    c.close();
  }

  console.log('\nTest 2: 5 agents with NO reservations hammer the same file, including the same line');
  {
    const c = freshProject(['shared']);
    const stats = { ok: 0, rebased: 0, retries: 0, reasons: {} };
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    // Everyone inserts their own line right after `const log = [];` — the exact same spot.
    await Promise.all(ids.map((id) => agentLoop(c, id, 20, (text, r) => [{ old: '  const log = [];', new: `  const log = [];\n  log.push('${id}:${r}');` }], stats)));
    const final = fs.readFileSync(path.join(c.root, 'shared.js'), 'utf8');
    let n = 0; for (const id of ids) for (let r = 0; r < 20; r++) { assert(final.includes(`log.push('${id}:${r}');`), `lost ${id}:${r}`); n++; }
    new Function(final + '\n;return 1')();
    ok(`${n}/100 same-spot edits present; real clashes were rejected and retried (${stats.retries} retries ${JSON.stringify(stats.reasons)}), never overwritten`);
    c.close();
  }

  console.log('\nTest 3: a clash is rejected with the fresh text, never silently overwritten');
  {
    const c = freshProject(['f']);
    const base = c.readFile('shared.js');
    const r1 = c.submit({ agent: 'x', path: 'shared.js', baseRev: base.rev, edits: [{ old: '  return log;', new: '  return log.length;' }] });
    const r2 = c.submit({ agent: 'y', path: 'shared.js', baseRev: base.rev, edits: [{ old: '  return log;', new: '  return null;' }] });
    assert(r1.ok && !r2.ok && r2.reason === 'conflict' && r2.current.includes('log.length') && r2.rev === r1.rev);
    ok('second writer got reason=conflict plus the current file at the new revision');
    const r3 = c.submit({ agent: 'z', path: 'shared.js', baseRev: base.rev, edits: [{ old: '// shared.js', new: '// shared.js (z was here)' }] });
    assert(r3.ok && r3.rebased);
    const t = c.readFile('shared.js').text; assert(t.includes('z was here') && t.includes('log.length'));
    ok('a non-overlapping edit from the same old revision auto-rebased and kept both changes');
  }

  console.log('\nTest 4: reservations block other agents, then free up');
  {
    const c = freshProject(['one', 'two']);
    c.registerAgent({ id: 'p' }); c.registerAgent({ id: 'q' });
    assert(c.acquire({ agent: 'p', path: 'shared.js', symbol: 'one' }).ok);
    const clash = c.acquire({ agent: 'q', path: 'shared.js', symbol: 'one' });
    assert(!clash.ok && clash.reason === 'leased');
    const f = c.readFile('shared.js');
    const blocked = c.submit({ agent: 'q', path: 'shared.js', baseRev: f.rev, edits: [{ old: 'function one() {\n  const log = [];', new: 'function one() {\n  const log = [1];' }] });
    assert(!blocked.ok && blocked.reason === 'leased' && blocked.heldBy.agent === 'p');
    const allowed = c.submit({ agent: 'q', path: 'shared.js', baseRev: f.rev, edits: [{ old: 'function two() {\n  const log = [];', new: 'function two() {\n  const log = [2];' }] });
    assert(allowed.ok);
    ok('q cannot claim or edit p’s function, but can edit the next function in the same file');
    c.release({ agent: 'p' });
    const f2 = c.readFile('shared.js');
    assert(c.submit({ agent: 'q', path: 'shared.js', baseRev: f2.rev, edits: [{ old: 'function one() {\n  const log = [];', new: 'function one() {\n  const log = [1];' }] }).ok);
    ok('after release, q can edit it');
    const whole = c.acquire({ agent: 'p', path: 'shared.js' });
    assert(whole.ok, whole.message);
    assert(!c.acquire({ agent: 'q', path: 'shared.js', startLine: 1, endLine: 2 }).ok);
    ok('a whole-file reservation locks every line for everyone else');
  }
  console.log(`\nAll merge tests passed (${pass} checks).`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
