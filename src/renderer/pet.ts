/**
 * desktop-l2d 渲染进程（宠物窗口）
 * - 透明 WebGL2 画布 + Cubism 5 运行时
 * - 视线跟随、点击/拖拽交互、逐像素级点击穿透
 * - M0 自检：采集性能/显存数据交给主进程出报告
 */
import {
  PetModel,
  PackInfo,
  PackAction,
  ParamOverride,
  parseExpressionOverrides,
  PriorityNormal,
  PriorityForce,
} from './petmodel';
import { LogLevel } from '@framework/live2dcubismframework';

declare const window: Window & {
  pet?: {
    reportMetrics: (m: unknown) => void;
    log: (m: unknown) => void;
    setIgnoreMouse: (v: boolean) => Promise<boolean>;
    dragStart: () => void;
    dragEnd: () => void;
    openMenu: (info?: unknown) => void;
    onAction: (cb: (a: { kind: string; id: string }) => void) => void;
    onEnablePassthrough: (cb: () => void) => void;
    /** M2：设置下发 / 预设存取 / 遮挡层 结果回报 */
    onSettings: (cb: (s: PetSettings) => void) => void;
    savePreset: (name: string, preset: Record<string, number>) => void;
    reportPreset: (p: { preset: Record<string, number>; activeSwitches: string[]; restore: unknown }) => void;
    sendHitMask: (m: { cols: number; rows: number; bits: Uint8Array }) => void;
    reportClick: (x: number, y: number) => void;
    quit: () => void;
  };
};

const params = new URLSearchParams(location.search);
const packId = params.get('pack') || '';
const maxTextureEdge = Number(params.get('scale') || '2048');
const model3Kind = params.get('model3') || 'normalized';
const selftest = params.get('selftest') === '1';
const runSeconds = Number(params.get('seconds') || '6');

/** M2 设置（主进程通过 pet:settings 下发并持久化） */
interface PetSettings {
  fpsCap: number; // 0 = 不限
  exclusiveGroups: string[];
  modelScale: number;
  overlay: string | null;
  pauseWhenHidden: boolean;
}
let settings: PetSettings = {
  fpsCap: selftest ? 0 : 60,
  exclusiveGroups: ['服装'],
  modelScale: 1,
  overlay: null,
  pauseWhenHidden: true,
};

const canvas = document.getElementById('pet') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;

const log = (msg: unknown): void => {
  console.log(msg);
  window.pet?.log(typeof msg === 'string' ? msg : JSON.stringify(msg));
};

// 全局错误必须打出来 —— 否则 rAF 循环里的一次异常会静默终止整个宠物
window.addEventListener('error', (ev) => {
  log(`RENDERER ERROR: ${ev.message}\n${(ev.error && (ev.error as Error).stack) || '(no stack)'}`);
});
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason as Error | undefined;
  log(`UNHANDLED REJECTION: ${r?.message || String(ev.reason)}\n${r?.stack || ''}`);
});

// ---------------------------------------------------------------- WebGL 初始化
const gl = canvas.getContext('webgl2', {
  alpha: true,
  premultipliedAlpha: true,
  antialias: true,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
}) as WebGL2RenderingContext | null;

if (!gl) {
  log('无法获取 WebGL2 上下文 —— 该环境不支持 Cubism 5 SDK for Web R5');
}

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  // 抖动/1px 级变化不重建（窗口样式切换在 Windows 上可能带来像素级漂移）
  if (Math.abs(canvas.width - w) < 2 && Math.abs(canvas.height - h) < 2) return;
  canvas.width = w;
  canvas.height = h;
  model?.resize(w, h);
  log(`画布尺寸 ${w}x${h} (dpr=${dpr})`);
}

function glInfo(): Record<string, unknown> {
  if (!gl) return { error: 'no webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    version: gl.getParameter(gl.VERSION),
    glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
    maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array),
    antialias: gl.getContextAttributes()?.antialias ?? null,
  };
}

// ---------------------------------------------------------------- 模型加载
let model: PetModel | null = null;
let pack: PackInfo | null = null;
let loadReport: Record<string, unknown> | null = null;

async function loadModel(): Promise<void> {
  const res = await fetch('pet://local/pack/pack.json');
  if (!res.ok) throw new Error(`pack.json 读取失败 (${res.status})`);
  pack = (await res.json()) as PackInfo;
  if (packId && pack.id !== packId) log(`注意：请求的包 ${packId} 与实际 ${pack.id} 不一致`);

  PetModel.ensureFramework(selftest ? LogLevel.LogLevel_Warning : LogLevel.LogLevel_Error);
  model = new PetModel();
  const model3File =
    model3Kind === 'raw' && pack.model3.raw ? pack.model3.raw : pack.model3.normalized;
  log(`使用 model3: ${model3File}`);
  loadReport = (await model.load({
    gl: gl!,
    canvas,
    packBaseUrl: 'pet://local/pack/',
    shaderPath: 'pet://local/shaders/',
    maxTextureEdge,
    pack,
    model3File,
  })) as unknown as Record<string, unknown>;
  log(`加载完成 ${JSON.stringify(loadReport)}`);
  buildActionMaps();
}

