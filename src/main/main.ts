/**
 * desktop-l2d — Electron 主进程
 *
 * 职责：透明无边框窗口、pet:// 本地资源协议、点击穿透决策、窗口拖拽、
 *       托盘菜单，以及 M0 自检（性能/显存/透明合成实测报告）。
 */
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  protocol,
  screen,
  desktopCapturer,
  nativeImage,
  net,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_RENDERER = path.join(ROOT, 'dist', 'renderer');
const VENDOR = path.join(ROOT, 'vendor', 'cubism');
const PACKS_DIR = path.join(ROOT, 'userdata', 'packs');
const OUT_DIR = path.join(ROOT, 'out', 'm0-report');
const STATE_PATH = path.join(ROOT, 'userdata', 'state.json');
const PRESET_PATH = path.join(ROOT, 'userdata', 'presets.json');

/** M2 可持久化设置 */
interface Settings {
  fpsCap: number; // 0 = 不限
  exclusiveGroups: string[];
  modelScale: number;
  overlay: string | null;
  pauseWhenHidden: boolean;
}
const DEFAULT_SETTINGS: Settings = {
  fpsCap: 60,
  exclusiveGroups: ['服装'],
  modelScale: 1,
  overlay: null,
  pauseWhenHidden: true,
};

function readJsonSafe<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(p: string, v: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
}

interface PersistedState {
  settings: Partial<Settings>;
  positions: Record<string, { x: number; y: number }>;
}
const persisted = readJsonSafe<PersistedState>(STATE_PATH, { settings: {}, positions: {} });
let settings: Settings = { ...DEFAULT_SETTINGS, ...(persisted.settings || {}) };

function saveState(): void {
  persisted.settings = settings;
  writeJson(STATE_PATH, persisted);
}

// ---------------------------------------------------------------- CLI 参数
function argValue(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return process.argv.includes(`--${name}`) ? 'true' : fallback;
}

const SELFTEST = process.argv.includes('--selftest');
const TEXTURE_SCALE = Number(argValue('scale', '2048'));
const RUN_SECONDS = Number(argValue('seconds', '6'));
const SKIP_INPUT_TEST = process.argv.includes('--no-input-test');
const SELFTEST_M2 = !process.argv.includes('--no-m2-test');
/** --raw：用原图版本 model3.json（对照测量 8K 贴图的开销） */
const USE_RAW_TEXTURES = process.argv.includes('--raw');
const WIN_W = 520;
const WIN_H = 760;

// ---------------------------------------------------------------- 模型包
interface PackMeta {
  id: string;
  name: string;
  sourceDir: string;
  moc: { file: string; version: number; bytes: number };
  model3: { file: string; normalized: string; raw?: string };
  textures: {
    file: string;
    width: number;
    height: number;
    vramBytes: number;
    packed?: string | null;
    packedBytes?: number;
    downscaled?: boolean;
  }[];
  textureScale?: number;
  textureVramPackedBytes?: number;
  textureVramRawBytes: number;
  lipSyncParamIds: string[];
  actions: { id: string; label: string; kind: string; file: string; triggers: string[] }[];
  switches: unknown[];
  idle: { file: string; lost: string | null } | null;
  icon: string | null;
  vtsVersion: string | null;
  motionCount: number;
  expressionCount: number;
  partCount: number;
}

function listPacks(): { id: string; dir: string; meta: PackMeta }[] {
  if (!fs.existsSync(PACKS_DIR)) return [];
  const out: { id: string; dir: string; meta: PackMeta }[] = [];
  for (const id of fs.readdirSync(PACKS_DIR)) {
    const dir = path.join(PACKS_DIR, id);
    const p = path.join(dir, 'pack.json');
    if (fs.existsSync(p)) {
      out.push({ id, dir, meta: JSON.parse(fs.readFileSync(p, 'utf8')) });
    }
  }
  return out.sort((a, b) => (b.meta as any).importedAt - (a.meta as any).importedAt);
}

const packs = listPacks();
const wantedPack = argValue('pack');
const activePack = wantedPack ? packs.find((p) => p.id === wantedPack) : packs[0];
if (!activePack) {
  console.error(
    `没有可用的模型包。请先运行: node tools/import-model.cjs "<模型目录>"\n已查找: ${PACKS_DIR}`
  );
  app.exit(2);
}

// ------------------------------------------------- 本地资源协议 pet://local/*
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.vert': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
};

/** /pack/* 采用「包目录覆盖源模型目录」的叠加视图，这样规范化 model3.json 里的相对路径可直接生效 */
function allowedRoots(): string[] {
  const src = activePack!.meta.sourceDir;
  // 遮挡图片在模型目录或其上一级（本例里 遮挡.png 与模型目录同级）
  return [DIST_RENDERER, VENDOR, activePack!.dir, src, path.dirname(src)];
}

function resolvePetPath(pathname: string): string | null {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const candidates: string[] = [];
  if (rel.startsWith('app/')) candidates.push(path.join(DIST_RENDERER, rel.slice(4)));
  else if (rel.startsWith('core/')) candidates.push(path.join(VENDOR, 'Core', rel.slice(5)));
  else if (rel.startsWith('shaders/'))
    candidates.push(path.join(VENDOR, 'Framework', 'Shaders', 'WebGL', rel.slice(8)));
  else if (rel.startsWith('license/')) candidates.push(path.join(VENDOR, rel.slice(8)));
  else if (rel.startsWith('pack/')) {
    const sub = rel.slice(5);
    candidates.push(path.join(activePack!.dir, sub));
    candidates.push(path.join(activePack!.meta.sourceDir, sub));
  } else if (rel.startsWith('source/')) candidates.push(path.join(activePack!.meta.sourceDir, rel.slice(7)));
  else if (rel.startsWith('overlay/')) {
    // 只按文件名在两个已知目录里找，不做任意路径拼接
    const name = path.basename(rel.slice(8));
    candidates.push(path.join(activePack!.meta.sourceDir, name));
    candidates.push(path.join(path.dirname(activePack!.meta.sourceDir), name));
  } else return null;

  const roots = allowedRoots();
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (!roots.some((r) => abs.startsWith(path.resolve(r)))) continue; // 目录穿越防护
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

/** 自动找遮挡图（模型目录或其上一级） */
function findOverlayCandidate(): string | null {
  const src = activePack!.meta.sourceDir;
  for (const dir of [src, path.dirname(src)]) {
    for (const name of ['遮挡.png', '遮挡.jpg', 'overlay.png']) {
      if (fs.existsSync(path.join(dir, name))) return name;
    }
  }
  return null;
}

function handlePetProtocol(): void {
  protocol.handle('pet', async (request) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return new Response('bad url', { status: 400 });
    }
    const file = resolvePetPath(pathname);
    if (!file) return new Response(`not found: ${pathname}`, { status: 404 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache',
        },
      });
    } catch (e) {
      return new Response(`read error: ${String(e)}`, { status: 500 });
    }
  });
}

