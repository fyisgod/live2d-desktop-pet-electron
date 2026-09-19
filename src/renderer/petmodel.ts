/**
 * desktop-l2d 渲染核心：基于 Live2D Cubism 5 SDK for Web (R5) 的官方 Framework 自己实现运行时。
 *
 * 为什么不用官方 sample 的 LApp* 结构：sample 面向"浏览器 demo"，带背景精灵、齿轮 UI、
 * 多画布、状态机式加载；桌宠只需要"一个透明画布 + 一个模型 + 能编程驱动"，
 * 因此这里重写为可直接被行为引擎调用的 API。
 *
 * 许可：Framework 部分适用 Live2D Open Software License，
 *       Core（live2dcubismcore.min.js）适用 Live2D Proprietary Software License。
 *       两者原文都在 vendor/cubism/ 与 pet://local/license/。
 */
import { CubismFramework, LogLevel, Option } from '@framework/live2dcubismframework';
import { CubismModelSettingJson, ICubismModelSetting } from '@framework/cubismmodelsettingjson';
import { CubismDefaultParameterId } from '@framework/cubismdefaultparameterid';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import { CubismModel } from '@framework/model/cubismmodel';
import { BreathParameterData, CubismBreath } from '@framework/effect/cubismbreath';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { CubismLook, LookParameterData } from '@framework/effect/cubismlook';
import { CubismPose } from '@framework/effect/cubismpose';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismModelMatrix } from '@framework/math/cubismmodelmatrix';
import { CubismViewMatrix } from '@framework/math/cubismviewmatrix';
import { CubismUpdateScheduler } from '@framework/motion/cubismupdatescheduler';
import { CubismExpressionUpdater } from '@framework/motion/cubismexpressionupdater';
import { CubismPhysicsUpdater } from '@framework/motion/cubismphysicsupdater';
import { CubismPoseUpdater } from '@framework/motion/cubismposeupdater';
import { CubismEyeBlinkUpdater } from '@framework/motion/cubismeyeblinkupdater';
import { CubismBreathUpdater } from '@framework/motion/cubismbreathupdater';
import { CubismLookUpdater } from '@framework/motion/cubismlookupdater';
import { CubismMotion } from '@framework/motion/cubismmotion';
import { ACubismMotion } from '@framework/motion/acubismmotion';
import { CubismLogError, CubismLogInfo } from '@framework/utils/cubismdebug';
import { createModelTexture, LoadedTexture } from './textures';

export const PriorityNone = 0;
export const PriorityIdle = 1;
export const PriorityNormal = 2;
export const PriorityForce = 3;

/** 从 motion3.json 里取出这条动作驱动了哪些参数（用于动作结束后回退） */
function extractCurveIds(buffer: ArrayBuffer): string[] {
  try {
    const json = JSON.parse(new TextDecoder().decode(buffer)) as {
      Curves?: { Id?: string }[];
    };
    const ids: string[] = [];
    for (const c of json.Curves || []) {
      if (c.Id) ids.push(c.Id);
    }
    return ids;
  } catch {
    return [];
  }
}

/** 一条参数覆盖：值 + 混合模式（与 exp3.json 的 Blend 字段一致） */
export interface ParamOverride {
  id: string;
  value: number;
  blend?: 'Add' | 'Overwrite' | 'Multiply' | string;
}

/** 从 exp3.json 解析出它要施加的参数覆盖 */
export function parseExpressionOverrides(buffer: ArrayBuffer): ParamOverride[] {
  try {
    const json = JSON.parse(new TextDecoder().decode(buffer)) as {
      Parameters?: { Id?: string; Value?: number; Blend?: string }[];
    };
    return (json.Parameters || [])
      .filter((p) => !!p.Id)
      .map((p) => ({ id: p.Id as string, value: p.Value ?? 0, blend: p.Blend || 'Add' }));
  } catch {
    return [];
  }
}

export interface PackAction {
  id: string;
  label: string;
  kind: 'expression' | 'motion' | string;
  file: string;
  triggers?: string[];
  stopOnLastFrame?: boolean;
}

export interface PackInfo {
  id: string;
  name: string;
  moc: { file: string; version: number; bytes: number };
  model3: { file: string; normalized: string; raw?: string };
  textures: { file: string; width: number; height: number; vramBytes: number }[];
  textureVramRawBytes: number;
  lipSyncParamIds: string[];
  actions: PackAction[];
  switches: { id: string; label: string; file: string; parameterId: string | null; group: string }[];
  idle: { file: string; lost: string | null } | null;
  icon: string | null;
  partCount: number;
  expressionCount: number;
  motionCount: number;
  parameters: { id: string; name: string; group: string }[];
}

export interface LoadOptions {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** 例如 pet://local/pack/ */
  packBaseUrl: string;
  /** 例如 pet://local/shaders/ */
  shaderPath: string;
  maxTextureEdge: number;
  pack: PackInfo;
  /** 用哪个 model3.json（导入器会同时产出规范化版与原图版） */
  model3File?: string;
  /** moc3 一致性校验（首次导入后建议开启一次，平时关闭以加快启动） */
  mocConsistency?: boolean;
}

export interface LoadReport {
  loadMs: number;
  mocVersion: number;
  canvasWidth: number;
  canvasHeight: number;
  modelCanvasWidth: number;
  modelCanvasHeight: number;
  parts: number;
  parameters: number;
  drawables: number;
  visibleDrawables: number;
  maskBuffers: number;
  expressions: number;
  motions: number;
  textures: {
    file: string;
    src: string;
    uploaded: string;
    downscaled: boolean;
    vramMB: number;
  }[];
  vramMB: number;
  vramWithMipMB: number;
  contentBounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    drawablesUsed: number;
  } | null;
  viewHalf: { w: number; h: number };
  modelScale: number | null;
  updaters: Record<string, number | boolean>;
}