// ---------------------------------------------------------------- 交互
const KEY_ARM_MS = 1500;
let singleKeyActions = new Map<string, PackAction>();
let comboActions = new Map<string, PackAction>();
let armedKey: string | null = null;
let armedAt = 0;

function normalizeKey(k: string): string {
  const s = k.toLowerCase();
  if (s === 'arrowright') return 'right';
  if (s === 'arrowleft') return 'left';
  if (s === 'arrowup') return 'up';
  if (s === 'arrowdown') return 'down';
  return s;
}

function buildActionMaps(): void {
  singleKeyActions = new Map();
  comboActions = new Map();
  for (const a of pack?.actions || []) {
    const t = (a.triggers || []).map(normalizeKey).filter(Boolean);
    if (t.length === 1) singleKeyActions.set(t[0], a);
    else if (t.length >= 2) comboActions.set(`${t[0]}+${t[1]}`, a);
  }
  log(`按键绑定：单键 ${singleKeyActions.size} 个，组合键 ${comboActions.size} 个`);
}

function runAction(a: PackAction): void {
  if (!model) return;
  if (a.kind === 'expression') {
    void toggleExpressionAction(a);
  } else {
    const ok = model.startMotionById(a.id, PriorityNormal);
    log(`动作 ${a.label} -> ${ok ? 'play' : 'skip'}`);
  }
}

// ---------------------------------------------------------------- 换装/物品开关（参数覆盖层）
/** 开关型表情的 exp3 参数缓存 */
const switchOverrideCache = new Map<string, ParamOverride[]>();

async function getSwitchOverrides(a: PackAction): Promise<ParamOverride[]> {
  const cached = switchOverrideCache.get(a.id);
  if (cached) return cached;
  try {
    const res = await fetch('pet://local/pack/' + encodeURI(a.file));
    if (!res.ok) return [];
    const list = parseExpressionOverrides(await res.arrayBuffer());
    switchOverrideCache.set(a.id, list);
    return list;
  } catch (e) {
    log(`开关参数解析失败 ${a.file}: ${String(e)}`);
    return [];
  }
}

/** 开关 id -> 所属参数组（导入器已按 cdi3 的参数组归类） */
function switchGroupOf(id: string): string | null {
  const s = pack?.switches?.find((x) => x.id === id);
  return s ? s.group : null;
}

async function toggleExpressionAction(a: PackAction): Promise<void> {
  if (!model) return;
  const isSwitch = !!pack?.switches?.some((s) => s.id === a.id);
  if (!isSwitch) {
    // 面部表情（多参数、需要平滑过渡）继续走表情管理器
    const r = model.toggleExpression(a.id);
    log(`表情 ${a.label} -> ${r}`);
    return;
  }

  if (model.isSwitchActive(a.id)) {
    model.setSwitchActive(a.id, [], false);
    log(`开关 ${a.label} -> off`);
    return;
  }
  const overrides = await getSwitchOverrides(a);
  if (!overrides.length) {
    log(`开关 ${a.label} 无参数，跳过`);
    return;
  }
  // 互斥组（默认服装）：同组其它开关先关，避免出现"外套+泳衣"这种叠穿
  const group = switchGroupOf(a.id);
  if (group && settings.exclusiveGroups.includes(group)) {
    for (const s of pack?.switches || []) {
      if (s.group === group && s.id !== a.id && model.isSwitchActive(s.id)) {
        model.setSwitchActive(s.id, [], false);
      }
    }
  }
  model.setSwitchActive(a.id, overrides, true);
  log(`开关 ${a.label} -> on${group ? `（组：${group}${settings.exclusiveGroups.includes(group) ? '，互斥' : ''}）` : ''}`);
}

window.addEventListener('keydown', (e) => {
  const key = normalizeKey(e.key);
  if (key === 'h') {
    hud.style.display = hud.style.display === 'none' ? 'block' : 'none';
    return;
  }
  if (key === 'escape' && model) {
    model.clearExpression();
    return;
  }
  const now = Date.now();
  if (armedKey && now - armedAt < KEY_ARM_MS) {
    const combo = comboActions.get(`${armedKey}+${key}`);
    armedKey = null;
    if (combo) return runAction(combo);
  }
  const single = singleKeyActions.get(key);
  if (single) return runAction(single);
  for (const combo of comboActions.keys()) {
    if (combo.startsWith(`${key}+`)) {
      armedKey = key;
      armedAt = now;
      log(`组合键：已按下 ${key}，等待第二键（${KEY_ARM_MS}ms 内）`);
      return;
    }
  }
});

