// 从官方 SDK 包里把需要的部分 vendor 到 vendor/cubism（保持原样，含许可文件）
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sdkDir = path.join(root, '.cache', 'sdk');
const outDir = path.join(root, 'vendor', 'cubism');

function findSdkRoot() {
  if (!fs.existsSync(sdkDir)) return null;
  for (const name of fs.readdirSync(sdkDir)) {
    const p = path.join(sdkDir, name);
    if (fs.statSync(p).isDirectory() && name.startsWith('CubismSdkForWeb-')) return p;
  }
  return null;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const sdk = findSdkRoot();
if (!sdk) {
  console.error('未找到 SDK，请先运行: node tools/fetch-sdk.cjs');
  process.exit(1);
}

const sdkName = path.basename(sdk);
fs.rmSync(outDir, { recursive: true, force: true });
copyDir(path.join(sdk, 'Core'), path.join(outDir, 'Core'));
copyDir(path.join(sdk, 'Framework', 'src'), path.join(outDir, 'Framework', 'src'));
copyDir(path.join(sdk, 'Framework', 'Shaders'), path.join(outDir, 'Framework', 'Shaders'));
for (const f of ['LICENSE.md', 'README.md', 'CHANGELOG.md']) {
  const src = path.join(sdk, 'Framework', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, 'Framework', f));
}
for (const f of ['LICENSE.md', 'NOTICE.md', 'README.md', 'RedistributableFiles.txt']) {
  const src = path.join(sdk, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(outDir, f));
  const srcCore = path.join(sdk, 'Core', f);
  if (fs.existsSync(srcCore)) fs.copyFileSync(srcCore, path.join(outDir, 'Core', f));
}
fs.writeFileSync(
  path.join(outDir, 'VERSION.txt'),
  `vendored from ${sdkName} (official download: https://cubism.live2d.com/sdk-web/bin/${sdkName}.zip)\n`
);
console.log(`vendored ${sdkName} -> vendor/cubism`);
