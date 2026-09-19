// VTS / Cubism Editor 模型目录 → desktop-l2d pack
// 只读原模型目录，产出写入 userdata/packs/<id>/
// 用法: node tools/import-model.cjs "<模型目录>"   （纯 Node 版：只生成 JSON，贴图降采样交给运行时兜底）
//      想要导入期就把贴图降采样落盘，用 Electron 版：npx electron tools/import-cli.cjs "<模型目录>" --tex 2048
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function walk(dir, predicate, depth = 0) {
  const out = [];
  if (depth > 4) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, predicate, depth + 1));
    else if (predicate(p, e.name)) out.push(p);
  }
  return out;
}

/** 从贴图 PNG 头部读宽高（不依赖任何第三方库） */
function readPngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

function readMocVersion(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    if (head.toString('ascii', 0, 4) !== 'MOC3') return null;
    return head[4];
  } finally {
    fs.closeSync(fd);
  }
}

/** 挑选舌型/口型参数：优先标准 ParamMouthOpenY，其次按名称打分 */
function detectLipSyncParams(params) {
  const byId = new Map(params.map((p) => [p.Id, p]));
  if (byId.has('ParamMouthOpenY')) return ['ParamMouthOpenY'];
  const scored = params
    .filter((p) => /mouth/i.test(p.Id) && /open|a\b/i.test(p.Id))
    .map((p) => p.Id);
  return scored.slice(0, 1);
}

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('用法: node tools/import-model.cjs "<模型目录>" [--tex <最长边>]');
    process.exit(1);
  }
  const texIdx = process.argv.indexOf('--tex');
  const texEdge = texIdx >= 0 ? Number(process.argv[texIdx + 1]) : 0;
  try {
    const result = importModel({
      input: inputArg,
      textureMaxEdge: texEdge,
      // 纯 Node 下没有图片处理能力：不给 resizeImpl，则贴图降采样交给运行时兜底
      resizeImpl: null,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`导入失败: ${e.message}`);
    process.exit(1);
  }
  if (!texEdge) {
    console.log('提示：未传 --tex，贴图将在运行时降采样（可用 npm run import:model 走 Electron 版本落盘缓存）');
  }
}

/**
 * @param {{
 *   input: string,
 *   textureMaxEdge?: number,
 *   resizeImpl?: null | ((src: string, dest: string, maxEdge: number) => void),
 *   outRoot?: string,   // 产物根目录（打包后由主进程传 app.getPath('userData')）
 * }} opts
 */