// 鼠标：视线跟随 + 逐像素级点击穿透 + 拖拽 + 点击互动
const HIT_COLS = 64;
let hitMask: { cols: number; rows: number; bits: Uint8Array } | null = null;
let lastHit: boolean | null = null;
let lastHitAt = 0;
let dragging = false;
let pressAt = { x: 0, y: 0, t: 0 };
/** 最后一个真实到达本窗口的鼠标位置（CSS 像素）——用于标定 OS 注入输入的坐标空间 */
let lastMouseClient: { x: number; y: number } | null = null;
/** 诊断用：真实收到的 mousemove 次数（用于判断 forwarded mousemove 是否可靠） */
let mouseMoveCount = 0;
/** 交互模式默认开启；自检模式要等主进程开始跑穿透用例后再开，避免干扰先行测量 */
let passthroughEnabled = !selftest;

function computeMask(): void {
  if (!model || !model.loaded) return;
  try {
    const m = model.updateHitMask(HIT_COLS);
    if (m) {
      hitMask = m;
      // 交给主进程：由它按光标位置轮询做穿透决策
      // （实测 Windows 上 setIgnoreMouseEvents(true,{forward:true}) 的 mousemove 转发不可靠，
      //   只靠 renderer 的 mousemove 会导致"移到模型上却仍然穿透"）
      window.pet?.sendHitMask({ cols: m.cols, rows: m.rows, bits: m.bits });
    }
  } catch (e) {
    if (!loopErrors.grid) {
      loopErrors.grid = true;
      log(`命中网格失败: ${(e as Error).stack || String(e)}`);
    }
  }
}

function hitTest(clientX: number, clientY: number): boolean {
  if (!hitMask) return true;
  const rect = canvas.getBoundingClientRect();
  const cx = Math.min(
    hitMask.cols - 1,
    Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * hitMask.cols))
  );
  const cy = Math.min(
    hitMask.rows - 1,
    Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * hitMask.rows))
  );
  return hitMask.bits[cy * hitMask.cols + cx] === 1;
}

window.pet?.onEnablePassthrough(() => {
  passthroughEnabled = true;
  computeMask();
  log('穿透决策已开启（掩码已交给主进程）');
});

/**
 * 自检用：给出两个"必定命中"的测试点（CSS 像素）
 * - model：命中掩码里靠近整体的一个实心格
 * - empty：从右上角往内找的第一个 3x3 全空格的空点
 */
(window as unknown as { __petTestPoints: () => unknown }).__petTestPoints = () => {
  const rect = canvas.getBoundingClientRect();
  if (!hitMask) return { error: 'no mask' };
  const { cols, rows, bits } = hitMask;
  const toCss = (c: number, r: number) => ({
    x: Math.round(((c + 0.5) / cols) * rect.width),
    y: Math.round(((r + 0.5) / rows) * rect.height),
  });

  // 模型点：取命中格的重心附近第一个命中且四邻也命中的格（保证在实体内部）
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (bits[r * cols + c]) {
        sx += c;
        sy += r;
        n++;
      }
    }
  }
  let model = null;
  if (n > 0) {
    const gx = Math.round(sx / n);
    const gy = Math.round(sy / n);
    let best = null;
    let bestD = Infinity;
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (!bits[r * cols + c]) continue;
        let solid = true;
        for (let dr = -1; dr <= 1 && solid; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!bits[(r + dr) * cols + (c + dc)]) {
              solid = false;
              break;
            }
          }
        }
        if (!solid) continue;
        const d = (c - gx) * (c - gx) + (r - gy) * (r - gy);
        if (d < bestD) {
          bestD = d;
          best = { c, r };
        }
      }
    }
    if (best) model = toCss(best.c, best.r);
  }

  // 空白点：右上角起往内找 3x3 全空
  let empty = null;
  outer: for (let r = 1; r < rows - 1; r++) {
    for (let c = cols - 2; c > 0; c--) {
      let clear = true;
      for (let dr = -1; dr <= 1 && clear; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (bits[(r + dr) * cols + (c + dc)]) {
            clear = false;
            break;
          }
        }
      }
      if (clear) {
        empty = toCss(c, r);
        break outer;
      }
    }
  }

  return { model, empty, cols, rows, coverage: +(n / (cols * rows)).toFixed(3) };
};

function updateIgnoreMouse(hit: boolean): void {
  // 穿透状态现在由主进程按光标轮询决定；这里只保留诊断记录
  lastHit = hit;
}

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseMoveCount++;
  lastMouseClient = { x: Math.round(e.clientX), y: Math.round(e.clientY) };
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  model?.setGaze(nx, ny);
  updateIgnoreMouse(hitTest(e.clientX, e.clientY));
});

