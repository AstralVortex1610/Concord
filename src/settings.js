// App settings: model connections (keys encrypted with Windows DPAPI via safeStorage), agents, routing, recent projects.
const fs = require('fs');
const path = require('path');

const AGENT_COLORS = ['#ff7a59', '#46d6b0', '#ffc94d', '#8f7bff', '#ff5fa2', '#4fb3ff', '#b6e35a', '#ff9f43'];
const AGENT_NAMES = ['Nova', 'Atlas', 'Echo', 'Lyra', 'Orion', 'Vega', 'Juno', 'Rhea', 'Sol', 'Iris'];
const uid = (p) => p + Math.random().toString(36).slice(2, 8);

class Settings {
  constructor(dir, safe) {
    this.file = path.join(dir, 'settings.json');
    this.safe = safe;
    fs.mkdirSync(dir, { recursive: true });
    try { this.s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.s = {}; }
    this.s = Object.assign({ profiles: [], agents: [], routing: { enabled: false }, commands: { mode: 'safe', timeoutSec: 120 }, recent: [], lastProject: null, port: 4317, theme: 'dark' }, this.s);
  }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.s, null, 1)); fs.renameSync(tmp, this.file); }
  _enc(v) { if (!v) return ''; try { if (this.safe && this.safe.isEncryptionAvailable()) return 'enc:' + this.safe.encryptString(v).toString('base64'); } catch { } return 'b64:' + Buffer.from(v).toString('base64'); }
  _dec(v) { if (!v) return ''; try { if (v.startsWith('enc:')) return this.safe.decryptString(Buffer.from(v.slice(4), 'base64')); if (v.startsWith('b64:')) return Buffer.from(v.slice(4), 'base64').toString(); } catch { } return ''; }

  // What the renderer may see: never the keys.
  public() {
    return {
      ...this.s,
      profiles: this.s.profiles.map(({ apiKeyEnc, ...p }) => ({ ...p, hasKey: !!apiKeyEnc, keyHint: apiKeyEnc ? '••••' + (this._dec(apiKeyEnc).slice(-4) || '') : '' })),
    };
  }
  profilesMap() { return new Map(this.s.profiles.map((p) => [p.id, { ...p, apiKey: this._dec(p.apiKeyEnc), apiKeyEnc: undefined }])); }
  profileWithKey(id) { return this.profilesMap().get(id); }

  saveProfile(p) {
    const cur = this.s.profiles.find((x) => x.id === p.id);
    const next = { id: p.id || uid('p'), name: p.name || p.model || 'Model', provider: p.provider || 'custom', providerName: p.providerName || '', style: p.style || 'openai', baseUrl: (p.baseUrl || '').trim(), model: (p.model || '').trim(), maxTokens: p.maxTokens || '', temperature: p.temperature ?? '', tools: p.tools !== false, apiKeyEnc: cur ? cur.apiKeyEnc : '' };
    if (typeof p.apiKey === 'string' && p.apiKey.trim()) next.apiKeyEnc = this._enc(p.apiKey.trim());
    if (p.clearKey) next.apiKeyEnc = '';
    if (cur) Object.assign(cur, next); else this.s.profiles.push(next);
    this.save();
    return next.id;
  }
  deleteProfile(id) { this.s.profiles = this.s.profiles.filter((p) => p.id !== id); for (const a of this.s.agents) if (a.profileId === id) a.profileId = ''; this.save(); }

  saveAgent(a) {
    const cur = this.s.agents.find((x) => x.id === a.id);
    const n = this.s.agents.length;
    const next = { id: a.id || (String(a.name || AGENT_NAMES[n % AGENT_NAMES.length]).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Math.random().toString(36).slice(2, 5)), name: a.name || AGENT_NAMES[n % AGENT_NAMES.length], role: a.role || '', profileId: a.profileId || '', enabled: a.enabled !== false, color: a.color || AGENT_COLORS[n % AGENT_COLORS.length], maxSteps: Number(a.maxSteps) || 60 };
    if (cur) Object.assign(cur, next); else this.s.agents.push(next);
    this.save();
    return next.id;
  }
  deleteAgent(id) { this.s.agents = this.s.agents.filter((a) => a.id !== id); this.save(); }
  setRouting(r) { this.s.routing = { enabled: !!r.enabled, lean: r.lean !== false, planning: r.planning || '', small: r.small || '', review: r.review || '' }; this.save(); }
  setCommands(c) { const mode = ['off', 'safe', 'all'].includes(c.mode) ? c.mode : 'safe'; this.s.commands = { mode, timeoutSec: Math.min(900, Math.max(10, Number(c.timeoutSec) || 120)) }; this.save(); }
  addRecent(dir) { this.s.recent = [dir, ...this.s.recent.filter((d) => d !== dir)].slice(0, 8); this.s.lastProject = dir; this.save(); }
  set(k, v) { this.s[k] = v; this.save(); }
}

module.exports = { Settings, AGENT_COLORS, AGENT_NAMES };
