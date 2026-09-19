# Live2D 桌面宠物工具 —— 设计与技术栈方案

> 目标：做一个可以**导入任意 Live2D Cubism 模型**（尤其 VTube Studio 导出的模型文件夹），把它变成**桌面宠物**的工具。
> 实例模型：一个 VTube Studio 1.32.67 导出的真人模型工程包（下称「示例模型」；模型本身是商用授权资产，不入库、不随仓库分发）。

---

## 0. 先说结论（推荐技术栈）

| 层 | 选型 | 理由 |
|---|---|---|
| 壳 | **Electron 33+（Windows 优先）** | 透明无边框窗口 + 点击穿透生态最成熟；Chromium 保证 WebGL2；不需要额外工具链 |
| 渲染 | **Cubism 5 SDK for Web R5**（官方 Framework + Core，直接吃 TS 源码）+ 原生 WebGL2 canvas（**不用 Pixi**） | moc3 v5 必须 Cubism 5 核心；SDK 自带 renderer/physics/motion/expression，引 Pixi 只增加不确定性和体积 |
| 语言 | TypeScript + Vite（renderer）、Node（main） | 与 SDK 的 TS 源码天然一致 |
| 导入器 | Node + `sharp`（图片降采样）+ zod（校验），CLI 与库双形态 | 贴图优化必须在导入期做，见 §2 |
| UI | 设置面板用 Preact/React + Tailwind（**独立窗口**）；宠物窗口只有一块 canvas | 宠物窗口越“干净”，透明合成和帧率越稳 |
| 打包 | electron-builder（NSIS + 便携版） | 一键出 exe，支持自启/托盘 |
| 备选 | Tauri 2（体积小 ~5MB） | 可行（Windows 走 WebView2=Chromium），但本机无 Rust 工具链，且透明+逐像素穿透要自己写 native 命令；macOS 的 WKWebView + SDK5(R5 起强制 WebGL2) 风险更高 |
| 更重备选 | Cubism Native SDK + Qt/C++ 分层窗口 | 桌面合成最稳（`WS_EX_LAYERED` 逐像素 alpha），但开发成本高一个量级，仅在 Electron 透明合成在本机不可用时才考虑 |

> 本机实测环境：Node v24.16.0 / npm 11.13.0 / pnpm 可用；**未安装 cargo/rustc**（所以 Tauri 不是零成本路径）。

---

## 1. 实例模型实测事实（决定了后面所有设计）

| 事实 | 实测值 | 后果 |
|---|---|---|
| moc3 版本 | 文件头 `MOC3` + 版本字节 **5**（= Cubism 5.0） | 必须 **Cubism 5 SDK for Web**（R1≤R5，推荐 R5）+ 对应 Cubism Core；旧 Core 直接拒绝加载 |
| 贴图 | 8 张：**4×4096² + 4×8192²**，共 145 MB PNG | 显存原始占用 **1280 MB**（+ mipmap ≈1715 MB）→ **必须导入期降采样**（2048 → 128 MB）；8192 若超出 GPU 的 `MAX_TEXTURE_SIZE` 会直接加载失败 → 需要运行时兜底 |
| moc3 体积 | 8.6 MB，**451 个参数**，**131 个 Part**，19 个参数组 | 交互面很丰富；掩码/部件多，绘制开销需实测 |
| model3.json | `Version:3`，**没有 `Expressions`、没有 `Motions`、没有 `HitAreas`**；`Groups` 里 `EyeBlink` 有、**`LipSync` 是空数组** | 不能直接喂给 SDK 当成品模型：**导入器必须自己扫描散落的 `*.exp3.json` / `*.motion3.json` 生成规范化 model3.json**；口型参数要自己找（本模型是 `ParamMouthOpenY`） |
| 散落资源 | **49 个 `*.exp3.json`**（ToggleExpression 热键）+ **6 个 `*.motion3.json`**（4 个手势动作 + 待机动画 + 丢失捕捉动画） | 导入即可用；待机动画来自 `vtube.json → FileReferences.IdleAnimation` |
| VTube Studio 热键 | `vtube.json` 252 KB：49×ToggleExpression、4×TriggerAnimation、**2×ArtMeshColorPreset**（橙色头发+玻璃眼V2 等），触发键是**组合键**（`A`+`N1..N4`、`V`+`N2/N3`） | 可自动生成"动作/表情面板"并按组展示；**ArtMeshColorPreset 无法从 exp3 复现**，需另做"参数快照预设"功能 |
| 物理 | `physics3.json` 176 KB（v3） | 直接用 SDK 的 CubismPhysics，别手写 |
| 其他素材 | `遮挡.png`（遮挡层）、`去水印.exp3.json`、`icon.jpg`、`壁纸.jpg`、`live2d过场动画.mp4` | 遮挡层 → 工具要有"永久叠加遮挡图"功能；`icon.jpg` 直接当托盘/应用图标 |
| 授权 | `使用规则.txt`：禁止分享/转售、禁止上传 AI/用于 AI 训练与 AI 插图、禁止擦水印；维权的版权方为画师；卖家声明"默认使用 VTS 软件" | **绝对不能把 `model/` 打包进安装包、提交到公开仓库、或上传到任何 AI 服务**；见 §7 |

