// Sets Concord's icon and version info on Concord.exe (pure JS, no wine needed).
const fs = require('fs');
const path = require('path');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const R = ResEdit.default || ResEdit;
  const exePath = path.join(ctx.appOutDir, 'Concord.exe');
  const exe = R.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = R.NtExecutableResource.from(exe);
  const ico = R.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.ico')));
  R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map(i => i.data));
  const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    vi.setStringValues({ lang: 1033, codepage: 1200 }, { ProductName: 'Concord', FileDescription: 'Concord', CompanyName: 'Affan Mohammed', OriginalFilename: 'Concord.exe', InternalName: 'Concord' });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • Concord icon applied to', exePath);
};
