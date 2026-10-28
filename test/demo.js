// Seeds a demo project and simulates a busy team (built-in + MCP agents) editing the same files.
const fs = require('fs'), os = require('os'), path = require('path');
const { Coordinator } = require('../src/core/coordinator');

function seed(root) {
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'cart.js'), `// cart.js — shopping cart logic shared by web and mobile
import { taxFor } from './tax.js';

export function addItem(cart, item, qty = 1) {
  const line = cart.lines.find((l) => l.sku === item.sku);
  if (line) line.qty += qty;
  else cart.lines.push({ sku: item.sku, price: item.price, qty });
  return cart;
}

export function removeItem(cart, sku) {
  cart.lines = cart.lines.filter((l) => l.sku !== sku);
  return cart;
}

export function subtotal(cart) {
  return cart.lines.reduce((s, l) => s + l.price * l.qty, 0);
}

export function total(cart, region) {
  const sub = subtotal(cart);
  return Math.round((sub + taxFor(region, sub)) * 100) / 100;
}

export function applyCoupon(cart, code) {
  if (!code) return cart;
  cart.coupon = code.trim().toUpperCase();
  return cart;
}
`);
  fs.writeFileSync(path.join(root, 'src', 'api.py'), `from fastapi import FastAPI
app = FastAPI()

def checkout(cart_id: str):
    cart = load(cart_id)
    return {"ok": True, "total": cart.total}

def refund(order_id: str):
    return {"ok": False}
`);
  fs.writeFileSync(path.join(root, 'src', 'tax.js'), `export function taxFor(region, amount) {\n  const rates = { IN: 0.18, US: 0.07 };\n  return amount * (rates[region] || 0);\n}\n`);
  fs.writeFileSync(path.join(root, 'src', 'ui', 'theme.css'), `:root {\n  --brand: #ff7a59;\n  --ink: #0b0b12;\n}\n`);
  fs.writeFileSync(path.join(root, 'tests', 'cart.test.js'), `import { addItem } from '../src/cart.js';\n\ntest('adds', () => {\n  expect(addItem({ lines: [] }, { sku: 'a', price: 2 }).lines.length).toBe(1);\n});\n`);
  fs.writeFileSync(path.join(root, 'README.md'), '# Nebula Shop\nA tiny store our agents are building together.\n');
}

function setup(root) {
  seed(root);
  const c = new Coordinator({ root, persist: false });
  const A = [
    ['nova', 'Nova', 'claude-opus-5-5', 'anthropic', 'builtin', '#ff7a59'],
    ['atlas', 'Atlas', 'gpt-6.1-sol', 'openai', 'builtin', '#46d6b0'],
    ['lyra', 'Lyra', 'deepseek-v4-pro', 'deepseek', 'builtin', '#ffc94d'],
    ['orion', 'Orion', 'qwen3.8-max', 'qwen', 'builtin', '#8f7bff'],
    ['claude-code', 'claude-code', 'Claude Code 3.1', 'MCP', 'external', '#ff5fa2'],
    ['cursor', 'cursor', 'Cursor 2.4', 'MCP', 'external', '#4fb3ff'],
  ];
  for (const [id, name, model, provider, kind, color] of A) c.registerAgent({ id, name, model, provider, kind, color });
  const T = (title, detail, status, owner, priority = 'normal', files = []) => { const t = c.createTask({ title, detail, priority, files, createdBy: 'nova' }); if (owner) { c.claimTask({ agent: owner, taskId: t.id }); } if (status !== 'working') c.updateTask({ agent: owner || 'nova', taskId: t.id, status, note: status === 'done' ? 'Shipped and tested.' : undefined }); if (status === 'todo') { t.owner = null; } return t; };
  T('Support quantity in addItem', 'Merge duplicate SKUs, clamp qty to 1..99', 'working', 'nova', 'high', ['src/cart.js']);
  T('Round totals per region', 'Use banker’s rounding for IN and US', 'working', 'atlas', 'normal', ['src/cart.js']);
  T('Coupon validation', 'Reject expired codes, max one per cart', 'working', 'claude-code', 'high', ['src/cart.js']);
  T('Checkout endpoint', 'POST /checkout returns order id', 'working', 'cursor', 'normal', ['src/api.py']);
  T('Dark theme tokens', 'Match the Concord palette', 'working', 'lyra', 'low', ['src/ui/theme.css']);
  T('Cart unit tests', 'Cover add, remove, total, coupons', 'working', 'orion', 'normal', ['tests/cart.test.js']);
  T('Refund flow', 'Partial refunds by line', 'todo', null, 'normal', ['src/api.py']);
  T('Wishlist API', 'Save for later', 'todo', null, 'low');
  T('Currency formatting', 'INR and USD with Intl', 'todo', null, 'normal', ['src/ui/format.js']);
  T('Tax table for EU', '', 'review', 'atlas', 'normal', ['src/tax.js']);
  T('Project scaffold', 'Folders, lint, README', 'done', 'nova');
  T('Cart data model', 'lines[], coupon, region', 'done', 'atlas');
  const M = (agent, kind, title, body, tags) => c.remember({ agent, kind, title, body, tags });
  M('nova', 'decision', 'Money is stored as rupees with 2 decimals, rounded only in total()', 'Never round inside subtotal; it compounds error across lines.', ['money']);
  M('atlas', 'convention', 'Every cart function returns the cart', 'Lets us chain: addItem(c, x).applyCoupon(…)', ['api']);
  M('lyra', 'convention', 'CSS variables only, no hard-coded colours', 'Tokens live in src/ui/theme.css.', ['css']);
  M('claude-code', 'lesson', 'Coupon codes arrive with stray spaces from mobile', 'Trim and upper-case before lookup.', ['coupon']);
  M('orion', 'fact', 'Tests run with vitest, not jest', 'npm test → vitest run', ['tests']);
  M('cursor', 'decision', 'API returns { ok, data | error } everywhere', 'Agreed with Atlas on the board.', ['api']);
  M('nova', 'todo', 'Ask the user about GST invoices', '', []);
  const L = (agent, p, symbol, reason) => c.acquire({ agent, path: p, symbol, reason });
  L('nova', 'src/cart.js', 'addItem', 'quantity support');
  L('atlas', 'src/cart.js', 'total', 'regional rounding');
  L('claude-code', 'src/cart.js', 'applyCoupon', 'coupon validation');
  L('cursor', 'src/api.py', 'checkout', 'checkout endpoint');
  L('lyra', 'src/ui/theme.css', null, 'theme tokens');
  L('orion', 'tests/cart.test.js', null, 'unit tests');
  for (const a of ['nova', 'atlas', 'lyra', 'orion', 'claude-code', 'cursor']) c.touch(a, ['editing', 'thinking', 'working'][Math.floor(Math.random() * 3)]);
  return c;
}

