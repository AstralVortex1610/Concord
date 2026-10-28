// Runs every headless test in sequence.
const { execFileSync } = require('child_process');
const path = require('path');
for (const t of ['merge-stress.js', 'mcp-multiprocess.js', 'team-mock.js', 'token-bench.js', 'beta.js']) execFileSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
console.log('\nALL TESTS PASSED');
