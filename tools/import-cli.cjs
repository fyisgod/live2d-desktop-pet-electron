// 在 Electron 下跑导入：用 Skia(nativeImage) 做贴图降采样并落盘缓存，
// 这样之后每次启动桌宠都不用再解码 8K 原图。
// 用法: npx electron tools/import-cli.cjs "<模型目录>" [--tex 2048]
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { importModel } = require('./import-model.cjs');

function resizeWithNativeImage(src, dest, maxEdge) {
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) throw new Error(`nativeImage 无法读取: ${src}`);
  const { width, height } = img.getSize();
  const k = Math.min(1, maxEdge / Math.max(width, height));
  const out =
    k < 1
      ? img.resize({
          width: Math.max(1, Math.round(width * k)),
          height: Math.max(1, Math.round(height * k)),
          quality: 'best',
        })
      : img;
  fs.writeFileSync(dest, out.toPNG());
}

app.whenReady().then(() => {
  const args = process.argv.slice(2);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--tex') {
      i++; // 跳过参数值
      continue;
    }
    if (a.startsWith('--')) continue;
    if (a.toLowerCase().endsWith('.cjs')) continue;
    positional.push(a);
  }
  const input = positional[positional.length - 1];
  const texIdx = args.indexOf('--tex');
  const textureMaxEdge = texIdx >= 0 ? Number(args[texIdx + 1]) : 2048;

  if (!input) {
    console.error('用法: npx electron tools/import-cli.cjs "<模型目录>" [--tex 2048]');
    app.exit(2);
    process.exit(2);
  }

  try {
    const result = importModel({ input, textureMaxEdge, resizeImpl: resizeWithNativeImage });
    console.log('=== 导入完成 ===');
    console.log(JSON.stringify(result, null, 2));
    app.exit(0);
    process.exit(0);
  } catch (e) {
    console.error('导入失败:', e);
    app.exit(1);
    process.exit(1);
  }
});
