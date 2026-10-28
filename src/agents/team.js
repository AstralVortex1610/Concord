// Built-in agents. Each agent picks tasks from the shared board and works through the same tools external agents use.
const { chat } = require('./llm');
const { runTool, openAITools } = require('../core/tools');
const { runCommand, RUN_TOOL } = require('../core/commands');

const FINISH = { name: 'finish_task', description: 'Call when your task is complete (or you are blocked). Gives a short summary for the board and releases your reservations.', parameters: { type: 'object', properties: { summary: { type: 'string' }, status: { type: 'string', description: 'done, review or blocked' } }, required: ['summary'] } };

const SYSTEM = (agent, c, canRun) => `You are ${agent.name}, one of several AI coding agents working at the same time in one shared project through Concord.
${agent.role ? 'Your role: ' + agent.role + '\n' : ''}
How Concord works:
- Other agents edit the same files at the same time. Never assume a file is unchanged: read it, note its revision, then edit with that baseRev.
- Before changing code, reserve the smallest scope you need (a function with symbol, or a line range). Never edit lines reserved by someone else; pick other work or coordinate through the board.
- If an edit is REJECTED you get the fresh file. Redo your change on the fresh text. Never paste old content over new content.
- Use edit_file with exact, unique "old" snippets copied from read_file output (without the line-number prefix).
- Save decisions, conventions and lessons with memory_write so the others learn them. Check memory_search before deciding something the team may have decided already.
- Keep tasks small. If your task is big, split it with task_create so others can help.
${canRun ? "- Use run_command to run the project's tests or build after your changes, and fix what breaks before you finish.\n" : ''}- When done, call finish_task with a one-paragraph summary.
Project: ${c.root}`;

class Team {
  constructor({ coordinator, getAgents, getProfiles, getRouting, getCommands, log }) {
    this.getCommands = getCommands || (() => ({ mode: 'off' }));
    this.c = coordinator;
    this.getAgents = getAgents;       // () => [{ id, name, role, profileId, enabled, maxSteps }]
    this.getProfiles = getProfiles;   // () => Map(id -> { style, baseUrl, apiKey, model, ... })
    this.getRouting = getRouting || (() => ({}));
    this.log = log || (() => {});
    this.running = new Map();         // agentId -> { abort, task }
    this.active = false;
    this.logs = new Map();            // agentId -> recent lines
  }

  _say(agent, kind, text, extra = {}) {
    const line = { at: Date.now(), agent, kind, text: String(text || '').slice(0, 4000), ...extra };
    const arr = this.logs.get(agent) || []; arr.push(line); if (arr.length > 300) arr.splice(0, 100); this.logs.set(agent, arr);
    this.c.emit('event', { id: 'x' + Math.random().toString(36).slice(2), type: 'agent-log', transient: true, ...line });
  }

  profileFor(agent, task) {
    const profiles = this.getProfiles();
    const r = this.getRouting() || {};
    let pid = agent.profileId;
    if (r.enabled) {
      const small = task && (task.priority === 'low' || (task.detail || '').length < 160 && /rename|typo|comment|small|tweak|fix/i.test(task.title));
      if (task && task.kind === 'plan' && r.planning) pid = r.planning;
      else if (small && r.small) pid = r.small;
      else if (task && /review|test/i.test(task.title) && r.review) pid = r.review;
    }
    const p = profiles.get(pid) || profiles.get(agent.profileId);
    if (!p) throw new Error(`${agent.name} has no model connection. Pick one in Agents.`);
    return { ...p, id: pid };
  }

  lean() { const r = this.getRouting() || {}; return r.lean !== false; }

  start() { this.active = true; for (const a of this.getAgents()) if (a.enabled) this._spawn(a); }
  stop() { this.active = false; for (const [, r] of this.running) r.abort.abort(); this.running.clear(); }
  stopAgent(id) { const r = this.running.get(id); if (r) { r.abort.abort(); this.running.delete(id); } }
  refresh() { if (!this.active) return; for (const a of this.getAgents()) { if (a.enabled && !this.running.has(a.id)) this._spawn(a); if (!a.enabled) this.stopAgent(a.id); } }

  _spawn(agent) {
    const abort = new AbortController();
    const slot = { abort, task: null };
    this.running.set(agent.id, slot);
    let profile = {};
    try { profile = this.getProfiles().get(agent.profileId) || {}; } catch { }
    this.c.registerAgent({ id: agent.id, name: agent.name, model: profile.model, provider: profile.providerName || profile.provider, kind: 'builtin', color: agent.color, role: agent.role });
    (async () => {
      while (this.active && !abort.signal.aborted) {
        const current = this.getAgents().find((x) => x.id === agent.id) || agent;
        const task = this.c.nextTask(agent.id);
        if (!task) { this.c.touch(agent.id, 'idle'); await sleep(2500, abort.signal); continue; }
        slot.task = task.id;
        try { await this.work(current, task, abort.signal); }
        catch (e) {
          if (abort.signal.aborted) break;
          this._say(agent.id, 'error', e.message);
          this.c.updateTask({ agent: agent.id, taskId: task.id, status: 'blocked', note: 'Error: ' + e.message.slice(0, 300) });
          await sleep(4000, abort.signal);
        }
        slot.task = null;
      }
      this.c.touch(agent.id, 'idle');
    })();
  }