canvas.addEventListener('mouseleave', () => {
  model?.setGaze(0, 0);
  updateIgnoreMouse(false);
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  pressAt = { x: e.clientX, y: e.clientY, t: Date.now() };
  // 拖拽还是点击由主进程判定（它按光标轮询，不依赖 mousemove）
  window.pet?.pointerDown();
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  window.pet?.pointerUp();
});

// 主进程判定为"点击"后播放互动
window.pet?.onClicked((p) => {
  window.pet?.reportClick(p.x, p.y);
  if (!model || !pack) return;
  const motions = pack.actions.filter((a) => a.kind === 'motion' && a.id !== '__idle');
  if (motions.length) {
    const a = motions[Math.floor(Math.random() * motions.length)];
    model.startMotionById(a.id, PriorityForce);
    log(`点击互动 -> ${a.label}`);
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pet?.openMenu();
});

window.pet?.onAction(({ kind, id }) => {
  const a = pack?.actions.find((x) => x.id === id && x.kind === kind);
  if (a) runAction(a);
});

// ---------------------------------------------------------------- M2：设置 / 遮挡层 / 预设 / 自检钩子
window.pet?.onSettings((s) => {
  if (!s) return;
  settings = { ...settings, ...(s as PetSettings) };
  model?.setModelScale(settings.modelScale || 1);
  applyOverlay();
  log(
    `设置更新：帧率上限=${settings.fpsCap === 0 ? '不限' : settings.fpsCap} 互斥组=${settings.exclusiveGroups.join('/') || '无'} 缩放=${settings.modelScale} 遮挡层=${settings.overlay || '关'}`
  );
});

function applyOverlay(): void {
  const el = document.getElementById('overlay') as HTMLImageElement | null;
  if (!el) return;
  if (!settings.overlay) {
    el.style.display = 'none';
    el.removeAttribute('src');
    return;
  }
  el.src = 'pet://local/overlay/' + encodeURI(settings.overlay);
  el.style.display = 'block';
}

/** 自检钩子：连续快速切换多个动作（复现用户报的"切换时素材叠放"场景） */
(window as unknown as { __petMotionChainTest: (ids: string[]) => Promise<unknown> }).__petMotionChainTest =
  async (ids: string[]) => {
    if (!model || !model.loaded) return { error: 'model not loaded' };
    const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeoutMs) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    const idleIds = new Set(model.idleParamIds);
    const allIds = [...new Set(ids.flatMap((id) => model!.getMotionParamIds(id)))].filter(
      (id) => !idleIds.has(id)
    );
    if (!allIds.length) return { error: '没有可测参数' };

    await waitFor(() => model!.activeMotionId === null && !model!.restoreStats.pending, 20000);
    model.resetParametersToDefault(); // 用例隔离
    await new Promise((r) => setTimeout(r, 1200));
    const before = model.snapshotSaved();
    const played: string[] = [];
    for (const id of ids) {
      const ok = model.startMotionById(id, PriorityForce);
      played.push(`${id}:${ok ? 'play' : 'skip'}`);
      await new Promise((r) => setTimeout(r, 500)); // 不等播完就切下一个 = 用户的切换场景
    }
    const during = model.snapshotSaved();
    const finished = await waitFor(
      () => model!.activeMotionId === null && !model!.restoreStats.pending,
      40000
    );
    await new Promise((r) => setTimeout(r, 700));
    const after = model.snapshotSaved();

    const rows = allIds.map((id) => ({
      id,
      before: before[id] ?? 0,
      during: during[id] ?? 0,
      after: after[id] ?? 0,
    }));
    const maxMoved = Math.max(0, ...rows.map((r) => Math.abs(r.during - r.before)));
    const residuals = rows.map((r) => Math.abs(r.after - r.before));
    const maxResidual = Math.max(0, ...residuals);
    const violations = rows.filter((r) => Math.abs(r.after - r.before) > 0.05);
    return {
      chain: ids,
      played,
      finished,
      paramCount: allIds.length,
      maxMovedDuring: +maxMoved.toFixed(4),
      maxResidual: +maxResidual.toFixed(4),
      residualCount: violations.length,
      violations: violations.slice(0, 10).map((r) => ({
        id: r.id,
        before: +r.before.toFixed(3),
        during: +r.during.toFixed(3),
        after: +r.after.toFixed(3),
      })),
      restoreStats: model.restoreStats,
      pass: maxMoved > 0.05 && maxResidual <= 0.05,
    };
  };

