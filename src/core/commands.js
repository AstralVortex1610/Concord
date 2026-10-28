// run_command for built-in agents: run tests, builds and linters inside the project folder.
// Three modes: off, safe (an allow-list of test/build/lint commands, no chaining) and all (anything except the deny-list).
// External agents (MCP / HTTP) never get this tool: they already have their own shells, and a web page must never reach one.
const { spawn, execFile } = require('child_process');

const SAFE = [
  /^npm (test|t|run [\w:.-]+|run-script [\w:.-]+|ci|install|i|ls|outdated|audit)( |$)/,
  /^(pnpm|yarn|bun) (test|run [\w:.-]+|install|build|lint|typecheck)( |$)/,
  /^npx (tsc|eslint|prettier|jest|vitest|mocha|playwright test|ts-node|tsx|biome)( |$)/,
  /^(node|deno|bun|python3?|py) [\w./\\-]+(\.m?[jt]sx?|\.py)?( |$)/,
  /^(python3?|py) -m (pytest|unittest|mypy|ruff|black|flake8|pip (install|list|show))( |$)/,
  /^(pytest|mypy|ruff|black|flake8|tsc|eslint|jest|vitest)( |$)/,
  /^go (test|build|vet|fmt|run|mod tidy)( |$)/,
  /^cargo (test|build|check|clippy|fmt|run)( |$)/,
  /^dotnet (test|build|run|restore|format)( |$)/,
  /^(mvn|\.\/mvnw|mvnw) (test|compile|package|verify)( |$)/,
  /^(gradle|\.\/gradlew|gradlew) (test|build|check|assemble)( |$)/,
  /^(make|cmake)( [\w.-]+)*$/,
  /^git (status|diff|log|show|branch)( |$)/,
  /^(ls|dir|pwd|cat|type|echo|where|which)( |$)/,
];
const DENY = [
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\*|\.\.?)(\s|$)/i, /\brm\s+-[a-z]*f[a-z]*r\s+(\/|~|\*)/i,
  /\b(mkfs|fdisk|diskpart|format\s+[a-z]:|shutdown|reboot|halt|poweroff)\b/i,
  /\b(del|erase)\s+.*\/s/i, /\b(rd|rmdir)\s+.*\/s/i, /Remove-Item\b.*-Recurse/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s*\.|filter-branch|update-ref)/i,
  /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|iex|Invoke-Expression|powershell)/i,
  /\bnpm\s+(publish|adduser|login|token)\b/i, /\b(sudo|runas|su)\s/i, /\breg\s+(add|delete)\b/i,
  /:\(\)\s*\{.*\};\s*:/, /\.concord\b/, /\bchmod\s+-R\s+777\s+\//,
];
const CHAIN = /[;&|><`]|\$\(|\r|\n/;

function check(cmd, mode) {
  const c = String(cmd || '').trim();
  if (!c) return 'Give a command to run.';
  if (mode === 'off' || !mode) return 'Running commands is turned off for this team (Agents > Commands).';
  if (DENY.some((r) => r.test(c))) return 'That command is blocked by Concord for safety.';
  if (mode === 'safe') {
    if (CHAIN.test(c)) return 'Safe mode runs one command at a time: no ; && | > or backticks. Run them separately.';
    if (!SAFE.some((r) => r.test(c))) return 'Safe mode only runs test, build, lint and read-only git commands (npm test, pytest, go test, cargo build, tsc, eslint, node file.js…). Ask the user to switch Agents > Commands to "Anything" if you need more.';
  }
  return null;
}

function killTree(child) {
  try {
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { } }
}

// Resolves { ok, code, ms, output, timedOut, blocked }
function runCommand(root, cmd, { mode = 'safe', timeoutSec = 120, signal, maxOut = 6000 } = {}) {
  const why = check(cmd, mode);
  if (why) return Promise.resolve({ ok: false, blocked: true, code: null, ms: 0, output: why });
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(String(cmd), { cwd: root, shell: true, detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
    const add = (b) => { out += b.toString(); if (out.length > maxOut * 4) out = out.slice(-maxOut * 2); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; killTree(child); }, Math.min(Math.max(5, Number(timeoutSec) || 120), 900) * 1000);
    const onAbort = () => killTree(child);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = (code) => {
      clearTimeout(t); if (signal) signal.removeEventListener('abort', onAbort);
      // eslint-disable-next-line no-control-regex
      let text = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
      if (text.length > maxOut) text = '…(earlier output cut)\n' + text.slice(-maxOut);
      resolve({ ok: code === 0 && !timedOut, code, ms: Date.now() - t0, timedOut, output: text });
    };
    child.on('error', (e) => { out += '\n' + e.message; done(-1); });
    child.on('close', (code) => done(code));
  });
}

const RUN_TOOL = { name: 'run_command', description: 'Run a shell command in the project folder (tests, builds, linters, scripts) and get its exit code and output. Use it to check your work, e.g. run the tests after an edit. Files the command changes are picked up automatically.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command, e.g. "npm test" or "pytest -q".' }, timeoutSec: { type: 'integer', description: 'Optional time limit in seconds (default 120).' } }, required: ['command'], additionalProperties: false } };

module.exports = { runCommand, check, RUN_TOOL };