// Keep agents busy: each edits inside its own reservation; sometimes one tries to step on another and gets stopped.
function simulate(c, ms = 450) {
  const jobs = {
    nova: ['src/cart.js', 'function addItem(cart, item, qty = 1) {', (n) => `  // qty guard ${n}: clamp to 1..99`],
    atlas: ['src/cart.js', 'function total(cart, region) {', (n) => `  // rounding pass ${n}`],
    'claude-code': ['src/cart.js', 'function applyCoupon(cart, code) {', (n) => `  // validate coupon rule ${n}`],
    cursor: ['src/api.py', 'def checkout(cart_id: str):', (n) => `    # step ${n}: reserve stock`],
    lyra: ['src/ui/theme.css', ':root {', (n) => `  --tone-${n}: color-mix(in srgb, var(--brand) ${10 + n}%, var(--ink));`],
    orion: ['tests/cart.test.js', "test('adds', () => {", (n) => `  // case ${n}`],
  };
  let n = 0;
  const ids = Object.keys(jobs);
  return setInterval(() => {
    n++;
    // Built-in agents report model usage (token saver on: most of each prompt is a cache hit).
    { const who = ['nova', 'atlas', 'lyra', 'orion'][n % 4]; const input = 2600 + ((n * 937) % 1900); c.recordUsage(who, { input, cached: Math.round(input * (0.78 + ((n * 13) % 15) / 100)), output: 120 + ((n * 71) % 260) }); }
    const id = ids[n % ids.length];
    const [p, anchor, make] = jobs[id];
    const f = c.readFile(p);
    if (n % 9 === 0) { // a careless agent tries to edit someone else's function
      const intruder = 'cursor';
      c.submit({ agent: intruder, path: 'src/cart.js', baseRev: c.readFile('src/cart.js').rev, edits: [{ old: 'function total(cart, region) {', new: 'function total(cart, region = "IN") {' }] });
      return;
    }
    const base = n % 4 === 0 ? Math.max(1, f.rev - 2) : f.rev; // edit from a stale revision: gets auto-merged
    const baseText = c.textAt(p, base) || f.text;
    if (!baseText.includes(anchor)) return;
    c.submit({ agent: id, path: p, baseRev: base, edits: [{ old: anchor, new: anchor + '\n' + make(n) }], message: make(n).trim().replace(/^\/\/ |^# /, '') });
    if (n % 29 === 0) c.remember({ agent: id, kind: 'lesson', title: `Note from ${id} #${n}`, body: 'Auto-saved during the demo.' });
  }, ms);
}

module.exports = { setup, simulate, seed };