/** 应用一整套外观（预设参数 + 开关集合）—— 托盘"应用预设"用 */
(window as unknown as { __petApplyLook: (look: unknown) => Promise<unknown> }).__petApplyLook = async (
  look: unknown
) => {
  if (!model || !model.loaded || !pack) return { error: 'model not loaded' };
  const l = (look || {}) as { preset?: Record<string, number>; switches?: string[] };
  const applied = model.applyPreset(l.preset || {});
  const wantSwitches = new Set(l.switches || []);
  // 先关掉不在目标集合里的开关
  for (const id of model.activeSwitches) {
    if (!wantSwitches.has(id)) model.setSwitchActive(id, [], false);
  }
  for (const id of wantSwitches) {
    if (model.isSwitchActive(id)) continue;
    const a = pack.actions.find((x) => x.id === id);
    if (!a) continue;
    const overrides = await getSwitchOverrides(a);
    if (overrides.length) model.setSwitchActive(id, overrides, true);
  }
  applyOverlay();
  return {
    appliedParams: applied,
    activeSwitches: model.activeSwitches,
  };
};

/** 当前外观（导出参数快照 + 已开开关），供"存为预设"与"复制外观"用 */
function currentLook(): { preset: Record<string, number>; activeSwitches: string[]; restore: unknown } {
  return {
    preset: model ? model.exportPreset() : {},
    activeSwitches: model ? model.activeSwitches : [],
    restore: model ? model.restoreStats : null,
  };
}

/**
 * 自检钩子：动作残留回归测试。
 * 播放一个动作，等它结束 + 回退完成，再比较"会被保存下来的参数"是否回到动作前的值。
 */
(window as unknown as { __petMotionResidueTest: (id: string) => Promise<unknown> }).__petMotionResidueTest =
  async (motionId: string) => {
    if (!model || !model.loaded) return { error: 'model not loaded' };
    const idleIds = new Set(model.idleParamIds);
    const ids = model.getMotionParamIds(motionId).filter((id) => !idleIds.has(id));
    if (!ids.length) return { error: `动作 ${motionId} 没有可测参数` };

    const waitFor = async (cond: () => boolean, timeoutMs: number): Promise<boolean> => {
      const t0 = performance.now();
      while (performance.now() - t0 < timeoutMs) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };

    await waitFor(() => model!.activeMotionId === null && !model!.restoreStats.pending, 20000);
    model.resetParametersToDefault(); // 用例隔离：先洗干净，避免上个用例的残留污染基准
    await new Promise((r) => setTimeout(r, 1200));
    const before = model.snapshotSaved();
    const started = model.startMotionById(motionId, PriorityForce);
    await new Promise((r) => setTimeout(r, 400));
    const during = model.snapshotSaved();
    const finished = await waitFor(
      () => model!.activeMotionId === null && !model!.restoreStats.pending,
      25000
    );
    await new Promise((r) => setTimeout(r, 500));
    const after = model.snapshotSaved();

    const rows = ids.map((id) => ({
      id,
      before: before[id] ?? 0,
      during: during[id] ?? 0,
      after: after[id] ?? 0,
    }));
    const movedDuring = rows.map((r) => Math.abs(r.during - r.before));
    const residuals = rows.map((r) => Math.abs(r.after - r.before));
    const maxMoved = Math.max(0, ...movedDuring);
    const maxResidual = Math.max(0, ...residuals);
    const violations = rows.filter((r) => Math.abs(r.after - r.before) > 0.05);
    return {
      motionId,
      started,
      finished,
      paramCount: ids.length,
      maxMovedDuring: +maxMoved.toFixed(4),
      maxResidual: +maxResidual.toFixed(4),
      residualCount: violations.length,
      violations: violations.slice(0, 8).map((r) => ({
        id: r.id,
        before: +r.before.toFixed(3),
        during: +r.during.toFixed(3),
        after: +r.after.toFixed(3),
      })),
      restoreStats: model.restoreStats,
      pass: maxMoved > 0.05 && maxResidual <= 0.05,
    };
  };

/** 自检钩子：换装开关"打开→关闭后参数是否复位"，以及同组互斥
 *  只比对这条开关自己覆盖的参数，并把等待压到 2~3 帧，避免把物理/呼吸的正常摆动算成残留。 */
