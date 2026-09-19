// 统一构建脚本：esbuild 打包 main / preload / renderer
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname ? path.resolve(__dirname, '..') : process.cwd();
const dist = path.join(root, 'dist');

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });

  await esbuild.build({
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(dist, 'main/main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  await esbuild.build({
    entryPoints: [path.join(root, 'src/preload/preload.ts')],
    outfile: path.join(dist, 'preload/preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  // 验证用探针窗口的 preload（垫在宠物下方，用于确认点击是否真的穿透过去）
  await esbuild.build({
    entryPoints: [path.join(root, 'src/preload/probe.ts')],
    outfile: path.join(dist, 'preload/probe.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    sourcemap: true,
    logLevel: 'info',
  });

  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/pet.ts')],
    outfile: path.join(dist, 'renderer/pet.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    tsconfig: path.join(root, 'tsconfig.json'),
    sourcemap: true,
    logLevel: 'info',
  });

  // 首次运行向导（静态页面 + 一个独立的小脚本，不进主 bundle）
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/firstrun.ts')],
    outfile: path.join(dist, 'renderer/firstrun.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    logLevel: 'info',
  });

  fs.copyFileSync(
    path.join(root, 'src/renderer/index.html'),
    path.join(dist, 'renderer/index.html')
  );
  fs.copyFileSync(
    path.join(root, 'src/renderer/probe.html'),
    path.join(dist, 'renderer/probe.html')
  );
  fs.copyFileSync(
    path.join(root, 'src/renderer/firstrun.html'),
    path.join(dist, 'renderer/firstrun.html')
  );

  console.log('build ok ->', path.relative(root, dist));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
