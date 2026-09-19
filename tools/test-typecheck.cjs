// 类型门禁：只把 src/ 下的类型错误当成失败。
//
// vendor/cubism 是 Live2D 官方 SDK 源码，它依赖 Core 的全局类型（live2dcubismcore.d.ts），
// 在只检查业务代码的场景下会产出几十条噪音，因此不计入门禁，只在末尾提示数量。
//
// 用法: node tools/test-typecheck.cjs
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

let out = '';
try {
  // 直接跑 typescript 的入口脚本：跨平台、且不需要 shell（避免 DEP0190 与转义问题）
  out = execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (e) {
  out = `${e.stdout || ''}${e.stderr || ''}`;
}

const errors = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
const srcErrors = errors.filter((l) => /^src[\\/]/.test(l));
const otherErrors = errors.length - srcErrors.length;

for (const e of srcErrors) console.log('  ' + e);
console.log(`\n类型检查：src/ ${srcErrors.length} 个错误，第三方 SDK ${otherErrors} 个（不计入门禁）`);

if (srcErrors.length) {
  console.error(`类型门禁失败：src/ 下有 ${srcErrors.length} 个类型错误`);
  process.exit(1);
}
console.log('类型门禁通过');