**结论：这个模型不是"拖进去就能跑"的标准 Cubism 导出包，而是一个 VTS 工程包。导入器（VTS → 运行时可读包）是本项目最大的一块差异化工作量，也是必须先做对的部分。**

---

## 2. 总体架构

```
┌──────────────────────────── Electron ────────────────────────────┐
│ main (Node)                                                      │
│  ├─ 窗口管理：透明/无边框/置顶/跳过任务栏/多显示器/拖拽移动/自启   │
│  ├─ 穿透决策：收到 renderer 的 alpha 命中蒙版 → setIgnoreMouseEvents│
│  ├─ 托盘菜单、全局快捷键、单实例锁、设置持久化(electron-store)     │
│  └─ 导入器 IPC：一键导入模型文件夹 → 调用 importer → 返回 pack     │
│ preload（contextBridge，最小权限 API）                            │
│ renderer「宠物窗口」                                              │
│  ├─ webgl2 canvas（alpha:true, 清屏 (0,0,0,0)）                   │
│  ├─ @pet/cubism-runtime：加载/更新/绘制、Expression/Motion/Physics │
│  ├─ 行为引擎：眨眼/呼吸/视线跟随/随机 idle/点击反应                │
│  ├─ 命中蒙版生成：96×96 离屏 FBO + gl.readPixels（~10Hz）→ IPC      │
│  └─ 音频口型：AnalyserNode RMS → ParamMouthOpenY（M3）            │
│ renderer「设置/模型库窗口」（独立窗口，可关）                      │
└──────────────────────────────────────────────────────────────────┘
        ▲ 只读                                       ▲ 读写
        │                                            │
   userData/packs/<modelId>/            model/<原模型文件夹>（**只读，绝不改写**）
   ├─ pack.json（清单/动作表/分组）      └─ 用户的原始 VTS 导出目录
   ├─ model.normalized.model3.json
   ├─ tex/texture_00.png ...（降采样）
   └─ icon.jpg
```

### 目录结构（实际实现：单包 + 分层目录）

> 设计初稿画的是 pnpm monorepo。实做时改成"单 package + 分层目录"：M0–M1 只有 Electron 一个消费方，
> 多包会带来 workspace/打包配置成本而没有收益；边界靠目录与依赖方向保证，等真的要拆（比如独立 CLI 或复用运行时）再拆。

```
desktop-l2d/
  src/main/main.ts           # Electron 主进程：透明窗口 / pet:// 协议 / 穿透 / 拖拽 / 托盘 / 自检
  src/preload/preload.ts     # contextBridge 最小 API
  src/renderer/
    index.html               # 透明页面 + 加载 Core 与打包后的 pet.js
    pet.ts                   # 画布/循环/交互/命中掩码/自检指标
    petmodel.ts              # Cubism 5 R5 运行时（自写，非 sample 拷贝）
    textures.ts              # 贴图加载与降采样
  tools/
    fetch-sdk.cjs            # 从官方站点下载 Cubism SDK（带重试）
    vendor-sdk.cjs           # 把 Core/Framework/Shaders vendor 到 vendor/cubism
    fetch-electron.cjs       # 直连镜像下载 Electron 二进制（绕开弱网 ECONNRESET）
    build.cjs                # esbuild 打包 main/preload/renderer
    import-model.cjs         # VTS/Cubism 目录 → pack（纯 Node，无第三方依赖）
  vendor/cubism/             # SDK 原样副本 + 许可文件（.gitignore）
  userdata/packs/<id>/       # 导入产物（.gitignore）
  out/m0-report/             # M0 自检报告与截图（.gitignore）
  model/                     # 用户模型（.gitignore）
```

---

## 3. 导入器规格（本项目核心）

### 3.1 输入识别
1. 在用户选中的目录里递归找 `*.model3.json`；找不到就报"这不是 Cubism/VTS 模型目录"。
2. 找 `*.moc3`（读文件头校验 `MOC3` + 版本字节）、`FileReferences.Textures[]` 里的 PNG、`Physics`、`DisplayInfo`、同目录 `*.vtube.json`。
3. 校验：moc3 版本 ≤ 当前 Core 支持版本；贴图可解码；记录 `MAX_TEXTURE_SIZE` 与显存预算。