  async work(agent, task, signal) {
    const profile = this.profileFor(agent, task);
    this._say(agent.id, 'start', `Picked up “${task.title}” using ${profile.model}`, { task: task.id });
    this.c.touch(agent.id, 'thinking');
    const cmd = this.getCommands() || {};
    const canRun = cmd.mode === 'safe' || cmd.mode === 'all';
    const tools = openAITools(canRun ? [RUN_TOOL, FINISH] : [FINISH]);
    // Token saver (on unless turned off): delta re-reads, outline-first long files, focused rejections, prompt caching, tighter history.
    const lean = this.lean();
    const ctx = { lean, seen: new Map() };
    const cacheKey = `concord-${agent.id}`;
    const messages = [
      { role: 'system', content: SYSTEM(agent, this.c, canRun) },
      { role: 'user', content: `${this.c.briefing(agent.id)}\n\nYour task [${task.id}]: ${task.title}\n${task.detail || ''}${task.files && task.files.length ? '\nLikely files: ' + task.files.join(', ') : ''}\n\nWork on it now using the tools.` },
    ];
    const maxSteps = Number(agent.maxSteps) || 60;
    let lastSig = '', repeats = 0;
    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) throw new Error('stopped');
      this.c.touch(agent.id, 'thinking');
      const r = await chat({ profile, messages, tools, signal, cache: lean, cacheKey });
      this.c.recordUsage(agent.id, r.usage, profile.model);
      if (r.text) this._say(agent.id, 'think', r.text, { task: task.id });
      if (!r.toolCalls.length) {
        messages.push({ role: 'assistant', content: r.text || '' });
        messages.push({ role: 'user', content: 'Continue with tool calls. When the task is complete call finish_task.' });
        if (step > 2 && /done|complete|finished/i.test(r.text || '')) { this.c.updateTask({ agent: agent.id, taskId: task.id, status: 'review', note: r.text.slice(0, 1200) }); return; }
        continue;
      }
      messages.push({ role: 'assistant', content: r.text || '', reasoning_content: r.reasoning, tool_calls: r.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) } })) });
      for (const tc of r.toolCalls) {
        if (tc.name === 'finish_task') {
          const st = ['done', 'review', 'blocked'].includes(tc.args.status) ? tc.args.status : 'done';
          this.c.updateTask({ agent: agent.id, taskId: task.id, status: st, note: tc.args.summary });
          this.c.releaseAll(agent.id, 'task finished');
          this._say(agent.id, 'done', tc.args.summary || 'Finished.', { task: task.id });
          return;
        }
        let result;
        this.c.touch(agent.id, /edit|write/.test(tc.name) ? 'editing' : 'working');
        try {
          if (tc.name === 'run_command') result = await this.runCommand(agent, task, tc.args || {}, signal);
          else result = runTool(this.c, agent.id, tc.name, tc.args, ctx).text;
        }
        catch (e) { result = 'Error: ' + e.message; }
        this._say(agent.id, 'tool', `${tc.name}(${brief(tc.args)})`, { task: task.id, ok: !/^REJECTED|^Error/.test(result), result: result.slice(0, 600) });
        messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: result.slice(0, lean ? 16000 : 24000), _path: tc.args && tc.args.path, _tool: tc.name });
      }
      // Loop guard: a model repeating the exact same call gets a nudge, and is stopped if it keeps going.
      const sig = r.toolCalls.map((tc) => tc.name + JSON.stringify(tc.args || {})).join('|');
      repeats = sig === lastSig ? repeats + 1 : 0; lastSig = sig;
      if (repeats >= 4) { this.c.updateTask({ agent: agent.id, taskId: task.id, status: 'blocked', note: 'Stopped: the model kept repeating the same action. Try a stronger model for this task.' }); this.c.releaseAll(agent.id, 'stuck'); this._say(agent.id, 'error', 'Stopped a repeat loop.', { task: task.id }); return; }
      if (repeats >= 2) messages.push({ role: 'user', content: `You have made the same ${r.toolCalls[0].name} call ${repeats + 1} times in a row and it will not change anything. Do the next step of the task instead.` });
      if (lean) compactLean(messages); else compact(messages);
    }
    this.c.updateTask({ agent: agent.id, taskId: task.id, status: 'review', note: `Stopped after ${maxSteps} steps.` });
  }

  async runCommand(agent, task, args, signal) {
    const cmd = this.getCommands() || {};
    this.c.touch(agent.id, 'running');
    const r = await runCommand(this.c.root, args.command, { mode: cmd.mode, timeoutSec: args.timeoutSec || cmd.timeoutSec || 120, signal });
    this.c._event('command', { agent: agent.id, task: task.id, text: `ran ${String(args.command).slice(0, 80)} → ${r.blocked ? 'blocked' : r.timedOut ? 'timed out' : 'exit ' + r.code}`, ok: r.ok, code: r.code, ms: r.ms });
    if (r.blocked) return 'Error: ' + r.output;
    return `$ ${args.command}\nexit ${r.code}${r.timedOut ? ' (timed out, process stopped)' : ''} in ${(r.ms / 1000).toFixed(1)}s\n${r.output || '(no output)'}`;
  }

  // Turn a goal into board tasks using the planning model.
  async plan(goal, plannerAgent) {
    const t = this.c.createTask({ title: goal, kind: 'plan', detail: 'Break this goal into small tasks for the team.', createdBy: 'user' });
    const agent = plannerAgent || this.getAgents().find((a) => a.enabled) || this.getAgents()[0];
    if (!agent) throw new Error('Add an agent first.');
    this.c.claimTask({ agent: agent.id, taskId: t.id });
    const profile = this.profileFor(agent, t);
    this._say(agent.id, 'start', `Planning “${goal}” with ${profile.model}`);
    const files = this.c.listFiles({}).slice(0, 200).map((f) => f.path).join('\n');
    const r = await chat({ profile, messages: [
      { role: 'system', content: 'You split software goals into small, parallel tasks for a team of coding agents that work at the same time. Each task should touch different files or functions where possible so agents do not wait on each other. Reply with JSON only: {"tasks":[{"title":"...","detail":"what done looks like","files":["path"],"priority":"high|normal|low"}],"conventions":["short rules every agent should follow"]}' },
      { role: 'user', content: `Goal: ${goal}\n\nProject files:\n${files || '(empty project)'}\n\nTeam conventions so far:\n${this.c.recall({ query: 'convention', kind: 'convention' }).map((m) => m.title).join('\n') || 'none'}` },
    ] });
    let j = null;
    try { j = JSON.parse((/\{[\s\S]*\}/.exec(r.text) || ['{}'])[0]); } catch { }
    const list = (j && j.tasks) || [];
    if (!list.length) throw new Error('The planner did not return tasks. Try a stronger planning model.');
    for (const x of list.slice(0, 20)) this.c.createTask({ title: x.title, detail: x.detail, files: x.files, priority: x.priority || 'normal', parent: t.id, createdBy: agent.id });
    for (const cv of (j.conventions || []).slice(0, 8)) this.c.remember({ agent: agent.id, kind: 'convention', title: String(cv) });
    this.c.updateTask({ agent: agent.id, taskId: t.id, status: 'done', note: `Split into ${list.length} tasks.` });
    this._say(agent.id, 'done', `Split the goal into ${list.length} tasks.`);
    return list.length;
  }
}