// ---------------------------------------------------------------- 窗口
let petWin: BrowserWindow | null = null;
let backdropWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let dragTimer: NodeJS.Timeout | null = null;
let ignoreMouse = true;
let metricsResolver: ((m: any) => void) | null = null;
let hitMask: { cols: number; rows: number; bits: Uint8Array } | null = null;
let cursorPoll: NodeJS.Timeout | null = null;
const rendererLogs: string[] = [];
const probeClicks: { x: number; y: number; at: number }[] = [];
const petClicks: { x: number; y: number; at: number }[] = [];
/** Windows 上切换窗口样式会让"无边框透明窗口"尺寸漂移（现场日志实测到持续变大），这里记录并纠正 */
const windowDrift: { reason: string; width: number; height: number }[] = [];
let enforcing = false;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function enforceWindowSize(reason: string): void {
  if (!petWin || enforcing) return;
  const b = petWin.getBounds();
  if (b.width !== WIN_W || b.height !== WIN_H) {
    windowDrift.push({ reason, width: b.width, height: b.height });
    enforcing = true;
    petWin.setBounds({ x: b.x, y: b.y, width: WIN_W, height: WIN_H }, false);
    enforcing = false;
  }
}

function preloadPath(): string {
  return path.join(ROOT, 'dist', 'preload', 'preload.cjs');
}

