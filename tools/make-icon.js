// Renders the Concord app icon (a chord of three voices on an ink tile) with Chromium, so blend modes look right.
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
app.disableHardwareAcceleration();
const html = `<html><body style="margin:0;background:transparent">
<div style="width:1024px;height:1024px;display:grid;place-items:center">
<div style="width:900px;height:900px;border-radius:210px;background:radial-gradient(circle at 30% 20%,#23233a,#0b0b12 70%);position:relative;overflow:hidden;box-shadow:inset 0 0 0 6px rgba(255,255,255,.06)">
<div style="position:absolute;width:390px;height:390px;border-radius:50%;left:150px;top:150px;background:linear-gradient(135deg,#ff7a59,#ff5fa2);mix-blend-mode:screen"></div>
<div style="position:absolute;width:390px;height:390px;border-radius:50%;left:360px;top:150px;background:linear-gradient(135deg,#ffc94d,#ff9f43);mix-blend-mode:screen"></div>
<div style="position:absolute;width:390px;height:390px;border-radius:50%;left:255px;top:345px;background:linear-gradient(135deg,#46d6b0,#4fb3ff);mix-blend-mode:screen"></div>
</div></div></body></html>`;
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon-1024.png'), img.toPNG());
  app.quit();
});
