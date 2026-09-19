// M0 辅助脚本：带重试地从官方站点下载 Cubism SDK for Web 压缩包
const fs = require('node:fs');
const path = require('node:path');

const CANDIDATES = [
  'https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip',
  'https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.4.zip',
];

const outDir = path.resolve(__dirname, '..', '.cache');
fs.mkdirSync(outDir, { recursive: true });

async function tryDownload(url, attempt = 1) {
  const dest = path.join(outDir, path.basename(url));
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'desktop-l2d-m0' } });
    if (!res.ok) return { url, status: res.status, ok: false };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return { url, ok: true, bytes: buf.length, dest };
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return tryDownload(url, attempt + 1);
    }
    return { url, ok: false, error: String(e && e.message) };
  }
}

(async () => {
  for (const url of CANDIDATES) {
    const r = await tryDownload(url);
    console.log(JSON.stringify(r));
    if (r.ok) break;
  }
})();
