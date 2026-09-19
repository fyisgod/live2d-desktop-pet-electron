// 直接下载 Electron 二进制并解包到 node_modules/electron/dist
// （绕开 @electron/get 在弱网下频繁 ECONNRESET 的问题，可重试）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const cacheDir = path.join(root, '.cache', 'electron');
const zipName = `electron-v${version}-win32-x64.zip`;
const zipPath = path.join(cacheDir, zipName);
const distDir = path.join(root, 'node_modules', 'electron', 'dist');

const MIRRORS = [
  `https://npmmirror.com/mirrors/electron/${version}/${zipName}`,
  `https://github.com/electron/electron/releases/download/v${version}/${zipName}`,
];

async function download(url, attempt = 1) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${zipPath}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r) => out.end(r));
  if (total && got !== total) throw new Error(`长度不符 ${got}/${total}`);
  fs.renameSync(tmp, zipPath);
  return got;
}

(async () => {
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(zipPath)) {
    let ok = false;
    for (const url of MIRRORS) {
      for (let i = 1; i <= 3 && !ok; i++) {
        try {
          process.stdout.write(`下载 ${url} (第${i}次) ... `);
          const bytes = await download(url);
          console.log(`OK ${(bytes / 1024 / 1024).toFixed(1)}MB`);
          ok = true;
        } catch (e) {
          console.log(`失败: ${e.message}`);
          await new Promise((r) => setTimeout(r, 2000 * i));
        }
      }
      if (ok) break;
    }
    if (!ok) {
      console.error('Electron 二进制下载失败（网络问题），请稍后重试');
      process.exit(1);
    }
  } else {
    console.log(`使用已缓存 ${zipPath}`);
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  console.log('解包中 ...');
  execFileSync('tar', ['-xf', zipPath, '-C', distDir], { stdio: 'inherit' });
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe');
  const exe = path.join(distDir, 'electron.exe');
  console.log(fs.existsSync(exe) ? `electron.exe 就绪: ${exe}` : '未找到 electron.exe，解包结构异常');
})();