export class PetModel extends CubismUserModel {
  private _gl: WebGL2RenderingContext = null!;
  private _canvas: HTMLCanvasElement = null!;
  private _packBaseUrl = '';
  private _shaderPath = '';
  private _updateScheduler = new CubismUpdateScheduler();
  private _look: CubismLook | null = null;
  private _viewMatrix = new CubismViewMatrix();
  private _viewHalf = { w: 1, h: 1 };
  private _contentBounds: { minX: number; minY: number; maxX: number; maxY: number; used: number } | null =
    null;
  private _mvp = new CubismMatrix44();
  private _userTimeSeconds = 0;
  private _motionUpdated = false;
  private _textures: LoadedTexture[] = [];
  private _expressions = new Map<string, ACubismMotion>();
  private _motions = new Map<string, CubismMotion>();
  private _idleIds: string[] = [];
  private _eyeBlinkIdList: any[] = [];
  private _lipSyncIdList: any[] = [];
  /** 已装配的 updater 清单（报告里作为"物理/眨眼/呼吸/视线真的接上了"的证据） */
  private _updaters: Record<string, boolean> = {};
  /**
   * 动作残留修复用状态。
   *
   * 背景：VTS 的动作（手2拿手柄/手4打招呼…）里有大量曲线结束时停在非零值
   * （本模型实测：68 条曲线中 42 条首尾值不同），而待机动画只覆盖 27 条、与之零重叠。
   * 于是动作播完后这些参数永远卡在末帧 → 道具/手势留在画面上，再触发下一个动作就叠一层。
   * 对策：动作结束（或被新动作打断）时，把它驱动的参数在 0.35s 内淡回"动作之前的基准值"。
   */
  private _motionParamIds = new Map<string, string[]>();
  private _allMotionParamIds: string[] = [];
  private _baseParams = new Map<string, number>();
  private _restore: { ids: string[]; targets: number[]; t: number; duration: number } | null = null;
  /** 参数覆盖层（复刻 VTS 的改色/换装开关）：每帧从"未覆盖的原始值"重新施加，动作可临时覆盖 */
  private _presetLayer = new Map<string, ParamOverride>();
  /** 已开启的"开关型"表情：id -> 它要施加的参数覆盖 */
  private _switchLayer = new Map<string, ParamOverride[]>();
  private _scaleMultiplier = 1;
  private _restoreStats = { count: 0, lastIds: 0 };
  /** 待机动画驱动的参数（回归测试里要排除，否则会把待机的正常摆动误判成残留） */
  private _idleParamIds: string[] = [];
  private _activeMotionId: string | null = null;
  private _activeExpressionId: string | null = null;
  private _mocVersion = 0;
  private _loaded = false;
  private _baseline: Float32Array | null = null;
  private _maskFbo: WebGLFramebuffer | null = null;
  private _maskTex: WebGLTexture | null = null;
  private _maskSize = { cols: 0, rows: 0 };
  private _stats = { updateMs: 0, drawMs: 0, frames: 0 };

  private static _frameworkReady = false;

  /** CubismFramework 全局初始化（Core 必须在 index.html 中先加载） */
  public static ensureFramework(logLevel: LogLevel = LogLevel.LogLevel_Warning): void {
    if (PetModel._frameworkReady) return;
    const option = new Option();
    option.logFunction = (msg: string): void => console.log('[cubism]', msg);
    option.loggingLevel = logLevel;
    CubismFramework.startUp(option);
    CubismFramework.initialize();
    PetModel._frameworkReady = true;
  }

  public get loaded(): boolean {
    return this._loaded;
  }

  public get stats(): { updateMs: number; drawMs: number; frames: number } {
    return this._stats;
  }

  public get viewMatrix(): CubismViewMatrix {
    return this._viewMatrix;
  }

  /** 逻辑坐标视口半宽高（宽高比修正用） */
  public get viewHalf(): { w: number; h: number } {
    return this._viewHalf;
  }

  public get expressionIds(): string[] {
    return [...this._expressions.keys()];
  }

  public get motionIds(): string[] {
    return [...this._motions.keys()];
  }

  public get activeExpressionId(): string | null {
    return this._activeExpressionId;
  }

  public get activeMotionId(): string | null {
    return this._activeMotionId;
  }