(window as unknown as { __petSwitchTest: (ids: string[]) => Promise<unknown> }).__petSwitchTest = async (
  ids: string[]
) => {
  if (!model || !model.loaded || !pack) return { error: 'model not loaded' };
  const actions = ids.map((id) => pack!.actions.find((a) => a.id === id)).filter(Boolean) as PackAction[];
  if (!actions.length) return { error: '没有可用的开关动作' };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const pick = (snap: Record<string, number>, keys: string[]): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const k of keys) o[k] = snap[k] ?? 0;
    return o;
  };
  const maxDelta = (a: Record<string, number>, b: Record<string, number>, keys: string[]): number =>
    Math.max(0, ...keys.map((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0))));

  model.resetParametersToDefault();
  await sleep(400); // 让待机动画稳定下来（几帧内不会突变）

  const results: Record<string, unknown>[] = [];
  for (const a of actions) {
    const overrides = await getSwitchOverrides(a);
    const keys = overrides.map((o) => o.id);
    if (!keys.length) {
      results.push({ id: a.id, error: '这条开关没有参数' });
      continue;
    }
    const before = pick(model.snapshotCurrent(), keys);
    await toggleExpressionAction(a); // 开
    await sleep(2 * 17);
    const on = pick(model.snapshotCurrent(), keys);
    await toggleExpressionAction(a); // 关
    await sleep(3 * 17);
    const off = pick(model.snapshotCurrent(), keys);
    const movedOn = maxDelta(before, on, keys);
    const residualOff = maxDelta(before, off, keys);
    results.push({
      id: a.id,
      params: keys.length,
      sample: keys.slice(0, 3).map((k) => ({
        id: k,
        before: +before[k].toFixed(3),
        on: +on[k].toFixed(3),
        off: +off[k].toFixed(3),
      })),
      movedOn: +movedOn.toFixed(4),
      residualOff: +residualOff.toFixed(4),
      pass: movedOn > 0.01 && residualOff <= 0.05,
    });
  }

  // 互斥检查：同组连开两个，应只剩最后那个
  let exclusivity: Record<string, unknown> = { skipped: true };
  const byGroup = new Map<string, string[]>();
  for (const s of pack.switches || []) {
    const list = byGroup.get(s.group) || [];
    list.push(s.id);
    byGroup.set(s.group, list);
  }
  const exGroup = settings.exclusiveGroups.find((g) => (byGroup.get(g) || []).length >= 2);
  if (exGroup) {
    const [first, second] = (byGroup.get(exGroup) || []).map(
      (id) => pack!.actions.find((x) => x.id === id) as PackAction
    );
    await toggleExpressionAction(first);
    await sleep(2 * 17);
    const afterFirst = model.activeSwitches.slice();
    await toggleExpressionAction(second);
    await sleep(2 * 17);
    const afterSecond = model.activeSwitches.slice();
    const firstStillOn = afterSecond.includes(first.id);
    // 收尾：关掉
    for (const id of afterSecond) {
      const a = pack.actions.find((x) => x.id === id);
      if (a) await toggleExpressionAction(a);
    }
    exclusivity = {
      group: exGroup,
      first: first.label,
      second: second.label,
      afterFirst,
      afterSecond,
      firstTurnedOffBySecond: !firstStillOn,
      pass: afterFirst.length === 1 && afterSecond.length === 1 && !firstStillOn,
    };
  }

  const failed = results.filter((r) => !r.pass);
  return {
    perSwitch: results,
    exclusivity,
    pass: failed.length === 0 && (exclusivity.pass === true || exclusivity.skipped === true),
  };
};

/** 自检钩子：预设层（复刻 VTS 改色热键）— 应用后参数应生效、清除后应复位（同样只比对被覆盖的参数） */
(window as unknown as { __petPresetTest: () => Promise<unknown> }).__petPresetTest = async () => {
  if (!model || !model.loaded) return { error: 'model not loaded' };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 用一组"颜色/异瞳"常用参数做样本，确保有内容可测
  const sample: Record<string, { id: string; value: number; blend: string }> = {};
  const candidates = ['Param22', 'Param23', 'Param24', 'Param25', 'Param26'];
  const current = model.snapshotCurrent();
  for (const id of candidates) {
    if (current[id] === undefined) continue;
    sample[id] = { id, value: (current[id] || 0) + 1, blend: 'Add' };
  }
  if (!Object.keys(sample).length) return { error: '找不到可测参数' };

  const keys = Object.keys(sample);
  const base = model.snapshotCurrent();
  model.applyPreset(sample);
  await sleep(2 * 17);
  const applied = model.snapshotCurrent();
  model.clearPreset();
  await sleep(3 * 17);
  const cleared = model.snapshotCurrent();

  const maxDelta = (a: Record<string, number>, b: Record<string, number>): number =>
    Math.max(0, ...keys.map((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0))));
  const appliedDelta = maxDelta(base, applied);
  const residual = maxDelta(base, cleared);
  return {
    paramCount: keys.length,
    appliedDelta: +appliedDelta.toFixed(4),
    residualAfterClear: +residual.toFixed(4),
    presetLayerSize: model.presetSize,
    pass: appliedDelta > 0.5 && residual <= 0.05,
  };
};

/** 供主进程读取当前外观（托盘菜单"存为预设"） */
(window as unknown as { __petCurrentLook: () => unknown }).__petCurrentLook = () => currentLook();

/** 帧计数（验证帧率上限用） */
(window as unknown as { __petFrameCounter: () => number }).__petFrameCounter = () => frames;

