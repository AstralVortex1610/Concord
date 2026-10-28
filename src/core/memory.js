// Shared project memory with BM25 search. Every agent reads and writes the same store.
const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were will with we you i our use used using'.split(' '));
const tokenize = (t) => String(t || '').toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9_]+/).flatMap((w) => w.split('_')).filter((w) => w.length > 1 && !STOP.has(w));

class Memory {
  constructor(items = []) { this.items = items; }
  add({ kind = 'fact', title = '', body = '', tags = [], agent = 'user', files = [] }) {
    const item = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, title: String(title).slice(0, 200), body: String(body).slice(0, 8000), tags: [].concat(tags || []).map(String).slice(0, 12), files: [].concat(files || []).map(String), agent, at: Date.now() };
    this.items.push(item);
    return item;
  }
  update(id, patch) { const it = this.items.find((x) => x.id === id); if (!it) return null; Object.assign(it, patch, { id, at: Date.now() }); return it; }
  remove(id) { const n = this.items.length; this.items = this.items.filter((x) => x.id !== id); return this.items.length < n; }
  search(query, { limit = 8, kind } = {}) {
    const pool = kind ? this.items.filter((x) => x.kind === kind) : this.items;
    const q = tokenize(query);
    if (!q.length) return pool.slice(-limit).reverse();
    const docs = pool.map((it) => {
      const toks = tokenize([it.title, it.title, it.body, it.tags.join(' '), it.tags.join(' '), it.files.join(' '), it.kind].join(' '));
      const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      return { it, tf, len: toks.length };
    });
    const N = docs.length || 1, avg = docs.reduce((s, d) => s + d.len, 0) / N || 1;
    const df = new Map(); for (const t of new Set(q)) df.set(t, docs.filter((d) => d.tf.has(t) || [...d.tf.keys()].some((k) => k.startsWith(t) && t.length > 3)).length);
    const k1 = 1.4, b = 0.75;
    const scored = docs.map((d) => {
      let s = 0;
      for (const t of q) {
        let f = d.tf.get(t) || 0;
        if (!f && t.length > 3) for (const [k, v] of d.tf) if (k.startsWith(t)) f += v * 0.6;
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg));
      }
      s *= 1 + 0.15 * Math.exp(-(Date.now() - d.it.at) / 864e5 / 14); // gentle recency boost
      return { ...d.it, score: +s.toFixed(3) };
    }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score);
    return scored.slice(0, limit);
  }
}
module.exports = { Memory, tokenize };
