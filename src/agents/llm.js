// Model adapters. One call shape for every provider:
//   chat({ profile, messages, tools, signal }) -> { text, toolCalls: [{ id, name, args }], usage }
// messages use the OpenAI shape (system / user / assistant with tool_calls / tool with tool_call_id).
const PRESETS = require('./providers.json');

const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
const preset = (id) => PRESETS.find((p) => p.id === id);

function parseArgs(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s || '{}'); } catch {
    // Some models wrap JSON in prose or code fences.
    const m = /\{[\s\S]*\}/.exec(String(s || ''));
    if (m) { try { return JSON.parse(m[0]); } catch { } }
    return { _raw: String(s || '') };
  }
}

function errorText(status, j, raw) {
  const e = j && (j.error || j);
  const msg = (e && (e.message || e.msg || (typeof e === 'string' ? e : ''))) || raw.slice(0, 300);
  return `HTTP ${status}: ${msg}`;
}

async function postJSON(url, headers, body, signal, timeoutMs = 180000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const raw = await r.text();
    let j = null; try { j = JSON.parse(raw); } catch { }
    if (!r.ok) { const err = new Error(errorText(r.status, j, raw)); err.status = r.status; throw err; }
    if (!j) throw new Error('The provider returned something that is not JSON: ' + raw.slice(0, 200));
    return j;
  } finally { clearTimeout(t); }
}

// ---------- OpenAI-compatible (most providers) ----------
async function chatOpenAI({ profile, messages, tools, signal, cache, cacheKey }) {
  const url = trimSlash(profile.baseUrl) + '/chat/completions';
  const headers = {};
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  if (/openrouter\.ai/.test(profile.baseUrl)) { headers['HTTP-Referer'] = 'https://github.com/concord-agents'; headers['X-Title'] = 'Concord'; }
  Object.assign(headers, profile.headers || {});
  const body = { model: profile.model, messages: messages.map(cleanOpenAIMsg) };
  if (tools && tools.length && profile.tools !== false) { body.tools = tools; body.tool_choice = 'auto'; }
  if (profile.maxTokens) body.max_tokens = Number(profile.maxTokens);
  // OpenAI routes requests with the same key to the same cache; other providers cache stable prefixes automatically.
  if (cache && cacheKey && /api\.openai\.com/.test(profile.baseUrl)) body.prompt_cache_key = cacheKey;
  if (profile.temperature != null && profile.temperature !== '') body.temperature = Number(profile.temperature);
  const j = await postJSON(url, headers, body, signal);
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  let text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '';
  const toolCalls = (msg.tool_calls || []).map((tc, i) => ({ id: tc.id || `call_${Date.now()}_${i}`, name: tc.function && tc.function.name, args: parseArgs(tc.function && tc.function.arguments) }));
  // Fallback for models without native tool calling: a ```tool {"name":..,"args":..}``` block.
  if (!toolCalls.length && text) {
    const m = /```(?:tool|json)?\s*(\{[\s\S]*?"name"[\s\S]*?\})\s*```/.exec(text);
    if (m) { const a = parseArgs(m[1]); if (a && a.name) { toolCalls.push({ id: `call_${Date.now()}`, name: a.name, args: a.args || a.arguments || {} }); text = text.replace(m[0], '').trim(); } }
  }
  return { text: text || '', toolCalls, usage: normUsage(j.usage), reasoning: msg.reasoning_content || undefined };
}
function cleanOpenAIMsg(m) {
  const o = { role: m.role, content: m.content == null ? '' : m.content };
  if (m.tool_calls) { o.tool_calls = m.tool_calls; if (!o.content) o.content = null; }
  if (m.tool_call_id) o.tool_call_id = m.tool_call_id;
  if (m.role === 'assistant' && m.reasoning_content) o.reasoning_content = m.reasoning_content; // Kimi / DeepSeek thinking models need it echoed back
  if (m.name && m.role === 'tool') o.name = m.name;
  return o;
}

