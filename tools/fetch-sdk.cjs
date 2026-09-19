// 获取 Live2D Cubism SDK for Web，并解包到 .cache/sdk/
//
// 两条来源链路（都可选，按顺序尝试）：
//  1) 官方 zip：https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-<ver>.zip
//     —— 唯一带 Core（live2dcubismcore.min.js）的来源。国内网络可达，但部分云机房出口不可达。
//  2) GitHub 官方仓库兜底（--github / 自动在 1) 失败后尝试）：
//     Framework 源码与 Shaders 来自 Live2D/CubismWebFramework 的 tag 归档。
//     注意：Core 不在 GitHub 上（CubismWebSamples 的 Core 目录只有说明文件），
//     因此兜底链路拿不到 Core → 只能做类型检查/构建，跑不了真实渲染。
//
// 用法:
//   node tools/fetch-sdk.cjs              # 先官方 zip，失败再走 GitHub
//   node tools/fetch-sdk.cjs --github     # 只用 GitHub（不需要 Core 的场景，如 CI 静态检查）
//   node tools/fetch-sdk.cjs --official   # 只用官方 zip（需要 Core 的场景）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, '.cache', 'sdk');
const SDK_TAG = '5-r.5';
const SDK_NAME = `CubismSdkForWeb-${SDK_TAG}`;
const OFFICIAL = [
  `https://cubism.live2d.com/sdk-web/bin/${SDK_NAME}.zip`,
  `https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.4.zip`,
];
const GH_FRAMEWORK_TAR = `https://codeload.github.com/Live2D/CubismWebFramework/tar.gz/refs/tags/${SDK_TAG}`;

const argv = process.argv.slice(2);
const onlyGithub = argv.includes('--github');
const onlyOfficial = argv.includes('--official');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, attempt, maxAttempts, timeoutMs = 120000) {
  const dest = path.join(outDir, path.basename(url));
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'desktop-l2d' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return { url, ok: true, bytes: buf.length, dest };
  } catch (e) {
    if (attempt < maxAttempts) {
      await sleep(2000 * attempt);
      return download(url, attempt + 1, maxAttempts, timeoutMs);
    }
    return { url, ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 官方 zip → 解包到 outDir/<SDK_NAME> */
async function fetchOfficial() {
  for (const url of OFFICIAL) {
    const r = await download(url, 1, 4);
    console.log(JSON.stringify(r));
    if (!r.ok) continue;
    const extractTo = path.join(outDir, '__unzip');
    fs.rmSync(extractTo, { recursive: true, force: true });
    fs.mkdirSync(extractTo, { recursive: true });
    execFileSync('tar', ['-xf', r.dest, '-C', extractTo], { stdio: 'inherit' });
    const inner = fs.readdirSync(extractTo)[0];
    const target = path.join(outDir, SDK_NAME);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(extractTo, inner), target);
    fs.rmSync(extractTo, { recursive: true, force: true });
    return { ok: true, source: 'official-zip', dir: target, hasCore: fs.existsSync(path.join(target, 'Core', 'live2dcubismcore.min.js')) };
  }
  return { ok: false, source: 'official-zip' };
}

/**
 * GitHub 兜底：只取 Framework（含 Shaders）。
 * 不伪造 Core —— 拿不到就是拿不到，交由调用方判断能否继续。
 */
async function fetchFromGithub() {
  const r = await download(GH_FRAMEWORK_TAR, 1, 3);
  console.log(JSON.stringify({ ...r, note: 'GitHub 兜底：仅 Framework（不含 Core）' }));
  if (!r.ok) return { ok: false, source: 'github' };
  const extractTo = path.join(outDir, '__unzip-gh');
  fs.rmSync(extractTo, { recursive: true, force: true });
  fs.mkdirSync(extractTo, { recursive: true });
  execFileSync('tar', ['-xzf', r.dest, '-C', extractTo], { stdio: 'inherit' });
  const inner = fs.readdirSync(extractTo)[0];
  const src = path.join(extractTo, inner);
  const target = path.join(outDir, SDK_NAME);
  fs.mkdirSync(target, { recursive: true });
  // 官方 zip 里的目录结构是 Framework/{src,Shaders,*.md}，这里对齐它
  const fwTarget = path.join(target, 'Framework');
  fs.rmSync(fwTarget, { recursive: true, force: true });
  fs.mkdirSync(fwTarget, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.cpSync(path.join(src, name), path.join(fwTarget, name), { recursive: true });
  }
  // 保留已有的 Core（如果之前用官方 zip 下过）
  const coreOk = fs.existsSync(path.join(target, 'Core', 'live2dcubismcore.min.js'));
  fs.rmSync(extractTo, { recursive: true, force: true });
  return { ok: true, source: 'github-framework', dir: target, hasCore: coreOk };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  let result = { ok: false };

  if (!onlyGithub) result = await fetchOfficial();
  if (!result.ok && !onlyOfficial) result = await fetchFromGithub();

  if (!result.ok) {
    console.error('SDK 获取失败：官方 zip 与 GitHub 兜底都不可用（网络问题）');
    process.exit(1);
  }

  fs.writeFileSync(
    path.join(outDir, 'SOURCE.txt'),
    `source=${result.source}\nhasCore=${result.hasCore}\ndir=${result.dir}\ntime=${new Date().toISOString()}\n`
  );
  console.log(
    `SDK 就绪：来源=${result.source} 目录=${path.relative(root, result.dir)} Core=${result.hasCore ? '有' : '**无**（只能做静态检查，不能真实渲染）'}`
  );
  if (!result.hasCore) {
    console.log('提示：缺少 Core 时无法真实渲染，需要 Core 请让官方 zip 可达后重跑（不要用非官方镜像替代）。');
  }
})();