function createBackdrop(bounds: Electron.Rectangle): void {
  backdropWin = new BrowserWindow({
    ...bounds,
    frame: false,
    show: true,
    skipTaskbar: true,
    focusable: false,
    // 必须置顶：否则会被用户自己的窗口盖住，取样拿到的就不是探针而是别人的窗口
    // 层级低于宠物的 screen-saver，所以仍然在宠物之下
    alwaysOnTop: true,
    backgroundColor: '#FF00FF',
    webPreferences: {
      preload: path.join(ROOT, 'dist', 'preload', 'probe.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  backdropWin.setAlwaysOnTop(true, 'normal');
  backdropWin.setIgnoreMouseEvents(false); // 探针需要真的接收点击
  backdropWin.loadURL('pet://local/app/probe.html');
}

function createPetWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const w = WIN_W;
  const h = WIN_H;
  const wa = display.workArea;
  const saved = persisted.positions?.[activePack!.id];
  const bounds: Electron.Rectangle = SELFTEST
    ? {
        x: Math.round(wa.x + (wa.width - w) / 2),
        y: Math.round(wa.y + (wa.height - h) / 2),
        width: w,
        height: h,
      }
    : {
        x: saved ? saved.x : Math.round(wa.x + wa.width - w - 40),
        y: saved ? saved.y : Math.round(wa.y + wa.height - h - 40),
        width: w,
        height: h,
      };

  if (SELFTEST) {
    // 在宠物窗口下方铺一层纯品红不透明窗口，用于客观测量透明合成是否真的生效
    createBackdrop({ x: bounds.x - 40, y: bounds.y - 40, width: w + 80, height: h + 80 });
  }

  petWin = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: `desktop-l2d — ${activePack!.meta.name}`,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  petWin.on('resize', () => enforceWindowSize('resize-event'));
  // M2：位置持久化（拖动/移动结束后写盘），下次启动回到原处
  let posSaveTimer: NodeJS.Timeout | null = null;
  const savePos = (): void => {
    if (!petWin || SELFTEST) return;
    if (posSaveTimer) clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(() => {
      const b = petWin!.getBounds();
      persisted.positions = persisted.positions || {};
      persisted.positions[activePack!.id] = { x: b.x, y: b.y };
      writeJson(STATE_PATH, persisted);
    }, 800);
  };
  petWin.on('moved', savePos);
  petWin.on('close', savePos);
  // 无边框透明窗口在创建/样式设置后会漂移 2px（实测 520x760 → 522x762），这里纠正回来
  petWin.once('ready-to-show', () => enforceWindowSize('ready-to-show'));
  setTimeout(() => enforceWindowSize('after-1.5s'), 1500);

  const query = new URLSearchParams({
    pack: activePack!.id,
    scale: String(USE_RAW_TEXTURES ? 16384 : TEXTURE_SCALE),
    selftest: SELFTEST ? '1' : '0',
    seconds: String(RUN_SECONDS),
  });
  if (USE_RAW_TEXTURES) query.set('model3', 'raw');
  petWin.loadURL(`pet://local/app/index.html?${query.toString()}`);

  petWin.webContents.on('did-finish-load', () => {
    petWin?.webContents.send('pet:settings', settings);
  });

  petWin.webContents.on('console-message', (_e, level, message) => {
    rendererLogs.push(`[${level}] ${message}`);
    // 交互模式下只转发告警与错误，避免刷屏；自检模式全量输出
    if (SELFTEST || level >= 2) console.log('[renderer]', message);
  });

  return petWin;
}

// ---------------------------------------------------------------- M1: 点击穿透 / 拖拽 / 托盘
function setIgnoreMouse(v: boolean): void {
  if (!petWin) return;
  if (ignoreMouse === v) return;
  ignoreMouse = v;
  petWin.setIgnoreMouseEvents(v, { forward: true });
  // Windows 上这次样式切换可能让无边框透明窗口尺寸漂移，立刻纠正
  enforceWindowSize(`setIgnoreMouseEvents(${v})`);
}

/**
 * 穿透决策：由主进程按光标位置轮询 + renderer 送来的像素级命中掩码决定。
 *
 * 为什么不用 renderer 的 mousemove：实测 Windows 上 setIgnoreMouseEvents(true,{forward:true})
 * 的 mousemove 转发不可靠 —— 光标移到模型上时 renderer 收不到事件，于是窗口持续穿透，
 * 点不到宠物。改成主进程轮询后，无论光标是"移进来"还是"窗口移动到光标下"都能正确判定。
 */
function hitTestDip(clientX: number, clientY: number): boolean | null {
  if (!petWin || !hitMask) return null;
  const b = petWin.getBounds();
  const rx = clientX - b.x;
  const ry = clientY - b.y;
  if (rx < 0 || ry < 0 || rx >= b.width || ry >= b.height) return null; // 光标不在窗口内
  const c = Math.min(hitMask.cols - 1, Math.floor((rx / b.width) * hitMask.cols));
  const r = Math.min(hitMask.rows - 1, Math.floor((ry / b.height) * hitMask.rows));
  return hitMask.bits[r * hitMask.cols + c] === 1;
}

function startCursorPoll(): void {
  if (cursorPoll) return;
  cursorPoll = setInterval(() => {
    if (!petWin || !hitMask || !petWin.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const hit = hitTestDip(p.x, p.y);
    setIgnoreMouse(hit !== true); // 不在窗口内/不在模型上 → 穿透
  }, 33);
}

/**
 * 拖拽/点击判定全部放在主进程：
 * - 渲染进程只上报"指针按下/抬起"（这两个事件实测可靠；而 mousemove 在部分情况下根本不到达页面）
 * - 主进程按光标位置轮询移动窗口，超过 4px 才算拖拽，否则抬指时判为点击
 */
let pointerState: {
  downAt: { x: number; y: number };
  offset: { x: number; y: number };
  moved: boolean;
} | null = null;

function onPointerDown(): void {
  if (!petWin) return;
  const cursor = screen.getCursorScreenPoint();
  const b = petWin.getBounds();
  pointerState = {
    downAt: cursor,
    offset: { x: cursor.x - b.x, y: cursor.y - b.y },
    moved: false,
  };
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!petWin || !pointerState) return;
    const c = screen.getCursorScreenPoint();
    if (!pointerState.moved) {
      if (Math.hypot(c.x - pointerState.downAt.x, c.y - pointerState.downAt.y) < 4) return;
      pointerState.moved = true;
    }
    petWin.setPosition(c.x - pointerState.offset.x, c.y - pointerState.offset.y, false);
  }, 16);
}

function onPointerUp(): void {
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  const st = pointerState;
  pointerState = null;
  if (!st || !petWin) return;
  if (!st.moved) {
    // 没有位移 → 是点击，交给渲染进程播互动
    petWin.webContents.send('pet:clicked', { x: Math.round(st.downAt.x), y: Math.round(st.downAt.y) });
  }
}

function stopDrag(): void {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  pointerState = null;
}

/** 回到主显示器工作区右下角（多显示器时按当前窗口所在屏计算） */
function resetPosition(): void {
  if (!petWin) return;
  const b = petWin.getBounds();
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  petWin.setPosition(
    Math.round(wa.x + wa.width - b.width - 40),
    Math.round(wa.y + wa.height - b.height - 40),
    false
  );
}

/** 设置变更：落盘 + 下发给渲染进程 */
function applySettings(patch: Partial<Settings>, reason: string): void {
  settings = { ...settings, ...patch };
  saveState();
  petWin?.webContents.send('pet:settings', settings);
  console.log(`[settings] ${reason}:`, JSON.stringify(settings));
  rebuildTrayMenu();
}

function createTray(): void {
  const iconRel = activePack!.meta.icon;
  const iconPath = iconRel ? path.join(activePack!.meta.sourceDir, iconRel) : null;
  let icon = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : null;
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR42u3RMQ6AIAyF4b+JB/AGHsEj6Obg5uQxPIJ38AhewSN4BA/gDcQEEZi6mLTp0PcvTdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdM0TdP+Xj0GpQNi0c0AAAAASUVORK5CYII='
    );
  }
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(`desktop-l2d — ${activePack!.meta.name}`);
  tray.on('click', () => {
    if (!petWin) return;
    petWin.isVisible() ? petWin.hide() : petWin.show();
  });
  rebuildTrayMenu();
}

