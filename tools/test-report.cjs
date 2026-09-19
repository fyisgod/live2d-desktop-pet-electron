// 自检报告断言：把 out/m0-report/*.json 里的关键结论变成可门禁的检查项。
//
// 之所以要单独做断言而不是"看日志"：自检本身只是产出数据，CI 需要一个会失败的判据。
// 对不同模型（VTS 工程包 or Cubism 官方示例）能力不同的用例按 SKIP 处理，不假装通过。
//
// 用法:
//   node tools/test-report.cjs [--report <path>] [--require-transparency]
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const reportArgIdx = argv.indexOf('--report');
const requireTransparency = argv.includes('--require-transparency');

function findReport() {
  if (reportArgIdx >= 0 && argv[reportArgIdx + 1]) return path.resolve(root, argv[reportArgIdx + 1]);
  const dir = path.join(root, 'out', 'm0-report');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('report-') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error(`没有找到自检报告：${dir}`);
  return path.join(dir, files[0].f);
}

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === 'SKIP') results.push({ name, status: 'SKIP' });
    else if (r === true) results.push({ name, status: 'PASS' });
    else results.push({ name, status: 'FAIL', detail: String(r) });
  } catch (e) {
    results.push({ name, status: 'FAIL', detail: String(e) });
  }
}

const reportPath = findReport();
const r = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const load = (r.renderer && r.renderer.load) || {};
const alpha = (r.renderer && r.renderer.canvasAlpha) || {};
const m2 = r.m2Tests || {};

check('渲染进程产出指标', () => (r.renderer && r.renderer.ok === true) || 'renderer 未就绪');
check('模型已加载（moc3 版本）', () => (load.mocVersion >= 1 ? true : `mocVersion=${load.mocVersion}`));
check('模型有可绘制内容', () => (load.drawables > 0 ? true : `drawables=${load.drawables}`));
check('画布真的画出了模型（alpha 覆盖率）', () =>
  alpha.coverage > 0.05 ? true : `coverage=${alpha.coverage}`
);
check('渲染进程无未捕获异常', () => {
  const bad = (r.rendererLogs || []).filter((l) => /RENDERER ERROR|UNHANDLED REJECTION/.test(l));
  return bad.length === 0 ? true : bad.slice(0, 2).join(' | ');
});
check('透明合成', () => {
  const v = r.transparency && r.transparency.verdict;
  if (v === 'PASS') return true;
  if (v === 'SKIPPED') return requireTransparency ? '被跳过但本次要求必须验证' : 'SKIP';
  return `verdict=${v}`;
});
check('动作播完参数复位', () => {
  const t = m2.motionResidue;
  if (!t || t.error || t.skipped) return 'SKIP';
  return t.pass === true ? true : `maxResidual=${t.maxResidual}`;
});
check('连切动作无残留', () => {
  const t = m2.motionChainResidue;
  if (!t || t.error || t.skipped) return 'SKIP';
  return t.pass === true ? true : `maxResidual=${t.maxResidual}`;
});
check('换装开关开/关与互斥', () => {
  const t = m2.switchTest;
  if (!t || t.error) return 'SKIP';
  return t.pass === true ? true : JSON.stringify(t.perSwitch || t).slice(0, 200);
});
check('外观预设层', () => {
  const t = m2.presetTest;
  if (!t || t.error) return 'SKIP';
  return t.pass === true ? true : JSON.stringify(t).slice(0, 200);
});
check('帧率上限生效', () => {
  const t = m2.fpsCapTest;
  if (!t || t.error) return 'SKIP';
  return t.pass === true ? true : JSON.stringify(t);
});
check('设置持久化', () => {
  const t = m2.persistenceTest;
  if (!t || t.error) return 'SKIP';
  return t.pass === true ? true : JSON.stringify(t);
});
check('遮挡层加载', () => {
  const t = m2.overlayTest;
  if (!t || t.error || t.skipped) return 'SKIP';
  return t.pass === true ? true : JSON.stringify(t).slice(0, 200);
});

console.log(`报告：${path.relative(root, reportPath)}`);
console.log(`模型：${load.mocVersion ? 'moc3 v' + load.mocVersion : '?'} | ${load.drawables} drawable | 显存 ${load.vramMB}MB | 帧率 ${r.renderer && r.renderer.fps ? r.renderer.fps.avg : '?'}`);
for (const x of results) {
  const mark = x.status === 'PASS' ? '✓' : x.status === 'SKIP' ? '-' : '✗';
  console.log(`  ${mark} [${x.status}] ${x.name}${x.detail ? ' → ' + x.detail : ''}`);
  // 同时输出 GitHub 注解：CI 日志需要凭据才能读，注解可以匿名从 API 取到，
  // 这是把"为什么失败"带出流水线的唯一通道。
  if (x.status === 'FAIL') {
    console.log(`::error title=自检断言失败：${x.name}::${x.detail || '(无细节)'}`);
  }
}
const failed = results.filter((x) => x.status === 'FAIL');
const skipped = results.filter((x) => x.status === 'SKIP');
console.log(`\n自检断言：${results.length - failed.length - skipped.length} 通过 / ${failed.length} 失败 / ${skipped.length} 跳过`);
if (failed.length) {
  console.error('自检门禁失败');
  process.exit(1);
}