  // ------------------------------------------------------------------ 加载
  public async load(opts: LoadOptions): Promise<LoadReport> {
    const t0 = performance.now();
    this._gl = opts.gl;
    this._canvas = opts.canvas;
    this._packBaseUrl = opts.packBaseUrl;
    this._shaderPath = opts.shaderPath;
    this._mocConsistency = !!opts.mocConsistency;

    const fetchBuf = async (url: string): Promise<ArrayBuffer> => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`加载失败 ${res.status}: ${url}`);
      return await res.arrayBuffer();
    };

    // 1) 规范化 model3.json
    const settingUrl = this._packBaseUrl + encodeURI(opts.model3File || opts.pack.model3.normalized);
    const setting = new CubismModelSettingJson(await fetchBuf(settingUrl));
    this._modelSetting = setting;

    // 2) moc3
    const mocName = setting.getModelFileName();
    const mocBuf = await fetchBuf(this._packBaseUrl + encodeURI(mocName));
    this._mocVersion = this.getMocVersionFromBuffer(mocBuf);
    this.loadModel(mocBuf, this._mocConsistency);
    const model = this.getModel();
    if (!model) throw new Error('CubismModel 创建失败');

    // 3) 物理
    const physicsName = setting.getPhysicsFileName();
    if (physicsName) {
      const buf = await fetchBuf(this._packBaseUrl + encodeURI(physicsName));
      this.loadPhysics(buf, buf.byteLength); // 注意：size 必须传真实字节数，传 0 会直接失败
    }

    // 4) 姿态（多数 VTS 模型没有）
    const poseName = setting.getPoseFileName();
    if (poseName) {
      const buf = await fetchBuf(this._packBaseUrl + encodeURI(poseName));
      this.loadPose(buf, buf.byteLength);
    }

    // 5) 用户数据
    const userDataName = setting.getUserDataFile();
    if (userDataName) {
      const buf = await fetchBuf(this._packBaseUrl + encodeURI(userDataName));
      this.loadUserData(buf, buf.byteLength);
    }

    // 6) 表情 / 动作（来自导入器生成的 pack，而不是 model3.json）
    // 注意：R5 的 CubismMotion.doUpdateParameters 会无保护地读 _eyeBlinkParameterIds.length，
    // 所以每个 motion 都必须先 setEffectIds()，否则第一帧更新就会抛 TypeError。
    const eyeBlinkIds: any[] = [];
    for (let i = 0; i < setting.getEyeBlinkParameterCount(); i++) {
      eyeBlinkIds.push(setting.getEyeBlinkParameterId(i));
    }
    const lipSyncIds: any[] = [];
    for (let i = 0; i < setting.getLipSyncParameterCount(); i++) {
      lipSyncIds.push(setting.getLipSyncParameterId(i));
    }
    this._lipSyncIdList = lipSyncIds;
    this._eyeBlinkIdList = eyeBlinkIds;

    for (const a of opts.pack.actions) {
      try {
        const buf = await fetchBuf(this._packBaseUrl + encodeURI(a.file));
        if (a.kind === 'expression') {
          const exp = this.loadExpression(buf, buf.byteLength, a.id);
          if (exp) this._expressions.set(a.id, exp);
        } else {
          const motion = this.loadMotion(buf, buf.byteLength, a.id) as CubismMotion;
          if (motion) {
            motion.setEffectIds(eyeBlinkIds, lipSyncIds);
            motion.setFadeInTime(a.stopOnLastFrame ? 0.3 : 0.5);
            motion.setFadeOutTime(0.3);
            if (a.stopOnLastFrame) motion.setLoop(false);
            this._motions.set(a.id, motion);
            // 记录这条动作驱动哪些参数 —— 动作结束时要把它们淡回基准值
            const ids = extractCurveIds(buf);
            if (ids.length) this._motionParamIds.set(a.id, ids);
          }
        }
      } catch (e) {
        CubismLogError(`动作加载失败 ${a.file}: ${String(e)}`);
      }
    }
    {
      const union = new Set<string>();
      for (const ids of this._motionParamIds.values()) for (const id of ids) union.add(id);
      this._allMotionParamIds = [...union];
    }
    if (opts.pack.idle?.file) {
      try {
        const buf = await fetchBuf(this._packBaseUrl + encodeURI(opts.pack.idle.file));
        const idle = this.loadMotion(buf, buf.byteLength, '__idle') as CubismMotion;
        if (idle) {
          idle.setEffectIds(eyeBlinkIds, lipSyncIds);
          idle.setLoop(true);
          idle.setFadeInTime(0.5);
          this._motions.set('__idle', idle);
          this._idleIds.push('__idle');
          this._idleParamIds = extractCurveIds(buf);
        }
      } catch (e) {
        CubismLogError(`待机动画加载失败: ${String(e)}`);
      }
    }
    if (opts.pack.idle?.lost) {
      try {
        const buf = await fetchBuf(this._packBaseUrl + encodeURI(opts.pack.idle.lost));
        const lost = this.loadMotion(buf, buf.byteLength, '__lost') as CubismMotion;
        if (lost) {
          lost.setEffectIds(eyeBlinkIds, lipSyncIds);
          lost.setLoop(false);
          this._motions.set('__lost', lost);
        }
      } catch {
        /* 可选资源 */
      }
    }

    // 7) 眨眼 / 呼吸 / 视线跟随（沿用官方 sample 的参数曲线）
    const ids = CubismFramework.getIdManager();
    const idAngleX = ids.getId(CubismDefaultParameterId.ParamAngleX);
    const idAngleY = ids.getId(CubismDefaultParameterId.ParamAngleY);
    const idAngleZ = ids.getId(CubismDefaultParameterId.ParamAngleZ);
    const idBodyAngleX = ids.getId(CubismDefaultParameterId.ParamBodyAngleX);

    if (setting.getEyeBlinkParameterCount() > 0) {
      this._eyeBlink = CubismEyeBlink.create(setting);
      this._updateScheduler.addUpdatableList(
        new CubismEyeBlinkUpdater(() => this._motionUpdated, this._eyeBlink)
      );
      this._updaters.eyeBlink = true;
    }

    this._breath = CubismBreath.create();
    this._breath.setParameters([
      new BreathParameterData(idAngleX, 0.0, 15.0, 6.5345, 0.5),
      new BreathParameterData(idAngleY, 0.0, 8.0, 3.5345, 0.5),
      new BreathParameterData(idAngleZ, 0.0, 10.0, 5.5345, 0.5),
      new BreathParameterData(idBodyAngleX, 0.0, 4.0, 15.5345, 0.5),
      new BreathParameterData(
        ids.getId(CubismDefaultParameterId.ParamBreath),
        0.5,
        0.5,
        3.2345,
        1.0
      ),
    ]);
    this._updateScheduler.addUpdatableList(new CubismBreathUpdater(this._breath));
    this._updaters.breath = true;

    this._look = CubismLook.create();
    this._look.setParameters([
      new LookParameterData(idAngleX, 30.0, 0.0, 0.0),
      new LookParameterData(idAngleY, 0.0, 30.0, 0.0),
      new LookParameterData(idAngleZ, 0.0, 0.0, -30.0),
      new LookParameterData(idBodyAngleX, 10.0, 0.0, 0.0),
      new LookParameterData(ids.getId(CubismDefaultParameterId.ParamEyeBallX), 1.0, 0.0, 0.0),
      new LookParameterData(ids.getId(CubismDefaultParameterId.ParamEyeBallY), 0.0, 1.0, 0.0),
    ]);
    this._updateScheduler.addUpdatableList(new CubismLookUpdater(this._look, this._dragManager));
    this._updaters.look = true;

    if (this._expressionManager) {
      this._updateScheduler.addUpdatableList(
        new CubismExpressionUpdater(this._expressionManager)
      );
      this._updaters.expression = true;
    }
    if (this._physics) {
      this._updateScheduler.addUpdatableList(new CubismPhysicsUpdater(this._physics));
      this._updaters.physics = true;
    }
    if (this._pose) {
      this._updateScheduler.addUpdatableList(new CubismPoseUpdater(this._pose));
      this._updaters.pose = true;
    }
    this._updateScheduler.sortUpdatableList();

    // 8) 渲染器 + 贴图
    this.createRenderer(this._canvas.width, this._canvas.height);
    const renderer = this.getRenderer();
    renderer.startUp(this._gl);
    renderer.loadShaders(this._shaderPath);

    const usePremultiply = true;
    renderer.setIsPremultipliedAlpha(usePremultiply);
    const texNames = setting.getTextureCount();
    for (let i = 0; i < texNames; i++) {
      const name = setting.getTextureFileName(i);
      if (!name) continue;
      const tex = await createModelTexture(
        this._gl,
        this._packBaseUrl + encodeURI(name),
        name,
        opts.maxTextureEdge
      );
      this._textures.push(tex);
      renderer.bindTexture(i, tex.glTexture);
    }

    // 9) 取景：必须先跑一次参数装载/更新，顶点数据才是有效的
    model.loadParameters();
    model.update();
    this.applyFraming(setting);
    // 参数基线快照：之后用它证明物理/呼吸/眨眼在驱动参数
    model.loadParameters();
    model.update();
    this._baseline = this.sampleParameters();

    this._loaded = true;
    this._motionManager.stopAllMotions();
    this.startIdle();

    const vram = this._textures.reduce((a, t) => a + t.vramBytes, 0);
    const report: LoadReport = {
      loadMs: Math.round(performance.now() - t0),
      mocVersion: this._mocVersion,
      canvasWidth: this._canvas.width,
      canvasHeight: this._canvas.height,
      modelCanvasWidth: model.getCanvasWidth(),
      modelCanvasHeight: model.getCanvasHeight(),
      parts: model.getPartCount(),
      parameters: model.getParameterCount(),
      drawables: model.getDrawableCount(),
      visibleDrawables: this.countVisibleDrawables(),
      maskBuffers: (() => {
        try {
          const mgr = renderer.getClippingManager();
          return mgr ? mgr.getClippingMaskCount() : 0;
        } catch {
          try {
            return renderer.getRenderTextureCount();
          } catch {
            return 0;
          }
        }
      })(),
      expressions: this._expressions.size,
      motions: this._motions.size,
      textures: this._textures.map((t) => ({
        file: t.file,
        src: `${t.srcWidth}x${t.srcHeight}`,
        uploaded: `${t.uploadedWidth}x${t.uploadedHeight}`,
        downscaled: t.downscaled,
        vramMB: +(t.vramBytes / 1024 ** 2).toFixed(1),
      })),
      vramMB: +(vram / 1024 ** 2).toFixed(1),
      vramWithMipMB: +((vram * 1.34) / 1024 ** 2).toFixed(1),
      contentBounds: this._contentBounds
        ? {
            minX: +this._contentBounds.minX.toFixed(4),
            minY: +this._contentBounds.minY.toFixed(4),
            maxX: +this._contentBounds.maxX.toFixed(4),
            maxY: +this._contentBounds.maxY.toFixed(4),
            drawablesUsed: this._contentBounds.used,
          }
        : null,
      viewHalf: this._viewHalf,
      modelScale: this._modelMatrix ? +this._modelMatrix.getScaleX().toFixed(4) : null,
      updaters: { ...this._updaters, total: this._updateScheduler.getUpdatableCount() },
    };
    CubismLogInfo(
      `模型就绪: moc v${report.mocVersion}, 贴图 ${report.textures.length}, 显存 ≈${report.vramMB}MB`
    );
    return report;
  }

  /**
   * 视口用的逻辑坐标半宽/半高。
   *
   * 重要：R5 里 CubismViewMatrix 只保存 screenRect/maxScreenRect（用于触摸换算与缩放夹取），
   * setScreenRect 并不会构造投影矩阵；而 CubismMatrix44.scale()/translate() 是"覆盖"语义
   * （_tr[0]=x，不是累乘）。所以宽高比修正必须由我们自己写进 _tr，
   * 否则模型会被窗口长宽比拉伸变形。
   */
  private computeViewHalf(): { w: number; h: number } {
    const ratio = this._canvas.width / this._canvas.height;
    return ratio >= 1 ? { w: ratio, h: 1 } : { w: 1, h: 1 / ratio };
  }

  /** 投影矩阵：把逻辑坐标盒 [-w,w]×[-h,h] 映射到 NDC（即 NDC = 逻辑 / 半宽高） */
  private buildProjection(half: { w: number; h: number }): CubismViewMatrix {
    const vm = new CubismViewMatrix();
    vm.scale(1 / half.w, 1 / half.h);
    vm.setScreenRect(-half.w, half.w, -half.h, half.h);
    vm.setMaxScreenRect(-half.w * 2, half.w * 2, -half.h * 2, half.h * 2);
    vm.setMaxScale(2.0);
    vm.setMinScale(0.5);
    return vm;
  }

  private applyFraming(setting: ICubismModelSetting): void {
    const model = this.getModel();
    const half = this.computeViewHalf();
    const mm = new CubismModelMatrix(model.getCanvasWidth(), model.getCanvasHeight());

    // 不要用 getCanvasWidth/Height 当顶点坐标范围：moc3 v5 的画布尺寸与顶点实际范围
    // 并不一致（本模型画布 1x1.4149，而顶点落在约 0..0.4 x 0..0.93）。
    // 所以直接实测可见 drawable 的顶点包围盒来取景，对任何模型都成立。
    const b = this.measureContentBounds();
    if (b) {
      const bw = Math.max(1e-6, b.maxX - b.minX);
      const bh = Math.max(1e-6, b.maxY - b.minY);
      const scale = 0.98 * this._scaleMultiplier * Math.min((2 * half.w) / bw, (2 * half.h) / bh);
      mm.scale(scale, scale); // R5 是覆盖语义：直接写最终缩放
      mm.translate(-((b.minX + b.maxX) / 2) * scale, -((b.minY + b.maxY) / 2) * scale);
      this._contentBounds = b;
    } else {
      const layout = new Map<string, number>();
      try {
        setting.getLayoutMap(layout);
      } catch {
        /* 无 Layout */
      }
      if (layout.size > 0) mm.setupFromLayout(layout);
      else mm.setCenterPosition(0, 0);
    }
    this._modelMatrix = mm;
    this._viewHalf = half;
    this._viewMatrix = this.buildProjection(half);
  }

  /** 可见 drawable 的顶点包围盒（模型坐标系） */
  private measureContentBounds(): { minX: number; minY: number; maxX: number; maxY: number; used: number } | null {
    const model = this.getModel();
    if (!model) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let used = 0;
    for (let i = 0; i < model.getDrawableCount(); i++) {
      if (!model.getDrawableDynamicFlagIsVisible(i)) continue;
      if (model.getDrawableOpacity(i) <= 0.02) continue;
      const count = model.getDrawableVertexCount(i);
      if (count < 3) continue;
      const v = model.getDrawableVertexPositions(i);
      for (let k = 0; k < count; k++) {
        const x = v[k * 2];
        const y = v[k * 2 + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      used++;
    }
    if (!isFinite(minX) || used === 0) return null;
    return { minX, minY, maxX, maxY, used };
  }

  /** 画布尺寸变化（窗口缩放）时重建投影 */
  public resize(width: number, height: number): void {
    this._canvas.width = width;
    this._canvas.height = height;
    if (!this._loaded) return;
    this.setRenderTargetSize(width, height);
    const renderer = this.getRenderer();
    if (renderer) renderer.setRenderTargetSize(width, height);
    // 长宽比变了要重算取景：模型矩阵也一起重建
    if (this._modelSetting) this.applyFraming(this._modelSetting);
  }

  // ------------------------------------------------------------------ 每帧
  public update(deltaTimeSeconds: number): void {
    if (!this._loaded) return;
    const t0 = performance.now();
    this._userTimeSeconds += deltaTimeSeconds;
    const model = this.getModel();

    model.loadParameters();

    this._motionUpdated = false;
    if (this._motionManager.isFinished()) {
      // 先把队列/优先级内部状态归位（stopAllMotions 之后 _currentPriority 不会自己清零，
      // 不归零的话待机动作会被"优先级不足"永久拒绝，模型就僵在最后一帧）
      this._motionManager.updateMotion(model, 0);
      const ended = this._activeMotionId;
      if (ended && ended !== '__idle') this.beginRestore(ended);
      this._activeMotionId = null;
      this.startIdle();
    } else {
      this._motionUpdated = this._motionManager.updateMotion(model, deltaTimeSeconds);
    }

    this.applyRestore(deltaTimeSeconds);

    // 保存"基准 + 动作"的干净状态（不含覆盖层），这样覆盖层随时可以撤销
    model.saveParameters();

    // 参数覆盖层（换装开关/外观预设）：放在保存之后、与表情同一阶段施加。
    // 关键：绝不写进持久状态，否则 Add/Overwrite 会被保存下来，
    // 表现为"开关关不掉""每帧累积把参数推到天上"。
    this.applyOverrides(model);

    this._updateScheduler.onLateUpdate(model, deltaTimeSeconds);
    model.update();
    this._stats.updateMs = performance.now() - t0;
  }

  /** 当前是否在播"手势/动作"（待机不算） */
  private isGesturePlaying(): boolean {
    return !!this._activeMotionId && this._activeMotionId !== '__idle';
  }

  /**
   * 施加参数覆盖层（预设 + 已开启的换装开关）。
   * Add/Multiply 必须基于"未覆盖的原始值"计算，否则每帧累积会把参数推到天上去。
   */
  private applyOverrides(model: CubismModel): void {
    const entries: ParamOverride[] = [];
    for (const [, e] of this._presetLayer) entries.push(e);
    for (const [, list] of this._switchLayer) for (const e of list) entries.push(e);
    if (!entries.length) return;

    const raw = new Map<string, number>();
    for (const e of entries) {
      if (raw.has(e.id)) continue;
      const v = this.getParameter(e.id);
      raw.set(e.id, v === null ? 0 : v);
    }
    for (const e of entries) {
      const base = raw.get(e.id) ?? 0;
      const blend = (e.blend || 'Add').toLowerCase();
      if (blend === 'add') this.setParameter(e.id, base + e.value, 1);
      else if (blend === 'multiply') this.setParameter(e.id, base * e.value, 1);
      else this.setParameter(e.id, e.value, 1); // overwrite
    }
  }

  /** 开启/关闭一个"开关型"表情（换装、贴纸、物品…） */
  public setSwitchActive(switchId: string, overrides: ParamOverride[], active: boolean): void {
    if (active) this._switchLayer.set(switchId, overrides);
    else this._switchLayer.delete(switchId);
  }

  public isSwitchActive(switchId: string): boolean {
    return this._switchLayer.has(switchId);
  }

  public get activeSwitches(): string[] {
    return [...this._switchLayer.keys()];
  }

  /**
   * 基准快照：记下"动作之外应该是什么样"，动作结束后按它回退。
   *
   * 只在**动作开始前的干净时刻**调用。曾经写成"每帧在无动作时快照"，结果踩坑：
   * 动作结束的那一帧，保存状态里仍是动作的末帧值（框架的淡出尾帧），
   * 于是基准被污染成"动作姿态"，回退就把姿态又拉回去了。
   */
  private captureBase(): void {
    const model = this.getModel();
    if (!model) return;
    // 必须先 loadParameters() 回到"保存态"再读：
    // 这个函数是在帧外（用户触发/测试调用）执行的，此刻"当前值"里还留着上一帧
    // 物理/呼吸/视线/眨眼的输出（那些按设计每帧重算、从不保存）。
    // 直接读当前值会把"上一帧的视线角度、闭眼状态"当成基准，回退时再把它固化下来 —— 实测踩过。
    model.loadParameters();
    for (const id of this._allMotionParamIds) {
      const v = this.getParameter(id);
      if (v !== null) this._baseParams.set(id, v);
    }
  }

  /** 动作结束/被打断：把该动作驱动的参数记为"待回退"（与进行中的回退合并） */
  private beginRestore(motionId: string): void {
    const ids = this._motionParamIds.get(motionId);
    if (!ids || !ids.length) return;
    const map = new Map<string, number>();
    if (this._restore) {
      for (let i = 0; i < this._restore.ids.length; i++) {
        map.set(this._restore.ids[i], this._restore.targets[i]);
      }
    }
    for (const id of ids) map.set(id, this.baseTarget(id));
    this._restore = { ids: [...map.keys()], targets: [...map.values()], t: 0, duration: 0.35 };
    this._restoreStats.count++;
    this._restoreStats.lastIds = ids.length;
  }

  /** 该参数的"动作之外"应有值：优先用基准快照，没有就用 moc 里定义的默认值 */
  private baseTarget(id: string): number {
    const base = this._baseParams.get(id);
    if (base !== undefined) return base;
    const model = this.getModel();
    if (!model) return 0;
    const index = model.getParameterIndex(CubismFramework.getIdManager().getId(id));
    return index >= 0 ? model.getParameterDefaultValue(index) : 0;
  }

  /** 把待回退参数在一个短淡出里拉回基准值（跳过当前动作也在驱动的参数，避免互相打架） */
  private applyRestore(deltaTimeSeconds: number): void {
    const r = this._restore;
    if (!r) return;
    r.t += deltaTimeSeconds;
    const w = Math.min(1, r.t / r.duration);
    const currentIds = this._activeMotionId ? this._motionParamIds.get(this._activeMotionId) : null;
    for (let i = 0; i < r.ids.length; i++) {
      const id = r.ids[i];
      if (currentIds && currentIds.indexOf(id) >= 0) continue;
      this.setParameter(id, r.targets[i], w);
    }
    if (w >= 1) this._restore = null;
  }

  public draw(): void {
    if (!this._loaded) return;
    const t0 = performance.now();
    // 每次都从 view 矩阵重新合成，避免 sample 里反复 multiplyByMatrix 造成的累积误差
    this._mvp.setMatrix(this._viewMatrix.getArray());
    this._mvp.multiplyByMatrix(this._modelMatrix);
    const renderer = this.getRenderer();
    renderer.setMvpMatrix(this._mvp);
    renderer.setRenderState(null, [0, 0, this._canvas.width, this._canvas.height]);
    renderer.drawModel(this._shaderPath);
    this._stats.drawMs = performance.now() - t0;
    this._stats.frames++;
  }

  // ------------------------------------------------------------------ 控制
  public startIdle(): void {
    for (const id of this._idleIds) {
      if (this.startMotionById(id, PriorityIdle)) return;
    }
  }

  /** 供行为引擎调用：按 id 播放动作 */
  public startMotionById(id: string, priority = PriorityNormal): boolean {
    const motion = this._motions.get(id);
    if (!motion) return false;

    // 同等最高优先级下的"强制切换"：点第二次动作要立刻换过去，而不是被 reserveMotion 拒掉
    if (
      id !== '__idle' &&
      priority >= PriorityForce &&
      this._motionManager.getCurrentPriority() >= PriorityForce
    ) {
      if (this._activeMotionId && this._activeMotionId !== '__idle') {
        this.beginRestore(this._activeMotionId);
      }
      this._motionManager.stopAllMotions();
      this._motionManager.updateMotion(this.getModel(), 0); // 清理队列
      // stopAllMotions 不会自己把"当前优先级"归零，不归零的话新动作会被 reserveMotion 拒掉
      // （_currentPriority 在框架里是公开字段，这里直接复位）
      this._motionManager._currentPriority = PriorityNone;
      this._motionManager.setReservePriority(PriorityNone);
    }

    if (priority < this._motionManager.getCurrentPriority()) return false;
    if (!this._motionManager.reserveMotion(priority)) return false;

    // 干净时刻快照基准：只在"当前没有手势动作"时拍，避免把上一个动作的姿态当成基准
    if (id !== '__idle' && !this.isGesturePlaying()) this.captureBase();

    // 切换动作：先把上一个动作驱动的参数登记为待回退，否则它的道具/手势会留在画面上
    if (id !== '__idle' && this.isGesturePlaying() && this._activeMotionId) {
      this.beginRestore(this._activeMotionId);
    }
    this._motionManager.startMotionPriority(motion, false, priority);
    this._activeMotionId = id;
    return true;
  }

  public startRandomMotion(ids: string[], priority = PriorityNormal): boolean {
    if (ids.length === 0) return false;
    const id = ids[Math.floor(Math.random() * ids.length)];
    return this.startMotionById(id, priority);
  }

  /** 表情：同名再点一次即关闭（对应 VTS 的 ToggleExpression 语义） */
  public toggleExpression(id: string): 'on' | 'off' | 'missing' {
    const exp = this._expressions.get(id);
    if (!exp) return 'missing';
    if (this._activeExpressionId === id) {
      this._expressionManager.stopAllMotions();
      this._activeExpressionId = null;
      return 'off';
    }
    exp.setFadeInTime(0.2);
    this._expressionManager.startMotion(exp, false);
    this._activeExpressionId = id;
    return 'on';
  }

  public clearExpression(): void {
    this._expressionManager.stopAllMotions();
    this._activeExpressionId = null;
  }

  /** 视线跟随：nx/ny 为窗口内归一化坐标（-1..1） */
  public setGaze(nx: number, ny: number): void {
    this._dragManager.set(nx, ny);
  }

  /** 参数快照（用于证明物理/呼吸/眨眼确实在驱动参数） */
  public sampleParameters(): Float32Array {
    const model = this.getModel();
    const n = model.getParameterCount();
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = model.getParameterValueByIndex(i);
    return out;
  }

  /**
   * 与载入后的基线快照对比：哪些参数在动？
   * 物理演算驱动的参数集中在"*物理/尾巴/头发/衣服"等组里，按组名统计即可作为
   * "物理真的在工作"的证据，而不必去猜具体是哪根头发在摆。
   */
  public parameterActivity(pack: PackInfo): Record<string, unknown> {
    const model = this.getModel();
    if (!this._baseline || !model) return { error: 'no baseline' };
    const groupOf = new Map(pack.parameters.map((p) => [p.id, p.group]));
    const physicsLike = /物理|尾巴|头发|衣服|物品|手势/;
    const n = Math.min(model.getParameterCount(), this._baseline.length);
    let changed = 0;
    let physicsChanged = 0;
    const examples: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
      const v = model.getParameterValueByIndex(i);
      if (Math.abs(v - this._baseline[i]) <= 0.01) continue;
      changed++;
      const handle = model.getParameterId(i) as unknown as { getString?: () => string };
      const id = handle && typeof handle.getString === 'function' ? handle.getString() : `#${i}`;
      const group = groupOf.get(id) || '';
      if (physicsLike.test(group)) physicsChanged++;
      if (examples.length < 8) {
        examples.push({ id, group, from: +this._baseline[i].toFixed(3), to: +v.toFixed(3) });
      }
    }
    return { total: n, changed, changedInPhysicsGroups: physicsChanged, examples };
  }

  // ------------------------------------------------------------------ M2：缩放 / 预设 / 诊断
  /** 模型缩放倍数（相对"自动铺满窗口"的基准） */
  public setModelScale(k: number): void {
    this._scaleMultiplier = Math.max(0.2, Math.min(3, k));
    if (this._modelSetting) this.applyFraming(this._modelSetting);
  }

  public get modelScale(): number {
    return this._scaleMultiplier;
  }

  /**
   * 导出当前外观为预设：返回"覆盖层"的内容（颜色/异瞳这类需要快照才能复刻的改动）。
   * 注意不要导出全部参数的瞬时值 —— 那会把呼吸/物理的正常摆动静噪一起存进去。
   */
  public exportPreset(): Record<string, ParamOverride> {
    const out: Record<string, ParamOverride> = {};
    for (const [id, e] of this._presetLayer) out[id] = { ...e };
    return out;
  }

  /** 应用参数预设：作为每帧重施的"预设层"，动作可以临时覆盖它 */
  public applyPreset(preset: Record<string, ParamOverride | number>): number {
    this._presetLayer.clear();
    let n = 0;
    for (const [id, v] of Object.entries(preset || {})) {
      if (v === null || v === undefined) continue;
      const entry: ParamOverride =
        typeof v === 'number' ? { id, value: v, blend: 'Overwrite' } : { ...v, id };
      this._presetLayer.set(id, entry);
      n++;
    }
    return n;
  }

  /** 预设层覆盖了哪些参数（回归测试只比对这批 id） */
  public get presetParamIds(): string[] {
    return [...this._presetLayer.keys()];
  }

  /** 某条开关覆盖了哪些参数 */
  public switchParamIds(switchId: string): string[] {
    return (this._switchLayer.get(switchId) || []).map((e) => e.id);
  }

  public clearPreset(): void {
    this._presetLayer.clear();
  }

  public get presetSize(): number {
    return this._presetLayer.size;
  }

  /**
   * 取"会被保存下来"的参数状态（先 loadParameters 回到保存值再采样）。
   * 动作残留这类问题必须这样测：直接采样当前值会混入物理/呼吸/视线这些每帧重算的抖动。
   */
  public sampleSavedParameters(): Float32Array {
    const model = this.getModel();
    if (model) model.loadParameters();
    return this.sampleParameters();
  }

  /** 同上，但返回 id -> 值 的字典，便于回归测试逐参数比对 */
  public snapshotSaved(): Record<string, number> {
    const model = this.getModel();
    const out: Record<string, number> = {};
    if (!model) return out;
    model.loadParameters();
    for (let i = 0; i < model.getParameterCount(); i++) {
      const handle = model.getParameterId(i) as unknown as { getString?: () => string };
      const id = handle && typeof handle.getString === 'function' ? handle.getString() : `#${i}`;
      out[id] = +model.getParameterValueByIndex(i).toFixed(5);
    }
    return out;
  }

  /**
   * 取"当前实际渲染用"的参数（含覆盖层与物理/呼吸等瞬态效果）。
   * 测换装开关/外观预设这类瞬态层时必须用它，因为那些效果按设计不进持久状态。
   */
  public snapshotCurrent(): Record<string, number> {
    const model = this.getModel();
    const out: Record<string, number> = {};
    if (!model) return out;
    for (let i = 0; i < model.getParameterCount(); i++) {
      const handle = model.getParameterId(i) as unknown as { getString?: () => string };
      const id = handle && typeof handle.getString === 'function' ? handle.getString() : `#${i}`;
      out[id] = +model.getParameterValueByIndex(i).toFixed(5);
    }
    return out;
  }

  /** 待机动画驱动的参数 id（回归测试里要排除，否则会把待机摆动误判成残留） */
  public get idleParamIds(): string[] {
    return this._idleParamIds;
  }

  /**
   * 把所有参数复位到 moc 默认值（回归测试的隔离手段：
   * 上一个用例留下的残留会污染下一个用例的基准，必须先把状态洗干净）
   */
  public resetParametersToDefault(): void {
    const model = this.getModel();
    if (!model) return;
    this._restore = null;
    this._presetLayer.clear();
    this._switchLayer.clear();
    for (let i = 0; i < model.getParameterCount(); i++) {
      model.setParameterValueByIndex(i, model.getParameterDefaultValue(i), 1);
    }
    model.saveParameters();
    this._baseParams.clear();
  }

  /** 供回归测试用：这条动作驱动哪些参数 */
  public getMotionParamIds(motionId: string): string[] {
    return this._motionParamIds.get(motionId) || [];
  }

  public get restoreStats(): { count: number; lastIds: number; pending: boolean } {
    return { ...this._restoreStats, pending: !!this._restore };
  }

  /** 直接读写参数（给行为引擎/开关面板用） */
  public setParameter(id: string, value: number, weight = 1): boolean {
    const model = this.getModel();
    if (!model) return false;
    const index = model.getParameterIndex(CubismFramework.getIdManager().getId(id));
    if (index < 0) return false;
    model.setParameterValueByIndex(index, value, weight);
    return true;
  }

  public getParameter(id: string): number | null {
    const model = this.getModel();
    if (!model) return null;
    const index = model.getParameterIndex(CubismFramework.getIdManager().getId(id));
    if (index < 0) return null;
    return model.getParameterValueByIndex(index);
  }

  public countVisibleDrawables(): number {
    const model = this.getModel();
    if (!model) return 0;
    let n = 0;
    for (let i = 0; i < model.getDrawableCount(); i++) {
      if (model.getDrawableDynamicFlagIsVisible(i) && model.getDrawableOpacity(i) > 0.05) n++;
    }
    return n;
  }

  /**
   * 像素级命中网格：把模型渲染到一张很小的离屏 FBO，再 readPixels 回读 alpha。
   *
   * 相比"顶点包围盒"方案，这得到的是真实轮廓（含掩码/淡出后的形状），
   * 回读量只有 cols*rows*4 字节（64x93 ≈ 24KB），不会造成可见的管线停顿。
   * 命中 = 保持接收鼠标事件；未命中 = setIgnoreMouseEvents(true) 让鼠标落到桌面。
   */
  public updateHitMask(cols = 64): { cols: number; rows: number; bits: Uint8Array; hits: number } | null {
    const gl = this._gl;
    const model = this.getModel();
    const renderer = this.getRenderer();
    if (!gl || !model || !renderer || !this._loaded) return null;

    const rows = Math.max(1, Math.round((cols * this._canvas.height) / this._canvas.width));
    if (
      !this._maskFbo ||
      this._maskSize.cols !== cols ||
      this._maskSize.rows !== rows
    ) {
      if (this._maskTex) gl.deleteTexture(this._maskTex);
      if (this._maskFbo) gl.deleteFramebuffer(this._maskFbo);
      this._maskTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this._maskFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._maskFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._maskTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this._maskSize = { cols, rows };
    }

    const px = new Uint8Array(cols * rows * 4);
    try {
      renderer.setRenderState(this._maskFbo, [0, 0, cols, rows]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const mvp = new CubismMatrix44();
      mvp.setMatrix(this._viewMatrix.getArray());
      mvp.multiplyByMatrix(this._modelMatrix);
      renderer.setMvpMatrix(mvp);
      renderer.drawModel(this._shaderPath);
      gl.readPixels(0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      renderer.setRenderState(null, [0, 0, this._canvas.width, this._canvas.height]);
      const mvp = new CubismMatrix44();
      mvp.setMatrix(this._viewMatrix.getArray());
      mvp.multiplyByMatrix(this._modelMatrix);
      renderer.setMvpMatrix(mvp);
    }

    const bits = new Uint8Array(cols * rows);
    let hits = 0;
    const threshold = 24;
    for (let i = 0; i < cols * rows; i++) {
      if (px[i * 4 + 3] > threshold) {
        bits[i] = 1;
        hits++;
      }
    }
    // GL 的 y 轴向上，转成"第一行在顶部"，方便直接按客户端坐标查表
    const flipped = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const src = (rows - 1 - r) * cols;
      flipped.set(bits.subarray(src, src + cols), r * cols);
    }
    return { cols, rows, bits: flipped, hits };
  }
}