/** 托盘菜单（设置/预设都在这里，改完重建） */
function rebuildTrayMenu(): void {
  if (!tray) return;
  const presets = currentPackPresets();
  const presetNames = Object.keys(presets);
  const overlayCandidate = findOverlayCandidate();

  const presetItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: '把当前外观存为预设',
      click: async () => {
        const look = await captureLook();
        if (!look) return;
        const name = `外观 ${Object.keys(currentPackPresets()).length + 1}`;
        const list = currentPackPresets();
        list[name] = look;
        writePackPresets(list);
        console.log(`[preset] 已保存「${name}」：${Object.keys(look.preset).length} 个参数、${look.switches.length} 个开关`);
        rebuildTrayMenu();
      },
    },
  ];
  if (presetNames.length) {
    presetItems.push({ type: 'separator' });
    for (const name of presetNames) {
      const entry = presets[name];
      presetItems.push({
        label: `应用「${name}」（${Object.keys(entry.preset).length} 参数 / ${entry.switches.length} 开关）`,
        click: () => {
          petWin?.webContents.executeJavaScript(
            `window.__petApplyLook(${JSON.stringify(entry)})`
          ).then((r) => console.log('[preset] 应用结果:', JSON.stringify(r)));
        },
      });
      presetItems.push({
        label: `  删除「${name}」`,
        click: () => {
          const list = currentPackPresets();
          delete list[name];
          writePackPresets(list);
          rebuildTrayMenu();
        },
      });
    }
    presetItems.push({ type: 'separator' });
    presetItems.push({
      label: '清除当前参数预设（恢复默认外观）',
      click: () => {
        petWin?.webContents.executeJavaScript('window.__petApplyLook({preset:{},switches:[]})');
      },
    });
  }

  const menu = Menu.buildFromTemplate([
    { label: `模型：${activePack!.meta.name}`, enabled: false },
    { type: 'separator' },
    {
      label: '显示 / 隐藏',
      click: () => {
        if (!petWin) return;
        petWin.isVisible() ? petWin.hide() : petWin.show();
      },
    },
    {
      label: `帧率上限：${settings.fpsCap === 0 ? '不限' : settings.fpsCap + ' fps'}`,
      submenu: [0, 30, 60].map((v) => ({
        label: v === 0 ? '不限（跟随刷新率）' : `${v} fps`,
        type: 'radio' as const,
        checked: settings.fpsCap === v,
        click: () => applySettings({ fpsCap: v }, '帧率上限'),
      })),
    },
    {
      label: `互斥分组：${settings.exclusiveGroups.length ? settings.exclusiveGroups.join('/') : '无'}`,
      submenu: (() => {
        const meta = activePack!.meta as PackMeta & { switches: { id: string; group: string }[] };
        const counts = new Map<string, number>();
        for (const s of meta.switches || []) {
          counts.set(s.group, (counts.get(s.group) || 0) + 1);
        }
        const items: Electron.MenuItemConstructorOptions[] = [
          { label: '同一组内只保留一个开关（避免叠穿/道具叠加）', enabled: false },
          { type: 'separator' },
        ];
        for (const [group, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
          if (n < 2) continue;
          items.push({
            label: `${group}（${n} 个开关）`,
            type: 'checkbox',
            checked: settings.exclusiveGroups.includes(group),
            click: (item) =>
              applySettings(
                {
                  exclusiveGroups: item.checked
                    ? [...new Set([...settings.exclusiveGroups, group])]
                    : settings.exclusiveGroups.filter((g) => g !== group),
                },
                `互斥分组 ${group}`
              ),
          });
        }
        return items;
      })(),
    },
    {
      label: `缩放：${Math.round(settings.modelScale * 100)}%`,
      submenu: [0.75, 1, 1.25, 1.5].map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio' as const,
        checked: Math.abs(settings.modelScale - v) < 0.01,
        click: () => applySettings({ modelScale: v }, '缩放'),
      })),
    },
    {
      label: `遮挡层：${settings.overlay ? '开' : '关'}${overlayCandidate ? `（${overlayCandidate}）` : ''}`,
      type: 'checkbox',
      checked: !!settings.overlay,
      enabled: !!overlayCandidate,
      click: (item) =>
        applySettings({ overlay: item.checked ? overlayCandidate : null }, '遮挡层'),
    },
    {
      label: `隐藏时暂停渲染：${settings.pauseWhenHidden ? '开' : '关'}`,
      type: 'checkbox',
      checked: settings.pauseWhenHidden,
      click: (item) => applySettings({ pauseWhenHidden: item.checked }, '隐藏暂停'),
    },
    { type: 'separator' },
    { label: `外观预设（${Object.keys(currentPackPresets()).length}）`, submenu: presetItems },
    { type: 'separator' },
    { label: '重置位置', click: () => resetPosition() },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

ipcMain.on('pet:log', (_e, msg: string) => {
  rendererLogs.push(String(msg));
  const s = String(msg);
  if (SELFTEST || /失败|ERROR|REJECTION|异常/.test(s)) console.log('[renderer]', s);
});
ipcMain.on('pet:metrics', (_e, m: any) => {
  if (metricsResolver) {
    const r = metricsResolver;
    metricsResolver = null;
    r(m);
  }
});

ipcMain.handle('pet:set-ignore-mouse', (_e, v: boolean) => {
  setIgnoreMouse(!!v);
  return ignoreMouse;
});

ipcMain.on('pet:hit-mask', (_e, m: { cols: number; rows: number; bits: Uint8Array }) => {
  if (m && m.bits && m.cols > 0 && m.rows > 0) hitMask = m;
});

ipcMain.on('pet:click', (_e, p: { x: number; y: number }) => {
  petClicks.push({ ...p, at: Date.now() });
});

ipcMain.on('probe:click', (_e, p: { x: number; y: number }) => {
  probeClicks.push({ ...p, at: Date.now() });
});

// ---------------------------------------------------------------- M2：预设（外观）存取
type PresetMap = Record<string, Record<string, { preset: Record<string, number>; switches: string[] }>>;

function readPresets(): PresetMap {
  return readJsonSafe<PresetMap>(PRESET_PATH, {});
}

function currentPackPresets(): Record<string, { preset: Record<string, number>; switches: string[] }> {
  const all = readPresets();
  return all[activePack!.id] || {};
}

function writePackPresets(list: Record<string, { preset: Record<string, number>; switches: string[] }>): void {
  const all = readPresets();
  all[activePack!.id] = list;
  writeJson(PRESET_PATH, all);
}

ipcMain.on('pet:save-preset', (_e, p: { name: string; preset: Record<string, number> }) => {
  const list = currentPackPresets();
  list[p.name] = { preset: p.preset, switches: lastReportedLook?.activeSwitches || [] };
  writePackPresets(list);
  console.log(`[preset] 已保存外观「${p.name}」（${Object.keys(p.preset).length} 个参数）`);
  rebuildTrayMenu();
});

let lastReportedLook: { preset: Record<string, number>; activeSwitches: string[]; restore: unknown } | null =
  null;
