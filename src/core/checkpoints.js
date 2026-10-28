// Automatic checkpoints: a private git history of the whole project, kept in .concord/history.git.
// It never touches the user's own repo, branch or index (it uses its own GIT_DIR), and works in folders without git too.
// A checkpoint is taken when the team starts, when a task finishes, before a restore, and on demand.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXCLUDE = ['.concord/', '.git/', 'node_modules/', 'dist/', 'build/', 'out/', '.next/', '__pycache__/', '.venv/', 'venv/', 'target/', '*.concord-tmp', '.DS_Store', '*.log'];

class Checkpoints {
  constructor(root, { log } = {}) {
    this.root = root;
    this.dir = path.join(root, '.concord', 'history.git');
    this.log = log || (() => {});
    this.queue = Promise.resolve();
    this.state = null; // null = unknown, true = ready, false = git missing
  }
  _git(args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_DIR: this.dir, GIT_WORK_TREE: this.root, GIT_TERMINAL_PROMPT: '0', ...opts.env } }, (e, stdout, stderr) => {
        if (e) { e.message = (stderr || e.message).trim(); return reject(e); }
        resolve(String(stdout).trim());
      });
    });
  }
  _serial(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; }

  async ready() {
    if (this.state !== null) return this.state;
    try {
      await new Promise((res, rej) => execFile('git', ['--version'], { windowsHide: true }, (e) => (e ? rej(e) : res())));
    } catch { this.state = false; return false; }
    try {
      if (!fs.existsSync(path.join(this.dir, 'HEAD'))) {
        fs.mkdirSync(this.dir, { recursive: true });
        await this._git(['init', '-q']);
        await this._git(['config', 'user.name', 'Concord']);
        await this._git(['config', 'user.email', 'checkpoints@concord.local']);
        await this._git(['config', 'core.autocrlf', 'false']);
        await this._git(['config', 'gc.auto', '256']);
      }
      fs.mkdirSync(path.join(this.dir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(this.dir, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
      this.state = true;
    } catch (e) { this.log('checkpoints: ' + e.message); this.state = false; }
    return this.state;
  }

  // Returns { ok, sha, changed } ; changed=false when nothing differs from the last checkpoint.
  snapshot(message = 'checkpoint', meta = {}, force = false) {
    return this._serial(async () => {
      if (!(await this.ready())) return { ok: false, message: 'Git is not installed, so automatic checkpoints are off. Install Git for Windows to turn them on.' };
      await this._git(['add', '-A', '--', '.']);
      const status = await this._git(['status', '--porcelain']);
      let head = ''; try { head = await this._git(['rev-parse', '--verify', 'HEAD']); } catch { }
      if (!status && head && !force) return { ok: true, sha: head, changed: false };
      const body = `${String(message).slice(0, 160)}\n\n${JSON.stringify(meta)}`;
      await this._git(['commit', '-q', '--allow-empty', '--no-verify', '-m', body]);
      const sha = await this._git(['rev-parse', 'HEAD']);
      return { ok: true, sha, changed: true };
    });
  }

  async list(limit = 60) {
    if (!(await this.ready())) return [];
    try {
      const raw = await this._git(['log', `-${limit}`, '--format=%H%x1f%ct%x1f%s%x1f%b%x1e']);
      return raw.split('\x1e').map((x) => x.trim()).filter(Boolean).map((x) => {
        const [sha, ct, subject, body] = x.split('\x1f');
        let meta = {}; try { meta = JSON.parse((body || '').trim() || '{}'); } catch { }
        return { ...meta, sha, short: sha.slice(0, 7), at: Number(ct) * 1000, message: subject };
      });
    } catch { return []; }
  }

  async changed(sha) {
    try { return (await this._git(['diff', '--name-status', sha, 'HEAD'])).split('\n').filter(Boolean).slice(0, 200); } catch { return []; }
  }

  // Put the project back the way it was at `sha`. Takes a checkpoint first, so a restore can itself be undone.
  restore(sha) {
    return (async () => {
      if (!(await this.ready())) return { ok: false, message: 'Git is not installed.' };
      if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) return { ok: false, message: 'Bad checkpoint id.' };
      const before = await this.snapshot('Before restoring ' + String(sha).slice(0, 7), { kind: 'restore-point' }, true);
      return this._serial(async () => {
        const added = (await this._git(['diff', '--name-only', '--diff-filter=A', sha, 'HEAD'])).split('\n').filter(Boolean);
        await this._git(['checkout', sha, '--', '.']);
        for (const f of added) { try { fs.unlinkSync(path.join(this.root, f)); } catch { } }
        return { ok: true, restored: sha, removed: added.length, undo: before.sha };
      });
    })();
  }
}

module.exports = { Checkpoints };