// ---------- Anthropic Messages API (native) ----------
async function chatAnthropic({ profile, messages, tools, signal, cache }) {
  let base = trimSlash(profile.baseUrl || 'https://api.anthropic.com/v1');
  if (!/\/v1$/.test(base) && /api\.anthropic\.com$/.test(base)) base += '/v1';
  const url = base + '/messages';
  const headers = { 'anthropic-version': profile.anthropicVersion || '2023-06-01' };
  if (profile.apiKey) headers['x-api-key'] = profile.apiKey;
  Object.assign(headers, profile.headers || {});
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out = [];
  const push = (role, block) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block); else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') push('user', { type: 'text', text: String(m.content || ' ') });
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: String(m.content) });
      for (const tc of m.tool_calls || []) push('assistant', { type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
    } else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content || '') });
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: 'Begin.' }] });
  const body = { model: profile.model, max_tokens: Number(profile.maxTokens) || 8192, messages: out };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  if (cache && profile.promptCache !== false) {
    // Prompt caching: tools + system are one cached prefix, and the newest turn is a rolling breakpoint,
    // so each step pays full price only for what is new (cached reads cost about a tenth).
    if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    else if (body.tools) body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
    const last = out[out.length - 1]; const blk = last && last.content[last.content.length - 1];
    if (blk) blk.cache_control = { type: 'ephemeral' };
  }
  const j = await postJSON(url, headers, body, signal);
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = (j.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
  return { text, toolCalls, usage: normUsage(j.usage) };
}

// One usage shape for every provider: { input, cached, output } where input includes cached tokens.
function normUsage(u) {
  if (!u) return null;
  if (u.input_tokens != null) { // Anthropic: input_tokens excludes cache reads and writes
    const cached = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0;
    return { input: u.input_tokens + cached + write, cached, output: u.output_tokens || 0 };
  }
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || u.cached_tokens || 0;
  return { input: u.prompt_tokens || 0, cached, output: u.completion_tokens || 0 };
}

// Retry what is worth retrying: rate limits, overloaded or flaky servers, dropped connections.
async function chat(opts) {
  const waits = [2000, 6000, 15000];
  for (let i = 0; ; i++) {
    try { return await chatOnce(opts); }
    catch (e) {
      const retryable = e.status === 429 || e.status === 408 || e.status === 409 || (e.status >= 500 && e.status < 600) || (!e.status && e.name !== 'AbortError' && !/Pick a model|no base URL/.test(e.message));
      if (!retryable || i >= waits.length || (opts.signal && opts.signal.aborted)) throw e;
      await new Promise((r) => { const t = setTimeout(r, waits[i]); if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
    }
  }
}
async function chatOnce(opts) {
  const style = opts.profile.style || (preset(opts.profile.provider) || {}).style || 'openai';
  if (!opts.profile.model) throw new Error('Pick a model for this agent first.');
  if (!opts.profile.baseUrl && style !== 'anthropic') throw new Error('This agent has no base URL.');
  return style === 'anthropic' ? chatAnthropic(opts) : chatOpenAI(opts);
}

async function testProfile(profile) {
  const t0 = Date.now();
  try {
    const r = await chatOnce({ profile: { ...profile, maxTokens: 20 }, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] });
    return { ok: true, ms: Date.now() - t0, message: `${profile.model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s: “${String(r.text).trim().slice(0, 40)}”` };
  } catch (e) { return { ok: false, message: e.message }; }
}

async function listModels(profile) {
  const style = profile.style || 'openai';
  const base = trimSlash(profile.baseUrl || (style === 'anthropic' ? 'https://api.anthropic.com/v1' : ''));
  const headers = style === 'anthropic' ? { 'x-api-key': profile.apiKey, 'anthropic-version': '2023-06-01' } : (profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {});
  const r = await fetch(base + '/models', { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).slice(0, 300);
}

module.exports = { chat, testProfile, listModels, PRESETS, preset, normUsage };