ipcMain.on('pet:preset-report', (_e, p: { preset: Record<string, number>; activeSwitches: string[]; restore: unknown }) => {
  lastReportedLook = p;
});

async function captureLook(): Promise<{ preset: Record<string, number>; switches: string[] } | null> {
  if (!petWin) return null;
  try {
    const look = (await petWin.webContents.executeJavaScript('window.__petCurrentLook()')) as {
      preset: Record<string, number>;
      activeSwitches: string[];
    };
    return { preset: look.preset || {}, switches: look.activeSwitches || [] };
  } catch (e) {
    console.error('读取当前外观失败:', e);
    return null;
  }
}

ipcMain.on('pet:pointer-down', () => onPointerDown());
ipcMain.on('pet:pointer-up', () => onPointerUp());
// 兼容旧通道（渲染进程已不再使用）
ipcMain.on('pet:drag-start', () => onPointerDown());
ipcMain.on('pet:drag-end', () => onPointerUp());
ipcMain.on('pet:quit', () => app.quit());

/** 右键菜单：按导入器识别出的参数组分组，比 50 条平铺好用 */
ipcMain.on('pet:open-menu', () => {
  if (!petWin) return;
  const meta = activePack!.meta as PackMeta & {
    switches: { id: string; label: string; group: string }[];
  };
  const send = (kind: string, id: string) => petWin?.webContents.send('pet:action', { kind, id });

  const switchIds = new Set((meta.switches || []).map((s) => s.id));
  const byGroup = new Map<string, { label: string; id: string }[]>();
  for (const s of meta.switches || []) {
    const list = byGroup.get(s.group) || [];
    list.push({ label: s.label, id: s.id });
    byGroup.set(s.group, list);
  }
  const others = meta.actions
    .filter((a) => a.kind === 'expression' && !switchIds.has(a.id))
    .map((a) => ({ label: a.label, id: a.id }));
  const motions = meta.actions
    .filter((a) => a.kind === 'motion')
    .map((a) => ({ label: a.label, id: a.id }));

  const expressionSubmenu: Electron.MenuItemConstructorOptions[] = [];
  for (const [group, items] of byGroup) {
    expressionSubmenu.push({
      label: `${group}（${items.length}）`,
      submenu: items.map((it) => ({ label: it.label, click: () => send('expression', it.id) })),
    });
  }
  if (others.length) {
    expressionSubmenu.push({
      label: `其他表情（${others.length}）`,
      submenu: others.map((it) => ({ label: it.label, click: () => send('expression', it.id) })),
    });
  }

  const menu = Menu.buildFromTemplate([
    { label: `🐾 ${meta.name}`, enabled: false },
    { type: 'separator' },
    {
      label: `动作（${motions.length}）`,
      submenu: motions.map((it) => ({ label: it.label, click: () => send('motion', it.id) })),
    },
    { label: `表情 / 换装（${switchIds.size + others.length}）`, submenu: expressionSubmenu },
    { type: 'separator' },
    { label: '回到屏幕右下角', click: () => resetPosition() },
    { label: '隐藏（托盘图标可恢复）', click: () => petWin?.hide() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  menu.popup({ window: petWin });
});

// ---------------------------------------------------------------- 输入注入（验证穿透 / 拖拽）
/** 必须异步：execFileSync 会阻塞主进程事件循环，注入拖拽期间光标轮询就跑不起来了 */
function sendInput(
  action: string,
  args: Record<string, number | string> = {}
): Promise<{ ok: boolean; fromX?: number; fromY?: number; error?: string }> {
  const argv = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(ROOT, 'tools', 'sendinput.ps1'),
    '-Action',
    action,
  ];
  for (const [k, v] of Object.entries(args)) argv.push(`-${k}`, String(v));
  return new Promise((resolve) => {
    execFile('powershell.exe', argv, { encoding: 'utf8', timeout: 30000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err) });
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: `输出无法解析: ${line}` });
      }
    });
  });
}

/**
 * 用 OS 级输入注入（SetCursorPos + mouse_event）验证两个"只能手感验证"的功能：
 * 1) 空白处点击是否真的穿透到宠物窗口下方的探针窗口；
 * 2) 模型处点击是否仍然被宠物接收；
 * 3) 按住模型拖动是否让窗口跟着走。
 */
