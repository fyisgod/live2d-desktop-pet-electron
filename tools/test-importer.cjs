// 导入器单元测试：用"合成夹具"跑 tools/import-model.cjs 的核心逻辑并断言产物。
//
// 为什么用合成夹具而不是真实模型：真实模型是商用授权资产，不能进仓库；而导入器里最容易写错的
// 恰恰是"VTS 工程包规范化"这部分逻辑（表情/动作发现、开关归组、口型参数探测、热键映射），
// 这些用几 KB 的 JSON 夹具就能完整覆盖。二进制的 .moc3 头与 1x1 贴图在运行时生成，不入库。
//
// 用法: node tools/test-importer.cjs
const fs = require('node:fs');
const path = require('node:path');
const { importModel } = require('./import-model.cjs');

const root = path.resolve(__dirname, '..');
const fixtureSrc = path.join(root, 'test', 'fixtures', 'mini-model');
const workDir = path.join(root, '.cache', 'test-model');

// 1x1 透明 PNG（自造，无第三方素材）
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function prepareFixture() {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workDir, 'mini.4096'), { recursive: true });
  for (const f of fs.readdirSync(fixtureSrc)) {
    fs.copyFileSync(path.join(fixtureSrc, f), path.join(workDir, f));
  }
  // moc3 头：MOC3 + 版本字节 5（导入器只读这 5 个字节 + 文件大小）
  fs.writeFileSync(path.join(workDir, 'mini.moc3'), Buffer.from([0x4d, 0x4f, 0x43, 0x33, 0x05, 0x00, 0x00, 0x00]));
  fs.writeFileSync(path.join(workDir, 'mini.4096', 'texture_00.png'), PNG_1X1);
}

const checks = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, ok, actual, expected });
}

function main() {
  prepareFixture();
  const result = importModel({ input: path.relative(root, workDir), textureMaxEdge: 0, resizeImpl: null });
  const packDir = result.packDir;
  const pack = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8'));
  const normalized = JSON.parse(
    fs.readFileSync(path.join(packDir, 'model.normalized.model3.json'), 'utf8')
  );

  const byLabel = (label) => pack.actions.find((a) => a.label === label);
  const switchOf = (label) => pack.switches.find((s) => s.label === label);

  check('moc3 版本', pack.moc.version, 5);
  check('贴图数量', pack.textures.length, 1);
  check('贴图尺寸解析', [pack.textures[0].width, pack.textures[0].height], [1, 1]);
  check('动作总数（3 表情 + 2 动作）', pack.actions.length, 5);
  check('表情数', pack.expressionCount, 3);
  check('动作数', pack.motionCount, 2);
  check('待机动画取自 vtube.json', pack.idle.file, 'idle.motion3.json');
  check(
    'VTS 组合热键被保留',
    byLabel('外套F+1') && byLabel('外套F+1').triggers,
    ['V', 'N1']
  );
  check('StopsOnLastFrame 落到动作上', byLabel('打招呼A3').stopOnLastFrame, true);
  check(
    '无法迁移的 ArtMeshColorPreset 被单独列出',
    result.vtsActionsUnsupported,
    ['改色橙发']
  );

  // 开关识别：单参数 Add 表达式 → 开关，并按 cdi3 的参数组归类
  check('开关数量（3 参数的表情不算开关）', pack.switches.length, 2);
  check('外套开关归到「服装」组', switchOf('外套F+1') && switchOf('外套F+1').group, '服装');
  check('贴纸开关归到「物品开关」组', switchOf('贴纸Q1') && switchOf('贴纸Q1').group, '物品开关');
  check(
    '开关记录目标参数',
    switchOf('外套F+1') && [switchOf('外套F+1').parameterId, switchOf('外套F+1').onValue, switchOf('外套F+1').blend],
    ['Param100', 1, 'Add']
  );

  // 口型参数探测：model3.json 里 LipSync 组是空的，必须自己认出来并补进规范化文件
  check('口型参数探测', pack.lipSyncParamIds, ['ParamMouthOpenY']);
  const lipGroup = (normalized.Groups || []).find((g) => g.Name === 'LipSync');
  check('规范化 model3.json 补上 LipSync 组', lipGroup && lipGroup.Ids, ['ParamMouthOpenY']);
  check('EyeBlink 组保持原样', (normalized.Groups || []).find((g) => g.Name === 'EyeBlink').Ids, [
    'ParamEyeLOpen',
    'ParamEyeROpen',
  ]);

  // 来源目录只读：导入产物必须写到 userdata/ 下，且不在夹具目录里增删任何文件
  check(
    '导入产物落在 userdata/packs 下',
    path.relative(root, packDir).split(path.sep).join('/').startsWith('userdata/packs/'),
    true
  );
  check('夹具源目录文件未被增删', fs.readdirSync(fixtureSrc).sort(), [
    'coat.exp3.json',
    'idle.motion3.json',
    'mini.cdi3.json',
    'mini.model3.json',
    'mini.physics3.json',
    'mini.vtube.json',
    'sticker.exp3.json',
    'wave.motion3.json',
    'wink.exp3.json',
  ]);

  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`  ✓ ${c.name}`);
    } else {
      failed++;
      console.log(`  ✗ ${c.name}\n      期望: ${JSON.stringify(c.expected)}\n      实际: ${JSON.stringify(c.actual)}`);
    }
  }
  console.log(`\n导入器测试：${checks.length - failed}/${checks.length} 通过`);
  if (failed) {
    console.error(`导入器测试失败：${failed} 项`);
    process.exit(1);
  }
}

main();