### 3.2 规范化（生成 `model.normalized.model3.json`，不改原文件）
```jsonc
{
  "Version": 3,
  "FileReferences": {
    "Moc": "<模型名>.moc3",
    "Textures": ["tex/texture_00.png", /* …降采样后 */],
    "Physics": "<模型名>.physics3.json",
    "DisplayInfo": "<模型名>.cdi3.json",
    "Expressions": [ { "Name": "腮红", "File": "exp/腮红.exp3.json" } /* 49 项 */ ],
    "Motions": {
      "Idle":        [ { "File": "motion/待机动画.motion3.json" } ],
      "TrackingLost":[ { "File": "motion/丢失捕捉动画.motion3.json" } ],
      "Gesture":     [ /* 手2拿手柄 / 手3喝水 / 手4打招呼 / 手5比心 */ ]
    }
  },
  "Groups": [
    { "Target": "Parameter", "Name": "EyeBlink", "Ids": ["ParamEyeLOpen","ParamEyeROpen"] },
    { "Target": "Parameter", "Name": "LipSync",  "Ids": ["ParamMouthOpenY"] }
  ],
  "HitAreas": [ { "Id": "Head", "Name": "头" }, { "Id": "Body", "Name": "身体" } ]
}
```
- **Expressions**：`vtube.json → Hotkeys[Action==="ToggleExpression"].File` ∪ 目录下所有 `*.exp3.json`（去重），显示名优先用热键的 `Name`（如"圆框眼镜"），否则用文件名。
- **LipSync 自动探测**：按 `cdi3.json → Parameters` 的名称/Id 打分（`ParamMouthOpenY` > `MouthOpen` > `ParamMouthA/I/U/E/O` 组合），命中即写入 `Groups.LipSync`。**不要假设存在**——本模型的 model3.json 里是空的。
- **HitAreas**：`cdi3.json` 的 ArtMesh 列表可能是空的（本模型就是），所以命中区**不靠 JSON**：运行时用 Core 的 `getDrawableBounds/getPartBounds` 求并集得到"头部/身体"的矩形，再让用户在**命中区编辑器**里微调（拖矩形 + 绑定动作）。

### 3.3 贴图优化（必须做，直接影响能不能跑起来）

**已实现：导入期降采样并落盘缓存**（`npm run import:model` → Electron 下用 Skia/nativeImage 缩放，质量 `best`）。

- 默认把每张贴图**降采样到最长边 2048**，写入 `userdata/packs/<id>/tex/`，规范化 model3.json 指向新文件：
  - 本模型实测：145 MB 原图 → **16.5 MB**（8 张 2048²）；显存 **1280 MB → 128 MB**；
  - 启动耗时 **4.7 s → 1.3 s**（省掉 8 张 8K PNG 的解码 + canvas 缩放）。
- **保持 PNG 非预乘 alpha**（不做 `premultiply()`），Cubism 内部按预乘处理贴图，改了就出现边缘黑边/白边。
- 不裁剪、不重排 atlas（重排要重算 UV，属 v2 可选优化）。
- 导入器同时产出 `model.raw.model3.json`（原图版本），`npx electron . --raw` 可用它做对照测量。
- 纯 Node 版（`npm run import:model:node`）没有图片处理能力，此时只生成 JSON，贴图降采样退回运行时兜底。
- 运行时兜底始终生效：读 `gl.getParameter(gl.MAX_TEXTURE_SIZE)`，超限就降采样后再上传，并给出提示。

### 3.4 清单与可追溯
`pack.json`：`{ id, name, sourceDir, sourceMtime, importedAt, moc3Version, textureScale, actions[], toggles[], presets[], icon }`
- `toggles[]`：把"只把若干参数置 0/1"的表达式识别成开关，并按 `cdi3` 的参数组归类（服装 / 物品开关 / 头发开关 / 表情开关 / 尾巴图层…）→ 用户一导入就有一份像样的"换装面板"。
- `actions[]`：热键 → 动作/表情，保留原始组合键信息（`A+N3`），默认绑定改为单键（避免和游戏冲突）但可恢复 VTS 键位。
- **参数快照预设**：因为 VTS 的 `ArtMeshColorPreset`（改色/异瞳）无法从 exp3 复现，提供"抓取当前全部 451 个参数值 → 存为命名预设"，让用户手动复刻那几个改色热键。
- 记录 `sourceMtime`：源模型更新后可"重新导入"而保留用户设置。

---

## 4. 桌面集成（Windows 为主）

```ts
const win = new BrowserWindow({
  width: 520, height: 700,
  transparent: true, frame: false, hasShadow: false, resizable: false,
  skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000',
  webPreferences: { preload, backgroundThrottling: false, contextIsolation: true }
});
```

- **置顶**：`win.setAlwaysOnTop(true, 'normal')`（默认）；提供"悬浮于全屏之上"选项时才用 `'screen-saver'`。
- **逐像素点击穿透**（关键技巧，Electron 没有原生的形状窗口）：
  1. `win.setIgnoreMouseEvents(true, { forward: true })` —— 全窗口穿透，但鼠标移动事件仍转发到 renderer；
  2. renderer 每 ~100 ms 把模型渲染结果降采样到 96×96 的离屏 FBO，`gl.readPixels` 取 alpha，得到命中蒙版，经 IPC 送 main；
  3. main 在 `mousemove` 时查蒙版：命中 → `setIgnoreMouseEvents(false)`，移出 → 回到 `true`。
  这样只有模型实体像素能收到点击，其余区域鼠标直接落到下面的窗口/桌面。