async function runInputTests(win: BrowserWindow): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { skipped: SKIP_INPUT_TEST };

  // ---- 根因诊断：反复切换穿透样式是否让"无边框透明窗口"尺寸漂移（现场日志发现的问题）
  const d0 = win.getBounds();
  for (let i = 0; i < 8; i++) {
    win.setIgnoreMouseEvents(i % 2 === 0, { forward: true });
    await sleep(50);
  }
  const d1 = win.getBounds();
  result.ignoreMouseToggleDrift = {
    before: { w: d0.width, h: d0.height },
    after: { w: d1.width, h: d1.height },
    dw: d1.width - d0.width,
    dh: d1.height - d0.height,
    note: '8 次切换的原始漂移（此段故意不做纠正）',
  };
  enforceWindowSize('after-toggle-diagnostic');
  ignoreMouse = true;
  win.setIgnoreMouseEvents(true, { forward: true });
  enforceWindowSize('after-toggle-diagnostic-restore');

  // 打开穿透决策并等掩码生成（--no-input-test 时也开着，标定需要真实投递环境）
  win.webContents.send('pet:enable-passthrough');
  startCursorPoll();
  await sleep(1200);

  // ---- 坐标空间标定（诊断性质，--no-input-test 时也跑）
  // SetCursorPos 吃的是物理像素还是 DIP？Electron 的 bounds/坐标是 DIP。
  // 先注入若干已知位置、用 screen.getCursorScreenPoint()（返回 DIP）回读判定解释方式；
  // 同时回读渲染进程实际收到的鼠标统计，判断注入的 mousemove 到底有没有进到页面。
  const display = screen.getDisplayMatching(win.getBounds());
  const sf = display.scaleFactor;
  const samples: Record<string, unknown>[] = [];
  for (let i = 0; i < 3; i++) {
    const bb = win.getBounds();
    const dipTarget = { x: bb.x + 180 + i * 60, y: bb.y + 260 + i * 45 };
    const injected = { x: Math.round(dipTarget.x * sf), y: Math.round(dipTarget.y * sf) };
    await sendInput('move', injected);
    await sleep(180);
    const read = screen.getCursorScreenPoint();
    const dPhys = Math.hypot(read.x - dipTarget.x, read.y - dipTarget.y);
    const dDip = Math.hypot(read.x - dipTarget.x * sf, read.y - dipTarget.y * sf);
    let rendererSaw: unknown = null;
    try {
      rendererSaw = await win.webContents.executeJavaScript('window.__petMouseStats()');
    } catch (e) {
      rendererSaw = `读取失败: ${String(e)}`;
    }
    samples.push({
      injected,
      targetDip: dipTarget,
      readDip: { x: read.x, y: read.y },
      verdict: dPhys < dDip ? 'physical' : 'dip',
      residualDip: +Math.min(dPhys, dDip).toFixed(1),
      /** 渲染进程是否真的收到了这次移动（判断 mousemove 转发/投递是否可用） */
      rendererSaw,
    });
  }
  const physicalVotes = samples.filter((s) => s.verdict === 'physical').length;
  const mult = physicalVotes >= 2 ? sf : 1;
  result.coordinateCalibration = {
    scaleFactor: sf,
    interpretation: mult === sf ? 'physical（SetCursorPos = DIP × scaleFactor）' : 'dip',
    physicalVotes,
    samples,
    note: 'residualDip 明显偏大说明采样被用户的鼠标移动干扰',
  };

  if (SKIP_INPUT_TEST) {
    result.clickTotals = { probeClicks: probeClicks.length, petClicks: petClicks.length };
    return result;
  }

  // 打开穿透决策，等掩码生成后再取测试点（顺序反了会拿到 no mask）
  win.webContents.send('pet:enable-passthrough');
  startCursorPoll();
  await sleep(1200);

  const cursor0 = await sendInput('pos');
  const pts = (await win.webContents.executeJavaScript('window.__petTestPoints()')) as {
    model?: { x: number; y: number };
    empty?: { x: number; y: number };
    coverage?: number;
  };
  result.testPoints = pts;
  if (!pts || !pts.model || !pts.empty) {
    result.error = '渲染进程未能给出测试点';
    result.windowDriftCorrections = windowDrift.slice();
    return result;
  }
  await sleep(600); // 再稳一会儿，确保穿透状态已经按掩码下发

  const b = win.getBounds();
  /** 注入并把光标位置核验到 DIP 目标点上，避免"其实没点到"却当成用例失败 */
  const moveAndVerify = async (cssRel: { x: number; y: number }): Promise<Record<string, unknown>> => {
    const bb = win.getBounds();
    const targetDip = { x: bb.x + cssRel.x, y: bb.y + cssRel.y };
    const injected = { x: Math.round(targetDip.x * mult), y: Math.round(targetDip.y * mult) };
    await sendInput('move', injected);
    await sleep(220);
    const read = screen.getCursorScreenPoint();
    const err = Math.hypot(read.x - targetDip.x, read.y - targetDip.y);
    return {
      cssRel,
      targetDip,
      injected,
      readDip: { x: read.x, y: read.y },
      errDip: +err.toFixed(1),
      cursorVerified: err <= 6,
    };
  };

  // ---- 用例 1：空白处点击 → 应穿透到下方探针
  const emptyScreen = {
    x: Math.round((b.x + pts.empty.x) * mult),
    y: Math.round((b.y + pts.empty.y) * mult),
  };
  const emptyMove = await moveAndVerify(pts.empty);
  let probe0 = probeClicks.length;
  let pet0 = petClicks.length;
  await sendInput('click', { X: emptyScreen.x, Y: emptyScreen.y });
  await sleep(500);
  const emptyProbeDelta = probeClicks.length - probe0;
  const emptyPetDelta = petClicks.length - pet0;
  result.emptyPointClick = {
    injected: emptyScreen,
    moveVerify: emptyMove,
    probeClicksDelta: emptyProbeDelta,
    petClicksDelta: emptyPetDelta,
    pass: emptyProbeDelta >= 1 && emptyPetDelta === 0,
    note: '期望：探针收到点击（穿透成功），宠物不应收到',
  };

  // ---- 用例 2：模型处点击 → 应被宠物接收，不该穿透
  const modelScreen = {
    x: Math.round((b.x + pts.model.x) * mult),
    y: Math.round((b.y + pts.model.y) * mult),
  };
  const modelMove = await moveAndVerify(pts.model);
  probe0 = probeClicks.length;
  pet0 = petClicks.length;
  await sendInput('click', { X: modelScreen.x, Y: modelScreen.y });
  await sleep(500);
  const modelPetDelta = petClicks.length - pet0;
  const modelProbeDelta = probeClicks.length - probe0;
  result.modelPointClick = {
    injected: modelScreen,
    moveVerify: modelMove,
    petClicksDelta: modelPetDelta,
    probeClicksDelta: modelProbeDelta,
    pass: modelPetDelta >= 1,
    note: '期望：宠物收到点击，探针不应收到',
  };

  // ---- 用例 3：拖拽窗口（放最后，因为它会移动窗口）
  const before = win.getBounds();
  const dragStart = await moveAndVerify(pts.model);
  // 注入的是物理像素位移，窗口位置是 DIP，所以期望位移要除以倍率
  const expDx = Math.round(120 / mult);
  const expDy = Math.round(60 / mult);
  // 拖拽期间主进程必须保持响应（轮询光标 + 处理 IPC），所以这里 await 异步执行
  const dragPromise = sendInput('drag', {
    X: modelScreen.x,
    Y: modelScreen.y,
    X2: modelScreen.x + 120,
    Y2: modelScreen.y + 60,
    Steps: 10,
    StepMs: 30,
  });
  const dragResult = await dragPromise;
  await sleep(700);
  const after = win.getBounds();
  result.dragTest = {
    dragStartVerify: dragStart,
    dragInjection: dragResult,
    expected: { dx: expDx, dy: expDy },
    actual: { dx: after.x - before.x, dy: after.y - before.y },
    sizeAfter: { w: after.width, h: after.height },
    pass:
      Math.abs(after.x - before.x - expDx) <= 15 && Math.abs(after.y - before.y - expDy) <= 15,
  };

  // 探针页面自身的计数：用来区分"点击根本没到探针"和"到了但 IPC 没上来"
  try {
    result.probePageCounter = await backdropWin?.webContents.executeJavaScript(
      'document.getElementById("n") ? document.getElementById("n").textContent : null'
    );
  } catch (e) {
    result.probePageCounter = `读取失败: ${String(e)}`;
  }
  result.clickTotals = { probeClicks: probeClicks.length, petClicks: petClicks.length };
  try {
    result.rendererMouseStats = await win.webContents.executeJavaScript('window.__petMouseStats()');
  } catch (e) {
    result.rendererMouseStats = `读取失败: ${String(e)}`;
  }

  // ---- 收尾：把光标放回原处
  if (cursor0 && cursor0.fromX !== undefined) {
    await sendInput('move', { X: cursor0.fromX as number, Y: cursor0.fromY as number });
  }
  result.windowDriftCorrections = windowDrift.slice();
  return result;
}