/** 当前模型缩放倍数（验证设置下发用） */
(window as unknown as { __petModelScale: () => number }).__petModelScale = () => model?.modelScale ?? 1;

/** 遮挡层状态（验证遮挡图是否真的加载成功） */
(window as unknown as { __petOverlayState: () => unknown }).__petOverlayState = () => {
  const el = document.getElementById('overlay') as HTMLImageElement | null;
  if (!el) return { present: false };
  return {
    present: true,
    display: el.style.display,
    src: el.getAttribute('src'),
    complete: el.complete,
    naturalWidth: el.naturalWidth,
    naturalHeight: el.naturalHeight,
    loaded: el.complete && el.naturalWidth > 0,
  };
};

// 自检用：暴露测试点查询给主进程（executeJavaScript 调用）
declare global {
  interface Window {
    __petTestPoints: () => unknown;
    __petLastMouse: () => unknown;
  }
}
(window as unknown as { __petLastMouse: () => unknown }).__petLastMouse = () => lastMouseClient;
(window as unknown as { __petMouseStats: () => unknown }).__petMouseStats = () => ({
  mouseMoveCount,
  lastMouseClient,
  lastHit,
  maskReady: !!hitMask,
  passthroughEnabled,
});

// ---------------------------------------------------------------- 主循环
let last = performance.now();
let lastDraw = 0;
let frames = 0;
let frameTimes: number[] = [];
let measureStart = 0;
let reported = false;
let wantReport = false;
let alphaInfo: Record<string, unknown> | null = null;
let firstFrameAt = 0;
const t0 = performance.now();
const loopErrors: { update?: boolean; draw?: boolean; grid?: boolean } = {};

function loop(): void {
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1; // 切窗口回来时避免动作跳跃

  // M2 省电：窗口隐藏/最小化时整帧跳过；再按设置的帧率上限节流
  if (settings.pauseWhenHidden && document.hidden) {
    requestAnimationFrame(loop);
    return;
  }
  if (settings.fpsCap > 0 && now - lastDraw < 1000 / settings.fpsCap - 0.8) {
    requestAnimationFrame(loop);
    return;
  }
  lastDraw = now;

  if (model && model.loaded) {
    // 关键：SDK 不会清主帧缓冲，必须自己清成全透明，否则窗口不透明
    gl!.clearColor(0, 0, 0, 0);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    try {
      model.update(dt);
    } catch (e) {
      if (!loopErrors.update) {
        loopErrors.update = true;
        log(`update 失败: ${(e as Error).stack || String(e)}`);
      }
    }
    try {
      model.draw();
    } catch (e) {
      if (!loopErrors.draw) {
        loopErrors.draw = true;
        log(`draw 失败: ${(e as Error).stack || String(e)}`);
      }
    }
    if (!firstFrameAt) firstFrameAt = now;

    // 自检收尾：在同一帧内先取命中掩码，再回读画布 alpha 做交叉校验
    if (wantReport && !alphaInfo) {
      try {
        const mask = model!.updateHitMask(HIT_COLS);
        const cols = mask?.cols ?? HIT_COLS;
        const rows = mask?.rows ?? Math.round((HIT_COLS * canvas.height) / canvas.width);
        const a = readbackAlpha(cols, rows) as Record<string, unknown> & { grid?: Uint8Array };
        const grid = a.grid as Uint8Array;
        delete a.grid; // 3KB 的位图不往报告里塞
        let tp = 0;
        let fp = 0;
        let fn = 0;
        let tn = 0;
        if (mask) {
          for (let i = 0; i < cols * rows; i++) {
            const m = mask.bits[i] === 1;
            const p = grid[i] === 1;
            if (m && p) tp++;
            else if (m && !p) fp++;
            else if (!m && p) fn++;
            else tn++;
          }
        }
        alphaInfo = {
          ...a,
          hitMaskCheck: mask
            ? {
                cols,
                rows,
                hitCells: mask.hits,
                hitRatio: +(mask.hits / (cols * rows)).toFixed(3),
                truePositive: tp,
                falsePositive: fp,
                falseNegative: fn,
                precision: +(tp / Math.max(1, tp + fp)).toFixed(3),
                recall: +(tp / Math.max(1, tp + fn)).toFixed(3),
              }
            : null,
        };
      } catch (e) {
        alphaInfo = { error: String(e) };
      }
      reportMetrics(alphaInfo);
    }

    // 命中网格（~8Hz）：决定鼠标是否穿透
    if (passthroughEnabled && now - lastHitAt > 120) {
      lastHitAt = now;
      computeMask();
    }

    frames++;
    if (measureStart) frameTimes.push(now);
    if (selftest) {
      const s = model.stats;
      hud.textContent =
        `fps ~${fpsEstimate().toFixed(1)}  update ${s.updateMs.toFixed(2)}ms  draw ${s.drawMs.toFixed(2)}ms`;
    }
  }

  if (selftest && !reported) {
    if (!measureStart && now - t0 > 1500 && model?.loaded) {
      measureStart = now;
      frames = 0;
      frameTimes = [];
      log('开始测量 ...');
    } else if (measureStart && now - measureStart > runSeconds * 1000) {
      reported = true;
      wantReport = true;
    }
  }

  requestAnimationFrame(loop);
}