- **拖拽**：renderer 在 `mousedown` 后发 `drag:start`；main 用 `screen.getCursorScreenPoint()` 以 60Hz 轮询并 `setPosition`（比在 renderer 里算 delta 更稳，不会出现抖动/漂移）。松手时按显示器 `workArea` 吸附/夹取，位置按显示器分别记忆。
- **托盘**：用模型的 `icon.jpg`；菜单 = 切换模型 / 动作 / 表情 / 换装开关 / 缩放 / 置顶层级 / 设置 / 退出。
- **快捷键**：默认**仅在宠物窗口聚焦时**响应（避免抢游戏按键）；`globalShortcut` 作为可选开关。VTS 组合键（`A+N3`）解析为"先按 A 再按 N3"的序列。
- **行为引擎**（状态机 + 权重）：
  - 常驻：眨眼（`EyeBlink` 组）、呼吸（`CubismBreath`）、物理（`CubismPhysics`）、视线跟随鼠标（`ParamAngleX/Y/Z` + `ParamEyeBallX/Y`，带平滑与死区）；
  - 随机 idle：待机动画；点击头/身体 → 表情或手势动作；长时间无交互 → 打瞌睡；
  - 可选"桌面漫步"：窗口沿工作区边缘缓慢移动（限制在屏幕内，锁定/全屏应用时暂停）。
- **性能与省电**：帧率上限 30（默认）/60（可选）；窗口被遮挡或不可见时停帧；前台是全屏应用时自动隐藏；`powerMonitor` 感知锁屏/休眠暂停；提供实时 FPS / draw call / 估算显存面板。

---