// ---------------------------------------------------------------- M2 回归测试
/** 连续切换这些动作，验证切换后不会留下上一个动作的素材（id 取自 pack.actions[].id = 文件名去后缀） */
const MOTION_CHAIN = ['手2拿手柄', '手4打招呼', '手5比心'];

async function runM2Tests(win: BrowserWindow): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { motionChain: MOTION_CHAIN };
  if (!SELFTEST_M2) {
    out.skipped = true;
    return out;
  }
  const js = (expr: string): Promise<unknown> => win.webContents.executeJavaScript(expr);

  // 1) 单个动作播完后参数是否复位
  try {
    out.motionResidue = await js(
      `window.__petMotionResidueTest(${JSON.stringify(MOTION_CHAIN[0])})`
    );
  } catch (e) {
    out.motionResidue = { error: String(e) };
  }

  // 2) 用户报的场景：不等播完就连切多个动作
  try {
    out.motionChainResidue = await js(
      `window.__petMotionChainTest(${JSON.stringify(MOTION_CHAIN)})`
    );
  } catch (e) {
    out.motionChainResidue = { error: String(e) };
  }

  // 3) 换装开关：打开多个同组开关应互斥；全部关闭后参数应复位
  try {
    const switchIds = (activePack!.meta as PackMeta & { switches: { id: string; group: string }[] }).switches
      .filter((s) => s.group === '服装')
      .slice(0, 3)
      .map((s) => s.id);
    out.switchTest = await js(`window.__petSwitchTest(${JSON.stringify(switchIds)})`);
  } catch (e) {
    out.switchTest = { error: String(e) };
  }

  // 4) 参数预设层（复刻 VTS 改色热键的机制）
  try {
    out.presetTest = await js('window.__petPresetTest()');
  } catch (e) {
    out.presetTest = { error: String(e) };
  }

  // 5) 帧率上限是否真的生效（改用 30fps 后实测帧率）
  try {
    const countFrames = async (ms: number): Promise<number> => {
      const f0 = (await js('window.__petFrameCounter()')) as number;
      const t0 = Date.now();
      await sleep(ms);
      const f1 = (await js('window.__petFrameCounter()')) as number;
      return ((f1 - f0) * 1000) / (Date.now() - t0);
    };
    const uncapped = await countFrames(1200);
    applySettings({ fpsCap: 30 }, '自检：帧率上限 30');
    await sleep(600);
    const capped30 = await countFrames(1600);
    applySettings({ fpsCap: 60 }, '自检：帧率上限 60');
    await sleep(600);
    const capped60 = await countFrames(1600);
    out.fpsCapTest = {
      uncapped: +uncapped.toFixed(1),
      capped30: +capped30.toFixed(1),
      capped60: +capped60.toFixed(1),
      pass: capped30 <= 36 && capped30 >= 22 && capped60 > capped30 - 2,
    };
  } catch (e) {
    out.fpsCapTest = { error: String(e) };
  }

  // 6) 设置是否落盘（持久化）
  try {
    applySettings({ modelScale: 1.25 }, '自检：缩放 125%');
    await sleep(300);
    const saved = readJsonSafe<PersistedState>(STATE_PATH, { settings: {}, positions: {} });
    const scaled = (await js('window.__petModelScale ? window.__petModelScale() : null')) as number | null;
    applySettings({ modelScale: 1 }, '自检：还原缩放');
    out.persistenceTest = {
      stateFile: path.relative(ROOT, STATE_PATH),
      savedSettings: saved.settings,
      rendererScaleAfterApply: scaled,
      pass: saved.settings.modelScale === 1.25,
    };
  } catch (e) {
    out.persistenceTest = { error: String(e) };
  }

  // 7) 遮挡层：能自动找到图并真的加载进页面
  try {
    const candidate = findOverlayCandidate();
    if (!candidate) {
      out.overlayTest = { skipped: true, reason: '模型目录里没找到遮挡图' };
    } else {
      applySettings({ overlay: candidate }, '自检：遮挡层');
      await sleep(900);
      const st = (await js('window.__petOverlayState()')) as Record<string, unknown>;
      out.overlayTest = { candidate, state: st, pass: st.loaded === true };
      applySettings({ overlay: null }, '自检：关闭遮挡层');
    }
  } catch (e) {
    out.overlayTest = { error: String(e) };
  }

  return out;
}

