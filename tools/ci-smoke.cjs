// CI 冒烟：用 Live2D 官方 SDK 自带的示例模型跑一遍"导入 → 起桌宠 → 自检 → 断言报告"。
//
// 为什么用 SDK 自带示例模型：本仓库不能带任何模型（授权与体积都不允许），
// 但 tools/fetch-sdk.cjs 拉下来的官方 SDK 里本来就带 Samples/Resources/Haru 等完整模型，
// 在 CI 运行时使用它属于 SDK 的正常用途，且不会被提交进仓库。
//
// 用法: node tools/ci-smoke.cjs [--model Haru] [--seconds 5]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const sampleName = arg('model', 'Haru');
const seconds = arg('seconds', '5');

function findSampleModel() {
  const sdkDir = path.join(root, '.cache', 'sdk');
  if (!fs.existsSync(sdkDir)) throw new Error('未找到 SDK，请先运行 node tools/fetch-sdk.cjs');
  const roots = fs.readdirSync(sdkDir).filter((d) => d.startsWith('CubismSdkForWeb-'));
  for (const r of roots) {
    const p = path.join(sdkDir, r, 'Samples', 'Resources', sampleName);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findCore() {
  const sdkDir = path.join(root, '.cache', 'sdk');
  if (!fs.existsSync(sdkDir)) return null;
  for (const r of fs.readdirSync(sdkDir).filter((d) => d.startsWith('CubismSdkForWeb-'))) {
    const p = path.join(sdkDir, r, 'Core', 'live2dcubismcore.min.js');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 前置条件检查。Core 只存在于官方 zip 里（GitHub 上根本没有这个文件），
 * 而部分 CI 出口网络访问不到 cubism.live2d.com —— 这种情况下如实跳过并给出可见警告，
 * 而不是把静态检查的绿灯伪装成"端到端也通过了"。
 */
function checkPrerequisites() {
  if (!findCore()) {
    console.log(
      '::warning title=跳过端到端冒烟::未取得官方 SDK 的 Core（live2dcubismcore.min.js）。' +
        '该文件只在官方 zip 中提供，GitHub 上没有；若 CI 出口无法访问 cubism.live2d.com 就只能跳过。' +
        '静态检查（类型门禁 / 构建 / 导入器测试）在 verify 作业中已执行。'
    );
    return false;
  }
  if (!findSampleModel()) {
    console.log(
      `::warning title=跳过端到端冒烟::SDK 里没有示例模型 ${sampleName}（GitHub 兜底链路不含 Samples）。`
    );
    return false;
  }
  return true;
}

function runElectron(scriptArgs, label) {
  const electronPath = require('electron'); // 纯 Node 下返回可执行文件路径
  const args = Array.isArray(scriptArgs) ? scriptArgs : [scriptArgs];
  console.log(`\n=== ${label} ===\n> electron ${args.join(' ')}`);
  const res = spawnSync(electronPath, args, { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`${label} 失败，退出码 ${res.status}`);
  }
}

function main() {
  if (!checkPrerequisites()) {
    console.log('端到端冒烟：已跳过（原因见上）');
    return;
  }
  const modelDir = findSampleModel();
  console.log(`示例模型: ${path.relative(root, modelDir)}`);

  runElectron(
    [path.join('tools', 'import-cli.cjs'), modelDir, '--tex', '2048'],
    '导入示例模型（含贴图降采样落盘）'
  );

  runElectron(
    ['.', '--selftest', '--seconds', seconds, '--no-input-test', '--no-transparency-test'],
    '运行桌宠自检（跳过需要真实桌面的整屏取样与输入注入）'
  );

  // 断言自检报告
  const res = spawnSync(process.execPath, [path.join('tools', 'test-report.cjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('自检报告断言失败');
  console.log('\n冒烟通过');
}

try {
  main();
} catch (e) {
  console.error(`\n冒烟失败: ${e.message}`);
  process.exit(1);
}