## 5. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M0 尖刺验证**（1–2 天） | Electron 透明窗口 + 官方 SDK R5 加载本模型（2048 贴图），静态显示 | ① 本机透明合成正常（无黑底/灰条）；② 稳定 ≥30 FPS；③ 打印 `MAX_TEXTURE_SIZE`、draw call、估算显存；④ 手动切 3 个表情、放 1 个动作 |
| **M1 运行时 + 导入器** | pack 生成（含降采样）、眨眼/呼吸/物理/视线、表情与动作播放、窗口拖拽、点击穿透、托盘 | 一条命令导入示例模型目录后可直接出桌宠；穿透在模型外区域 100% 生效 |
| **M2 交互与配置** | 动作/表情/换装面板、命中区编辑器、参数快照预设、缩放位置持久化、遮挡层叠加、置顶层级、多显示器 | 49 个表情 + 6 个动作全部可用且可改名/改键；遮挡层可一键开关 |
| **M3 行为与扩展** | 随机 idle 行为、桌面漫步、点击反应、多模型切换、麦克风口型（RMS→`ParamMouthOpenY`）、TTS/AI 对话钩子（插件式，**不把模型数据外传**） | 挂机 1 小时无内存增长；口型延迟 <100 ms |
| **M4 打包发布** | electron-builder NSIS/便携版、首次运行向导（选模型目录）、自启、诊断页、Live2D 版权声明与授权提示 | 干净机器上装完即可用 |

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 8192² 贴图 / 1.44 GB 显存 | 加载失败、黑屏、驱动重置 | 导入期降采样 2048（默认）；运行时查 `MAX_TEXTURE_SIZE` 兜底再降；诊断页展示显存估算 |
| Electron 透明窗口在部分驱动上变黑/灰条（已知 issue #40515） | 桌宠完全不可用 | **M0 必须先在本机验证**；准备开关（切换 GPU 后端/关闭硬件加速对比）、`backgroundColor:'#00000000'` + `html,body{background:transparent}`；最后手段换 Tauri/WebView2 或 Native 分层窗口 |
| SDK5 R5 起渲染上下文**要求 WebGL2** | 老 GPU/虚拟机上直接失败 | 启动检测 `webgl2`，缺失则提示；必要时回退到 Cubism 5 R1（WebGL1 路径）作为兼容分支 |
| 授权：**Expandable Application** | 若公开发布，需 Live2D 事前审核 + 专门协议（个人/小规模企业免授权费仅限非"可扩展应用"） | 自用/内部使用无此问题；一旦要公开分发，先按 [Expandable Applications](https://www.live2d.com/en/sdk/license/expandable/) 申请；安装包里必须带 Live2D 版权声明 |
| 模型授权：禁止分享/转售/上传 AI | 侵权 + 模型泄漏 | `model/` 进 `.gitignore`；打包时排除用户模型（安装包只带空目录/示例）；不做任何模型内容的上传、遥测、云端渲染 |
| 131 Part + 大量掩码 + 451 参数 | 帧率低、耗电 | 隐藏身体/隐藏头部 等开关降低绘制量；默认关掉不用的物品；锁 30 FPS；离屏 FBO 复用（SDK R5 已内置 offscreen 复用） |
| VTS 专有配置（改色/异瞳 ArtMeshColorPreset） | 导入后行为缺失 | 明确标注"不支持自动迁移"，用"参数快照预设"让用户手工复刻 |
| 组合热键与游戏冲突 | 误触发、抢键 | 默认只在宠物窗口聚焦时生效；全局快捷键为显式开关 |

---

## 7. 授权合规（务必执行）

1. **`model/` 永不入库、永不打包**：仓库根 `.gitignore` 忽略 `model/`、`userdata/`、`vendor/cubism/` 的二进制产物；安装包内置的是"用户自备模型"流程。
2. 卖家规则明确禁止：分享/转售模型、上传 AI 或用于 AI 训练、擦除水印、去除头部遮挡。因此：
   - 工具**不做**任何模型/贴图的联网上传；
   - "去水印"这类表情只作为模型自带的开关呈现，工具不提供去水印能力；
   - `遮挡.png` 提供为一键叠加层，符合"请做好遮挡"的要求。
3. 声称"仅 VTS 可用、其他软件使用不了不退款"是卖家声明——技术上 Cubism SDK 可以正常加载该 moc3，但**用第三方软件承载该模型可能超出卖家的许可范围**，公开使用前建议与画师确认；本工具定位为**本地个人桌面使用**，不对外分发模型。
4. 应用内保留 Live2D Cubism SDK 的版权声明原文（`vendor/cubism/LICENSE`），并在"关于"页展示。

---

## 8. M0 实测结果（已完成，2026-09-19）

跑法（本仓库已实现，两条命令产出 JSON 报告 + 页面截图）：

```powershell
node tools/fetch-sdk.cjs && node tools/vendor-sdk.cjs   # 一次性：vendor 官方 SDK R5
node tools/import-model.cjs "<模型目录>"                # 导入器：生成 pack（纯 Node 版）
npm run selftest                                        # 默认 2048；可加 --scale 16384 对照
```

自检做法：在宠物窗口**下面**铺一层纯品红不透明窗口，然后整屏截屏取样 + 画布 alpha 回读 + 光栅命中掩码交叉校验，
因此"透明是否真的生效""模型到底有没有画出来"都是**客观数据**，不靠肉眼。

| 指标 | 导入期降到 2048（默认，落盘） | 原样 8K（`--raw`） |
|---|---|---|
| 显存（贴图） | **128 MB** | **1280 MB** |
| 启动 / 首帧 | **1.32 s** | 4.68 s |
| 平均帧率 | 141.3 fps（p95 帧时 10.6 ms） | 145.6 fps（p95 8.9 ms） |
| update / draw | 4.4 ms / 2.7 ms | 4.6 ms / 1.4 ms |
| 画布 alpha 覆盖率 | 0.4959 | 0.4963（一致 → 取景对齐） |
| 命中掩码精度 | precision 0.997 / recall 0.959 | — |

**环境**：Windows / Electron 33.4.11 / Chrome 130 / WebGL2 / ANGLE(Intel UHD Graphics, D3D11)，
`MAX_TEXTURE_SIZE`=16384，窗口 520×760 DIP（画布 783×1143，dpr 1.5）。

**结论**：
1. **透明合成 PASS**：窗口内空白处透出品红背景（3 个角全部命中），模型像素非品红，窗口外对照点为品红。
   → Electron 的 `transparent + backgroundColor '#00000000'` 路线在本机可用，**不需要换 Tauri/Native**。
2. **模型可渲染**：`moc3 v5 / 130 Part / 451 参数 / 477 drawable（可见 245）/ 1 个掩码缓冲 / 50 表情 / 7 动作`。
3. **8K 贴图在这台机器上能跑，但不值得**：显存 10 倍、加载多 1.4 s、帧率低 ~7%，而画质在桌宠尺寸下无差异。
   → 默认 2048 是正确取舍；`--scale` 可调，且代码会在 `MAX_TEXTURE_SIZE` 更小的机器上自动再降。
4. **性能余量大**：update 3.8 ms + draw 2.2 ms，离 60 fps 预算（16.6 ms）还有一倍以上空间；
   但 update 的 3.8 ms 是单核 CPU 开销，**锁 30 fps 能省一半电**（M2 做帧率上限设置）。
5. **点击穿透可做到像素级**：用小 FBO（64×93）渲染 + `readPixels` 得到命中掩码，
   与整屏 alpha 真值对比 precision 0.997 / recall 0.962，回读量仅 24 KB，可放心 8 Hz 更新。
6. **点击穿透与拖拽已用 OS 级输入注入闭环验证**（见下节）：空白处点击穿透到下层窗口、模型处点击被接收、
   拖拽位移与期望完全一致（120×60 DIP）。

产物：`out/m0-report/report-scale2048.json`、`report-scale16384.json`、`page-scale*.png`（页面截图，约 670 KB 含模型）。

### M1 已完成的部分

导入器（VTS→pack）、透明桌宠运行时、逆时长动画、眨眼/呼吸/物理/视线跟随、
拖拽移动、逐像素点击穿透、右键原生菜单（按参数组分类的 50 个表情 + 换装开关）、托盘菜单、按键绑定（含 VTS 组合键 `A+N1..N4`）。

### M1 交互验证（自动化，不是"手感描述"）

做法：宠物窗口下方放一个**纯品红探针窗口**（自带点击计数），用 OS 级输入注入
（`SetCursorPos` + `mouse_event`）真的去点/去拖，再核对"谁收到了这次点击"与"窗口移动了多少"。

| 用例 | 期望 | 实测 | 结论 |
|---|---|---|---|
| 窗口内空白处点击 | 穿透到下方探针 | 探针 +1，宠物 +0 | **PASS** |
| 模型实体处点击 | 被宠物接收 | 宠物 +1，探针 +0 | **PASS** |
| 按住模型拖动 120×60（DIP） | 窗口位移 = 120×60 | 位移 = **120×60**（完全一致） | **PASS** |
| 命中掩码 vs 真实像素 | 误差小 | precision 0.997 / recall 0.959 | PASS |
| 导入期贴图降采样落盘 | 8 张 2048²，运行时不再缩放 | `tex/` 16.5 MB；`tex0: 2048x2048 -> 2048x2048, downscaled=false`；启动 1.32 s | PASS |
| 运行时组件装配 | 物理/眨眼/呼吸/视线/表情都在跑 | `updaters={eyeBlink,breath,look,expression,physics,total:5}`（无 pose 段，正确） | PASS |
| 物理是否真的在算 | 物理相关参数持续变化 | 6 秒内 **74/451 个参数在动**，其中 **61 个属于"*物理/头发/衣服/物品"组**（如 `Param142[身体物理]`、`Param84[眼睛物理]`），头/身体 XYZ 也在动 | PASS |
| 透明合成 | 空白处透出下层 | 3 角透出品红、中心为模型像素 | PASS |
| 窗口尺寸稳定性 | 保持 520×760 | 全流程后仍 520×760（创建时漂移 2px 已被纠正） | PASS |
| 渲染进程异常 | 无 | 0 个 error/rejection | PASS |

跑法：`npx electron . --selftest --scale 2048 --seconds 5`（会短暂接管鼠标约 10 秒，随后把光标放回原处；
加 `--no-input-test` 可只跑标定与性能，不注入点击）。

### M2：严重 bug 修复（动作切换时素材叠放）+ 新功能

**用户报的问题**：动作切换时上一个动作的素材不消失，新动作的素材直接叠上去。

**根因（用数据定位，不是猜）**：VTS 的动作把"道具/手势"写进参数后**停在末帧值**——实测 `手2拿手柄` 有 68 条曲线，
其中 **42 条首尾值不同**（`Param45: 0→0.5`、`Param4: 0→1`…），而待机动画只有 27 条曲线、与这 42 条**零重叠**。
于是动作播完后这些参数永久卡住，再触发下一个动作就在旧素材上叠新的。

**修复（5 个环节，每一个都是被自动化测试逼出来的）**：

| # | 环节 | 现象 | 修法 |
|---|---|---|---|
| 1 | 动作结束后没有任何东西把参数拉回来 | 道具/手势永久留在画面上 | 记录每条动作驱动的参数，动作结束/被打断时在 **0.35s 内淡回基准值**（跳过当前动作也在驱动的参数，避免互相打架） |
| 2 | 框架的 `setFinishedMotionHandler` 先把 `_activeMotionId` 置空 | 回退逻辑**从未被调用**（`restoreStats.count=0`） | 不再用完成回调清状态，改由每帧 `isFinished()` 统一处理 |
| 3 | `captureBase()` 读"当前值"，而它是**帧外**被调用的 | 基准被污染成"上一帧的物理/视线/眨眼输出"，回退后把视线角度、闭眼状态**固化**下来 | 基准必须先 `loadParameters()` 回到**保存态**再采样（瞬态效果按设计每帧重算、从不保存） |
| 4 | 覆盖层（换装开关）写在 `saveParameters()` **之前** | 开关值被存进持久状态 → **关不掉**；Add/Multiply 逐帧累积 | 覆盖层移到保存之后、与表情同一阶段（瞬态层），每帧从原始值重算 |
| 5 | 同优先级动作无法互相打断 | `reserveMotion(3)` 对已在播的 3 拒绝 → 连点只切一次 | 强制切换时先 `stopAllMotions()` 并复位 `_currentPriority`（框架不会自己清） |

**同时新增的 M2 功能**：同组开关互斥（默认"服装"，托盘里可按组开关，解决"外套+泳衣""枪+熊+杂志同时挂身上"）、
帧率上限（30/60/不限）、隐藏时暂停渲染、位置/设置持久化、外观预设（复刻 VTS 的改色/异瞳热键）、遮挡层一键叠加。

**验证（`npx electron . --selftest`，含 OS 级输入注入）**：

| 用例 | 判据 | 实测 |
|---|---|---|
| 单个动作播完复位 | 该动作 68 个参数回到动作前 | **maxResidual 0**，violations 0 |
| **连切三个动作**（用户场景） | 227 个参数全部回到动作前 | **maxResidual 0**，3 个动作均真实播放 |
| 换装开关开→关 | 开关参数回位 | `Param329: 0→1→0`、`Param403: 0→1→0`、`Param323: 0→1→0`，残余 0 |
| 同组互斥 | 连开两个同组开关只剩一个 | 开「外套」→[外套]；再开「白T恤」→[白色T恤]，外套被自动关闭 |
| 外观预设层 | 应用生效、清除后复位 | appliedDelta 1，残余 0.0014 |
| 帧率上限 | 设为 30 时实测帧率 | 不限 55.3 → **30fps 实测 27.3** → 60fps 实测 55.1 |
| 设置持久化 | 写盘并被渲染进程采用 | `userdata/state.json` 中 `modelScale=1.25`，渲染进程读回 1.25 |
| 遮挡层 | 自动找到图并加载 | `遮挡.png` 676×283，`loaded=true`，走 `pet://local/overlay/` |
| 点击穿透 / 拖拽 / 透明 | 同 M1 | 全部 PASS，拖拽 120×60 精确一致 |

### 仍需人工确认的只剩"观感"

功能正确性已经用数据闭环，剩下的是纯主观项：① 视线跟随的灵敏度/死区是否舒服；② 拖拽跟手程度；
③ 长挂机（>1 小时）内存是否平稳；④ 帧率上限与省电策略（M2）。

---

## 9. 实现笔记：Cubism 5 SDK for Web R5 的坑（都踩过了）

这些是本项目实际踩到并修掉的，官方 sample 之外没有文档明说。后续维护/升级 SDK 时按此排查：

| # | 现象 | 真相 | 对策 |
|---|---|---|---|
| 1 | 窗口完全不透明/黑底 | **SDK 不会清主帧缓冲**（`preDraw()` 只设 GL 状态；白色 `clearColor` 只用于离屏掩码） | 每帧自己 `gl.clearColor(0,0,0,0); gl.clear(COLOR_BUFFER_BIT)` |
| 2 | `Failed to loadPhysics()` | `loadPhysics(buffer, size)` 的 `size` 传 0 就失败（`loadPose`/`loadUserData` 同理） | 必须传 `buffer.byteLength` |
| 3 | 第一帧就 `Cannot read properties of null (reading 'length')` | `CubismMotion.doUpdateParameters` **无保护地**读 `_eyeBlinkParameterIds.length`，而该字段默认是 null | 每个 motion 载入后都要 `motion.setEffectIds(eyeBlinkIds, lipSyncIds)`（本模型的 LipSync 组是空的，也要传空数组） |
| 4 | 模型跑到画面一角 / 被拉伸变形 | ① `CubismMatrix44.scale()/translate()` 是**覆盖**语义（`_tr[0]=x`），不是累乘；② `CubismViewMatrix.setScreenRect()` **只存边界，不构造投影矩阵**（_tr 仍是单位阵）；③ 宽高比修正因此必须自己写进矩阵 | 自己写 `scale(1/halfW, 1/halfH)` 作为投影，并按窗口长宽比算 `halfW/halfH` |
| 5 | 取景算法对不上 | moc3 v5 的 `getCanvasWidth/Height()`（本模型 1 × 1.4149）**不等于顶点坐标范围**（实测 −0.538…0.483 × −0.717…0.741） | 用**实测可见 drawable 顶点包围盒**来缩放/居中，对任何模型都成立（已写进 `LoadReport.contentBounds` 便于核对） |
| 6 | 换 shader 路径不生效 | R5 起着色器改成**外部文件**，由 `fetch()` 加载（`Framework/Shaders/WebGL/*.vert|frag`） | Electron 里注册自定义协议 `pet://`（standard+secure+supportFetchAPI），把页面、着色器、模型资源都放在**同一 host**（`pet://local/...`）下，避免跨源导致纹理被污染、`readPixels` 失败 |
| 7 | 鼠标事件穿透与拖拽 | Electron 没有形状窗口；**并且 `setIgnoreMouseEvents(true,{forward:true})` 的 mousemove 转发在 Windows 上不可靠**（实测注入移动时渲染进程 `mouseMoveCount` 保持 0，光标移到模型上却仍持续穿透） | **窗口输入状态全部收归主进程**：渲染进程只送"像素级命中掩码"和"指针按下/抬起"，主进程 33Hz 轮询 `getCursorScreenPoint()` 决定穿透、并在超过 4px 位移时判定为拖拽（这样也不依赖 mousemove，异常情况下同样正确） |
| 8 | 帧率上限 | 本机 rAF 跟随 165 Hz 刷新率，跑满会白耗电 | M2 增加帧率上限（30/60）与遮挡/全屏自动暂停 |
| 9 | 无边框透明窗口"自己变大" | 创建/设置样式后窗口尺寸会漂移（实测 520×760 → 522×762），现场日志里表现为画布尺寸连续增长 | 记录目标尺寸并监听 `resize` 纠正；渲染进程侧对 <2px 变化不重建 |
| 10 | 自检脚本卡死 / 用例假失败 | ① `execFileSync` 注入拖拽会**阻塞主进程事件循环**，拖拽期间光标轮询跑不起来 → 误判成"点击"；② `app.exit(0)` 在本环境不一定立刻终止进程；③ `SetCursorPos` 在本机按 **DIP** 解释（不是物理像素，需实测标定） | 注入改异步 `execFile`；退出用 `app.quit()` + `process.exit(0)` 兜底；坐标空间先注入已知点回读 `getCursorScreenPoint()` 标定 |
| 11 | 动作参数永久残留（用户实测的严重 bug） | VTS 动作把道具/手势写进参数后**停在末帧**（本模型 `手2拿手柄` 68 条曲线里 42 条首尾不同），待机只覆盖 27 条且零重叠 → 下一个动作的素材直接叠在旧素材上 | 动作结束/被打断时把该动作驱动的参数**淡回基准值**；参见 §8 的五环节修复 |
| 12 | 该回退"看起来没生效" | 框架的 `motion.setFinishedMotionHandler` 会先把自定义状态清掉，回退分支永远读不到"刚结束的是哪个动作" | 不要用完成回调维护"当前动作"，统一在每帧 `isFinished()` 处判定 |
| 13 | "基准值"被污染成上一帧的物理/视线/眨眼 | 在**帧外**读模型"当前值"时，里面还留着上一帧调度器的输出（物理/呼吸/视线/眨眼按设计每帧重算、从不保存） | 取基准必须先 `loadParameters()` 回到**保存态**再采样 |
| 14 | 换装开关"关不掉" / Add 混合逐帧累积 | 覆盖层写在 `saveParameters()` **之前** → 值被持久化；且 Add 每次基于已加过的值再算 | 覆盖层放在保存之后、与表情同一阶段（瞬态层），每帧从原始值重算；`Overwrite/Add/Multiply` 三种混合都要支持 |
| 15 | 连点动作只切一次 | `reserveMotion(priority)` 对**同优先级**已在播的动作返回 false；且 `stopAllMotions()` 不会自己清 `_currentPriority`，不清就会把待机动作永久拒掉（模型僵在最后一帧） | 强制切换：`stopAllMotions()` + 复位 `_currentPriority/_reservePriority` 后再起新动作 |
| 16 | 动作"永不结束" | 普通 Cubism 模型的动作 `Meta.Loop` 普遍为 true（Live2D 官方 8 个样例的动作全是 Loop=true，VTS 的动作也是），照搬会让桌宠永久卡在动作里，也没有"动作结束"可判定 | 被触发的动作一律一次性播放（`setLoop(false)`），只有待机动画循环；非 VTS 模型按文件名兜底识别待机动作 |
| 17 | CI 里拿不到官方 SDK | GitHub 云机房出口访问不到 `cubism.live2d.com`；而 **Core 只在官方 zip 里**（`CubismWebSamples` 的 `Core/` 目录只有说明文件，jsDelivr 取 `.d.ts` 直接 404），不能拿非官方镜像顶替 | 双来源链路：官方 zip（唯一带 Core）→ GitHub 官方仓库的 Framework 归档；静态检查作业只用后者，冒烟作业拿不到 Core 时输出 `::warning::` 如实跳过。另：`fetch-sdk.cjs` 原来下载失败**不返回非零退出码**，错误被推迟到 vendor 阶段才暴露，已修 |
| 18 | CI 日志读不到（无凭据），失败原因看不见 | GitHub Actions 的日志与 artifact 下载都需要认证 | 把失败诊断打成 **check-run annotations**（`::error title=...::`），可匿名从 API 读到；`tools/test-report.cjs` 的每条失败断言都会带注解 |
| 19 | 性能类断言在 CI 上误报 | runner 无 GPU 走 SwiftShader，单帧渲染慢于 33ms，30fps 上限实测只有 21.9fps | 断言只判"上限是否真的起作用"（不超过上限、明显低于不限帧、60fps 档高于 30fps 档），不要求达到目标帧率 |


## 附：与"现成方案"的取舍

VTube Studio 本身就能透明窗口 + 面部捕捉 + 热键，Live2DViewerEX（Steam 付费）也能做桌宠。自研的价值在于：**行为逻辑可编程**（定点报时、系统监控、番茄钟、直播互动、AI 对话）、**交互与 UI 完全自定义**、**多模型/多角色编排**、以及把这个 VTS 工程包**变成能被脚本驱动的实体**。如果只想要"会眨眼会跟随鼠标的立绘"，直接 VTS/ViewerEX 更省事。

## 附：命令速查

```powershell
node tools/fetch-sdk.cjs                  # 下载官方 Cubism 5 SDK for Web R5（带重试）
node tools/vendor-sdk.cjs                 # vendor 到 vendor/cubism（含许可文件）
npm run import:model                      # 导入 + 贴图降采样落盘（Electron/Skia，推荐）
npm run import:model:node -- "<模型目录>"  # 纯 Node 版：只生成 JSON，贴图运行时降采样
node tools/build.cjs                      # esbuild 打包 main/preload/renderer
npm run selftest                          # 自检：透明 + 性能 + 显存 + 穿透 + 拖拽 + 掩码精度 → out/m0-report/
npx electron . --selftest --seconds 5         # 同上（等价）
npx electron . --selftest --no-input-test     # 不注入点击/拖拽，只测标定与性能
npx electron . --selftest --raw               # 对照：用原图 8K 贴图
npx electron .                                # 交互运行（桌宠）
```