function fpsEstimate(): number {
  if (frameTimes.length < 2) return 0;
  const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
  return span > 0 ? (frameTimes.length - 1) / span : 0;
}

/**
 * 直接回读画布 alpha —— 这是"模型到底有没有画出来"的硬证据，
 * 不依赖操作系统合成器，也不受窗口层叠影响。
 * 必须在同一帧 draw() 之后立刻调用（preserveDrawingBuffer=false）。
 */
function readbackAlpha(cols: number, rows: number): Record<string, unknown> {
  const w = canvas.width;
  const h = canvas.height;
  const buf = new Uint8Array(w * h * 4);
  gl!.readPixels(0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, buf);
  const N = 16;
  const map: number[] = new Array(N * N).fill(0);
  const grid = new Uint8Array(cols * rows);
  let nonZero = 0;
  for (let y = 0; y < h; y++) {
    // 先算好这一行对应的 16x16 行与命中网格行（GL 的 y 向上 → 顶部为 y=h-1）
    const cyTopDown = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const a = buf[(y * w + x) * 4 + 3];
      if (a > 8) {
        nonZero++;
        const cx = Math.min(N - 1, Math.floor((x / w) * N));
        const cy = Math.min(N - 1, Math.floor((cyTopDown / h) * N));
        if (a > map[cy * N + cx]) map[cy * N + cx] = a;
      }
      if (a > 24) {
        const gx = Math.min(cols - 1, Math.floor((x / w) * cols));
        const gy = Math.min(rows - 1, Math.floor((cyTopDown / h) * rows));
        grid[gy * cols + gx] = 1;
      }
    }
  }
  const rowsOut: number[][] = [];
  for (let r = 0; r < N; r++) rowsOut.push(map.slice(r * N, r * N + N));
  return {
    coverage: +(nonZero / (w * h)).toFixed(4),
    nonZeroPixels: nonZero,
    totalPixels: w * h,
    maxAlpha: Math.max(...map),
    /** 16x16 覆盖图，0..255 为 alpha，行序从上到下 */
    alphaMap: rowsOut,
    /** 与命中网格同分辨率的"真实像素覆盖"网格，用于校验命中掩码精度 */
    grid,
  };
}

function reportMetrics(alpha: Record<string, unknown> | null): void {
  const times: number[] = [];
  for (let i = 1; i < frameTimes.length; i++) times.push(frameTimes[i] - frameTimes[i - 1]);
  times.sort((a, b) => a - b);
  const avg = fpsEstimate();
  const p95Frame = times.length ? times[Math.floor(times.length * 0.95)] : 0;
  const payload = {
    ok: true,
    load: loadReport,
    gl: glInfo(),
    canvas: { width: canvas.width, height: canvas.height, dpr: window.devicePixelRatio },
    windowSeconds: runSeconds,
    fps: {
      avg: +avg.toFixed(2),
      min: times.length ? +(1000 / times[times.length - 1]).toFixed(2) : 0,
      p95FrameMs: +p95Frame.toFixed(2),
      frames: frameTimes.length,
    },
    perfMs: {
      updateAvg: +model!.stats.updateMs.toFixed(3),
      drawAvg: +model!.stats.drawMs.toFixed(3),
    },
    visibleDrawables: model!.countVisibleDrawables(),
    canvasAlpha: alpha,
    /** 与载入基线对比：证明物理/呼吸/眨眼/待机动画确实在驱动参数 */
    parameterActivity: pack ? model!.parameterActivity(pack) : null,
    expressions: model!.expressionIds.length,
    motions: model!.motionIds.length,
    firstFrameMs: firstFrameAt ? Math.round(firstFrameAt - t0) : null,
    glError: gl!.getError(),
  };
  log(`测量结果 ${JSON.stringify(payload)}`);
  window.pet?.reportMetrics(payload);
}

// ---------------------------------------------------------------- 启动
window.addEventListener('resize', resizeCanvas);
new ResizeObserver(() => resizeCanvas()).observe(document.body);

(async () => {
  try {
    resizeCanvas();
    if (selftest) hud.style.display = 'none';
    if (!gl) throw new Error('WebGL2 不可用');
    await loadModel();
    requestAnimationFrame(loop);
  } catch (e) {
    log(`启动失败: ${String(e)}`);
    window.pet?.reportMetrics({ ok: false, error: String(e), gl: glInfo() });
  }
})();
