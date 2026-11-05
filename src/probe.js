// Swarm Build check: loads the built product in a hidden window and collects real runtime errors, failed loads and console errors.
function makeProbe(BrowserWindow, getPort) {
  return function probePage(entry) {
  const port = getPort();
  return new Promise((resolve) => {
    const errors = [];
    const w = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: true, partition: 'concord-probe-' + Date.now() } });
    let finished = false;
    const done = () => { if (finished) return; finished = true; try { w.destroy(); } catch { } resolve(errors.slice(0, 20)); };
    w.webContents.on('console-message', (e, level, message, line, sourceId) => {
      if (typeof level !== 'number') { level = e.level === 'error' ? 3 : 0; message = e.message; line = e.lineNumber; sourceId = e.sourceId; }
      if (level >= 3) errors.push({ kind: /Uncaught/.test(message) ? 'runtime' : 'console', message, line, source: sourceId });
    });
    w.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => { if (code !== -3) errors.push({ kind: 'load', message: `${desc} ${url}`, source: url }); });
    w.webContents.session.webRequest.onCompleted({ urls: [`http://127.0.0.1:${port}/preview/*`] }, (d) => { if (d.statusCode >= 400) errors.push({ kind: 'load', message: `${d.statusCode} for ${d.url.replace(/^.*\/preview\//, '')}`, source: d.url }); });
    w.loadURL(`http://127.0.0.1:${port}/preview/${entry}?probe=${Date.now()}`).catch(() => {});
    // Let scripts run, then click around a little so event handlers execute too.
    w.webContents.once('did-finish-load', () => setTimeout(() => {
      w.webContents.executeJavaScript(`(async()=>{const els=[...document.querySelectorAll('button,[role=button],a[href^="#"],input[type=checkbox]')].slice(0,12);for(const el of els){try{el.click()}catch(e){};await new Promise(r=>setTimeout(r,120))}})()`).catch(() => {}).finally(() => setTimeout(done, 1500));
    }, 1500));
    setTimeout(done, 15000);
  });
}
}

module.exports = { makeProbe };