function importModel(opts) {
  const inputArg = opts.input;
  const textureMaxEdge = opts.textureMaxEdge || 0;
  const resizeImpl = opts.resizeImpl || null;
  const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : root;
  const srcDir = path.isAbsolute(inputArg) ? inputArg : path.resolve(root, inputArg);
  if (!fs.existsSync(srcDir)) {
    throw new Error(`目录不存在: ${srcDir}`);
  }

  // 1) 定位 model3.json
  const model3Files = walk(srcDir, (p) => p.toLowerCase().endsWith('.model3.json'));
  if (model3Files.length === 0) {
    throw new Error('未找到 *.model3.json —— 这不是 Cubism/VTS 模型目录');
  }
  const model3Path = model3Files[0];
  const model3 = readJson(model3Path);
  const modelDir = path.dirname(model3Path);
  const rel = (p) => path.relative(modelDir, p).split(path.sep).join('/');

  // 2) moc3 基本信息
  const mocPath = path.join(modelDir, model3.FileReferences.Moc);
  const mocVersion = readMocVersion(mocPath);
  const mocBytes = fs.statSync(mocPath).size;

  // 3) 贴图信息 + 显存估算
  const textures = (model3.FileReferences.Textures || []).map((t) => {
    const p = path.join(modelDir, t);
    const size = fs.existsSync(p) ? readPngSize(p) : null;
    const bytes = fs.existsSync(p) ? fs.statSync(p).size : 0;
    return {
      file: t,
      width: size ? size.width : 0,
      height: size ? size.height : 0,
      pngBytes: bytes,
      vramBytes: size ? size.width * size.height * 4 : 0,
    };
  });
  const vramRaw = textures.reduce((a, t) => a + t.vramBytes, 0);

  // 4) cdi3 → 参数/部件/分组
  let cdi = null;
  if (model3.FileReferences.DisplayInfo) {
    const p = path.join(modelDir, model3.FileReferences.DisplayInfo);
    if (fs.existsSync(p)) cdi = readJson(p);
  }
  const params = (cdi && cdi.Parameters) || [];
  const groupNameById = new Map();
  for (const g of (cdi && cdi.ParameterGroups) || []) {
    if (g.Id && g.Name) groupNameById.set(g.Id, g.Name);
  }
  const paramGroupName = (param) => groupNameById.get(param.GroupId) || '未分组';

  // 5) vtube.json → 热键 / 动作表
  const vtubeFiles = walk(srcDir, (p) => p.toLowerCase().endsWith('.vtube.json'));
  const vtube = vtubeFiles.length ? readJson(vtubeFiles[0]) : null;
  const hotkeys = (vtube && vtube.Hotkeys) || [];

  // 6) 扫描散落的表达式 / 动作
  const expFiles = walk(srcDir, (p) => p.toLowerCase().endsWith('.exp3.json'));
  const motionFiles = walk(srcDir, (p) => p.toLowerCase().endsWith('.motion3.json'));

  const expByName = new Map();
  for (const p of expFiles) {
    const name = path.basename(p).replace(/\.exp3\.json$/i, '');
    expByName.set(name, p);
  }
  const motionByName = new Map();
  for (const p of motionFiles) {
    const name = path.basename(p).replace(/\.motion3\.json$/i, '');
    motionByName.set(name, p);
  }
  /** 读 motion3.json 的 Meta：判断这条动作是否被设计成循环（VTS 之外的模型靠它判断） */
  const motionMeta = (p) => {
    try {
      const j = readJson(p);
      return { loops: !!(j.Meta && j.Meta.Loop), duration: (j.Meta && j.Meta.Duration) || 0 };
    } catch {
      return { loops: false, duration: 0 };
    }
  };

  // 7) 组装动作表：VTS 热键优先（带触发键与显示名），再补上未被引用的文件
  const actions = [];
  const usedExp = new Set();
  const usedMotion = new Set();
  for (const hk of hotkeys) {
    const file = hk.File || '';
    const isExp = /\.exp3\.json$/i.test(file);
    const isMotion = /\.motion3\.json$/i.test(file);
    if (!isExp && !isMotion) continue; // ArtMeshColorPreset 等 VTS 专有能力无法迁移
    const base = file.replace(/\.(exp3|motion3)\.json$/i, '');
    const found = isExp ? expByName.get(base) : motionByName.get(base);
    if (!found) continue;
    if (isExp) usedExp.add(base);
    else usedMotion.add(base);
    const meta = isMotion ? motionMeta(found) : { loops: false, duration: 0 };
    actions.push({
      id: base,
      label: hk.Name || base,
      kind: isExp ? 'expression' : 'motion',
      file: rel(found),
      triggers: [hk.Triggers && hk.Triggers.Trigger1, hk.Triggers && hk.Triggers.Trigger2].filter(Boolean),
      vtsAction: hk.Action,
      fadeSeconds: hk.FadeSecondsAmount || 0.3,
      stopOnLastFrame: !!hk.StopsOnLastFrame,
      loops: meta.loops,
      duration: meta.duration,
    });
  }
  for (const [name, p] of expByName) {
    if (usedExp.has(name)) continue;
    actions.push({ id: name, label: name, kind: 'expression', file: rel(p), triggers: [], vtsAction: 'ToggleExpression' });
  }
  for (const [name, p] of motionByName) {
    if (usedMotion.has(name)) continue;
    const meta = motionMeta(p);
    actions.push({
      id: name,
      label: name,
      kind: 'motion',
      file: rel(p),
      triggers: [],
      vtsAction: 'TriggerAnimation',
      loops: meta.loops,
      duration: meta.duration,
    });
  }

  // 8) 识别"开关型"表情（只把一个参数置非零、Blend=Add/Overwrite）并按参数组归类
  const switches = [];
  for (const a of actions) {
    if (a.kind !== 'expression') continue;
    const abs = path.join(modelDir, a.file);
    if (!fs.existsSync(abs)) continue;
    let exp;
    try {
      exp = readJson(abs);
    } catch {
      continue;
    }
    const ps = exp.Parameters || [];
    const nonZero = ps.filter((x) => x.Value !== 0);
    if (ps.length <= 2 && nonZero.length <= 1) {
      const target = nonZero[0] || ps[0] || {};
      const param = params.find((x) => x.Id === target.Id);
      switches.push({
        id: a.id,
        label: a.label,
        file: a.file,
        parameterId: target.Id || null,
        onValue: target.Value !== undefined ? target.Value : 1,
        blend: target.Blend || 'Add',
        group: param ? paramGroupName(param) : '未分组',
      });
    }
  }

  // 9) 待机 / 丢失捕捉动画
  //    VTS 工程包从 vtube.json 拿；普通 Cubism 导出（Editor / 官方样例）没有这个文件，
  //    退回按文件名识别 idle（否则这类模型会完全没有待机动作）。
  let idleFile = vtube && vtube.FileReferences && vtube.FileReferences.IdleAnimation;
  // VTS 里"跟踪丢失时的待机"键名是 IdleAnimationWhenTrackingLost（早期写成 IdleAnimationLost 取不到）
  const idleLostFile =
    vtube &&
    vtube.FileReferences &&
    (vtube.FileReferences.IdleAnimationWhenTrackingLost || vtube.FileReferences.IdleAnimationLost);
  let idleSource = idleFile ? 'vtube.json' : null;
  if (!idleFile) {
    for (const [name, p] of motionByName) {
      if (/idle|待机|まばたき|stand/i.test(name)) {
        idleFile = rel(p);
        idleSource = `文件名匹配「${name}」`;
        break;
      }
    }
  }

  // 10) 规范化 model3.json：原生 + 补 LipSync 组（原文件里是空的）
  const lipSyncIds = detectLipSyncParams(params);
  const normalized = JSON.parse(JSON.stringify(model3));
  normalized.Groups = normalized.Groups || [];
  const lipGroup = normalized.Groups.find((g) => g.Name === 'LipSync');
  if (lipGroup) lipGroup.Ids = lipSyncIds;
  else normalized.Groups.push({ Target: 'Parameter', Name: 'LipSync', Ids: lipSyncIds });
  if (!normalized.FileReferences.Expressions) normalized.FileReferences.Expressions = [];

  // 11) 输出 pack
  const id = path.basename(srcDir);
  const outDir = path.join(outRoot, 'userdata', 'packs', id);
  fs.mkdirSync(outDir, { recursive: true });

  // 11a) 贴图降采样：交给调用方提供的 resizeImpl（Electron 版用 Skia/nativeImage，
  //      纯 Node 版没有图片处理能力，此时返回空 → 运行时再降采样兜底）
  let scaledTextures = null;
  const texNotes = [];
  if (resizeImpl && textureMaxEdge > 0) {
    const texDir = path.join(outDir, 'tex');
    fs.rmSync(texDir, { recursive: true, force: true });
    fs.mkdirSync(texDir, { recursive: true });
    scaledTextures = [];
    for (const t of textures) {
      const src = path.join(modelDir, t.file);
      const dest = path.join(texDir, path.basename(t.file));
      const longest = Math.max(t.width, t.height);
      try {
        if (longest > textureMaxEdge) {
          resizeImpl(src, dest, textureMaxEdge);
          texNotes.push(`${t.file}: ${t.width}x${t.height} -> 最长边 ${textureMaxEdge}`);
        } else {
          fs.copyFileSync(src, dest);
        }
        scaledTextures.push(`tex/${path.basename(t.file)}`);
      } catch (e) {
        texNotes.push(`${t.file}: 降采样失败 ${String(e)} → 回退到原图`);
        scaledTextures = null;
        break;
      }
    }
    if (!scaledTextures) fs.rmSync(texDir, { recursive: true, force: true });
  }

  const normalizedScaled = JSON.parse(JSON.stringify(normalized));
  if (scaledTextures) normalizedScaled.FileReferences.Textures = scaledTextures;
  fs.writeFileSync(path.join(outDir, 'model.normalized.model3.json'), JSON.stringify(normalizedScaled, null, 2), 'utf8');
  // 原图版本：用于对照测量（npx electron . --raw）
  fs.writeFileSync(path.join(outDir, 'model.raw.model3.json'), JSON.stringify(normalized, null, 2), 'utf8');

  const iconCandidates = ['icon.jpg', 'icon.png', 'icon.jpeg'];
  let icon = null;
  for (const c of iconCandidates) {
    const p = path.join(modelDir, c);
    if (fs.existsSync(p)) {
      icon = rel(p);
      break;
    }
  }

  const packedTextures = scaledTextures
    ? textures.map((t) => {
        const k = Math.min(1, textureMaxEdge / Math.max(t.width, t.height));
        const w = Math.max(1, Math.round(t.width * k));
        const h = Math.max(1, Math.round(t.height * k));
        return { ...t, packed: `tex/${path.basename(t.file)}`, packedWidth: w, packedHeight: h, packedBytes: w * h * 4, downscaled: k < 1 };
      })
    : textures.map((t) => ({ ...t, packed: null, downscaled: false }));

  const pack = {
    id,
    name: path.basename(modelDir),
    sourceDir: modelDir,
    sourceMtime: fs.statSync(mocPath).mtimeMs,
    importedAt: Date.now(),
    vtsVersion: vtube ? vtube.ModelSaveMetadata && vtube.ModelSaveMetadata.LastSavedVTubeStudioVersion : null,
    moc: { file: model3.FileReferences.Moc, version: mocVersion, bytes: mocBytes },
    model3: { file: rel(model3Path), normalized: 'model.normalized.model3.json', raw: 'model.raw.model3.json' },
    textures: packedTextures,
    textureScale: scaledTextures ? textureMaxEdge : 0,
    textureVramPackedBytes: packedTextures.reduce((a, t) => a + (t.packedBytes || t.vramBytes), 0),
    textureVramRawBytes: vramRaw,
    lipSyncParamIds: lipSyncIds,
    parameters: params.map((p) => ({ id: p.Id, name: p.Name, group: paramGroupName(p) })),
    parameterGroupCount: groupNameById.size,
    partCount: (cdi && cdi.Parts && cdi.Parts.length) || 0,
    motionCount: motionFiles.length,
    expressionCount: expFiles.length,
    actions,
    switches,
    idle: idleFile ? { file: idleFile, lost: idleLostFile || null, source: idleSource } : null,
    icon,
  };
  fs.writeFileSync(path.join(outDir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8');

  return {
    packDir: outDir,
    id,
    mocVersion,
    textures: textures.length,
    textureScale: pack.textureScale,
    textureDownscaleNotes: texNotes,
    vramRawMB: +(vramRaw / 1024 ** 2).toFixed(1),
    vramPackedMB: +(pack.textureVramPackedBytes / 1024 ** 2).toFixed(1),
    expressions: expFiles.length,
    motions: motionFiles.length,
    actions: actions.length,
    switches: switches.length,
    lipSyncParamIds: lipSyncIds,
    vtsActionsUnsupported: hotkeys.filter((h) => h.Action === 'ArtMeshColorPreset').map((h) => h.Name),
  };
}

if (require.main === module) main();

module.exports = { importModel };