function brief(a) { const s = JSON.stringify(a || {}); return s.length > 140 ? s.slice(0, 140) + '…' : s; }
function sleep(ms, signal) { return new Promise((r) => { const t = setTimeout(r, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }); }
// Keep context bounded: shorten old tool results.
function compact(messages) {
  let total = messages.reduce((s, m) => s + String(m.content || '').length, 0);
  for (let i = 2; i < messages.length - 6 && total > 90000; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > 400) { total -= m.content.length - 300; m.content = m.content.slice(0, 300) + '\n…(older output trimmed; read the file again for current text)'; }
  }
}

// Token saver history: cut rarely but deeply, so the cached prompt prefix stays valid between cuts.
// 1) an older read of a file that was read again later is replaced by a one-line stub;
// 2) other old tool output is shortened; the last 6 messages always stay whole.
const LEAN_BUDGET = 48000, LEAN_TARGET = 26000;
function compactLean(messages) {
  const size = () => messages.reduce((s, m) => s + String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
  if (size() <= LEAN_BUDGET) return false;
  const keepFrom = messages.length - 6;
  const lastRead = new Map();
  messages.forEach((m, i) => { if (m.role === 'tool' && m._path && /read_file|edit_file|write_file/.test(m._tool)) lastRead.set(m._path, i); });
  for (let i = 2; i < keepFrom; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || m._stub) continue;
    if (m._path && lastRead.get(m._path) > i && m.content.length > 200) { m.content = `[older view of ${m._path}; superseded by a later read below]`; m._stub = true; }
  }
  for (let i = 2; i < keepFrom && size() > LEAN_TARGET; i++) {
    const m = messages[i];
    if (m.role === 'tool' && !m._stub && m.content.length > 500) { m.content = m.content.slice(0, 260) + '\n…(trimmed to save tokens; read again if you need it)'; m._stub = true; }
    if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) { const a = tc.function.arguments; if (a.length > 600) { let pth = ''; try { pth = JSON.parse(a).path || ''; } catch { } tc.function.arguments = JSON.stringify({ _note: 'arguments trimmed', path: pth }); } }
  }
  return true;
}

module.exports = { Team, compactLean };