// ---------------------------------------------------------------- M0 自检
function waitForMetrics(timeoutMs: number): Promise<any> {
  return new Promise((resolve) => {
    metricsResolver = resolve;
    setTimeout(() => {
      if (metricsResolver === resolve) {
        metricsResolver = null;
        resolve({ error: 'renderer metrics timeout' });
      }
    }, timeoutMs);
  });
}

/** 采样整屏截图：把窗口 DIP 坐标换算成物理像素后取点 */
function sampleScreen(win: Electron.BrowserWindow, points: { name: string; x: number; y: number }[]) {
  return new Promise<any>(async (resolve) => {
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const sf = display.scaleFactor;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * sf),
        height: Math.round(display.size.height * sf),
      },
    });
    const src =
      sources.find((s) => String((s as any).display_id) === String(display.id)) || sources[0];
    if (!src) return resolve({ error: 'no screen source' });
    const img = src.thumbnail;
    const size = img.getSize();
    const bmp = img.toBitmap(); // BGRA
    const out: Record<string, any> = { screenshotSize: size, displayScaleFactor: sf };
    for (const p of points) {
      const px = Math.round((p.x - display.bounds.x) * sf);
      const py = Math.round((p.y - display.bounds.y) * sf);
      if (px < 0 || py < 0 || px >= size.width || py >= size.height) {
        out[p.name] = { error: 'out of capture range', px, py };
        continue;
      }
      const i = (py * size.width + px) * 4;
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      out[p.name] = {
        px,
        py,
        rgb: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`,
        isMagenta: r > 200 && g < 60 && b > 200,
        isBackdropWhite: r > 230 && g > 230 && b > 230,
      };
    }
    resolve(out);
  });
}

async function runSelftest(win: BrowserWindow): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const metrics = await waitForMetrics(180_000);

  const b = win.getBounds();
  const samples = await sampleScreen(win, [
    { name: 'outsideLeftBackdrop', x: b.x - 20, y: b.y + Math.round(b.height / 2) }, // 对照点：窗口外，必须是品红
    { name: 'insideTopRight', x: b.x + b.width - 10, y: b.y + 10 }, // 窗口内右上角：应透明 → 品红
    { name: 'insideBottomLeft', x: b.x + 10, y: b.y + b.height - 10 },
    { name: 'insideBottomRight', x: b.x + b.width - 10, y: b.y + b.height - 10 },
    { name: 'center', x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }, // 模型所在：不应是品红
  ]);

  const pagePng = await win.capturePage();
  const shotPath = path.join(OUT_DIR, `page-scale${TEXTURE_SCALE}.png`);
  fs.writeFileSync(shotPath, pagePng.toPNG());

  const controls = samples.outsideLeftBackdrop?.isMagenta === true;
  const cornersTransparent =
    samples.insideTopRight?.isMagenta === true &&
    samples.insideBottomLeft?.isMagenta === true &&
    samples.insideBottomRight?.isMagenta === true;
  const modelVisible = samples.center?.isMagenta === false;

  // 输入注入用例（穿透/拖拽）放在透明取样之后，因为拖拽会移动窗口
  const inputTests = await runInputTests(win);

  // M2 回归测试：动作残留（用户报的"切换动作时素材叠放"）、换装开关互斥与复位、参数预设
  const m2Tests = await runM2Tests(win);

  const report = {
    generatedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    textureScaleRequested: TEXTURE_SCALE,
    runSeconds: RUN_SECONDS,
    pack: {
      id: activePack!.meta.id,
      name: activePack!.meta.name,
      vtsVersion: activePack!.meta.vtsVersion,
      mocVersion: activePack!.meta.moc.version,
      sourceDir: activePack!.meta.sourceDir,
      textures: activePack!.meta.textures.length,
      textureScale: activePack!.meta.textureScale || 0,
      vramRawGB: +(activePack!.meta.textureVramRawBytes / 1024 ** 3).toFixed(3),
      vramPackedGB: +((activePack!.meta.textureVramPackedBytes ?? activePack!.meta.textureVramRawBytes) / 1024 ** 3).toFixed(3),
      model3Used: USE_RAW_TEXTURES ? 'raw（原图）' : 'normalized（导入期降采样）',
      expressions: activePack!.meta.expressionCount,
      motions: activePack!.meta.motionCount,
      parts: activePack!.meta.partCount,
    },
    renderer: metrics,
    transparency: {
      method:
        'pet 窗口下方铺纯品红(#FF00FF)不透明窗口，整屏截屏取样：窗口内空白处应为品红，模型处不应为品红',
      backdropControlVisible: controls,
      transparentAreasShowBackdrop: cornersTransparent,
      modelPixelsOpaque: modelVisible,
      verdict: controls && cornersTransparent && modelVisible ? 'PASS' : 'FAIL',
      samples,
    },
    pageScreenshot: path.relative(ROOT, shotPath),
    inputTests,
    m2Tests,
    settings,
    windowDrift,
    rendererLogs: rendererLogs.slice(-60),
  };

  const reportPath = path.join(OUT_DIR, `report-scale${TEXTURE_SCALE}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('=== M0 SELFTEST REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(`报告: ${reportPath}`);
}

// ---------------------------------------------------------------- 启动
app.whenReady().then(async () => {
  handlePetProtocol();

  if (SELFTEST) {
    const win = createPetWindow();
    try {
      await runSelftest(win);
    } catch (e) {
      console.error('selftest 异常:', e);
    } finally {
      stopDrag();
      if (cursorPoll) {
        clearInterval(cursorPoll);
        cursorPoll = null;
      }
      // app.exit() 实测在本环境下不一定能立刻终止（残留 GPU/子进程），
      // 所以 quit 之后直接用 process.exit 兜底
      app.quit();
      process.exit(0);
    }
    return;
  }

  createPetWindow();
  createTray();
  startCursorPoll();

  if (process.argv.includes('--windowed-help')) console.log('提示：右键托盘图标可退出');
});

app.on('window-all-closed', () => app.quit());
