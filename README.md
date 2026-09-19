# live2d-desktop-pet-electron

（项目内代号 `desktop-l2d`）

把 **Live2D 模型（尤其是 VTube Studio 导出的模型文件夹）变成桌面宠物**的工具。

Electron 透明无边框窗口 + Live2D Cubism 5 SDK for Web 原生运行时（自写，不用 Pixi），
带一个针对 VTS 工程包的**导入器**、逐像素级点击穿透、行为与换装控制。

> 仓库**不含任何模型**：模型是你自己的资产，需要自备。详见文末「授权与合规」。

## 特性

- **VTS 工程包导入**：自动扫出散落的 `*.exp3.json` / `*.motion3.json` / `vtube.json` 热键，
  生成规范化 `pack.json`（本仓库实测样例：50 个表情、6 个动作 + 待机、56 条动作表、
  50 个换装/物品开关按参数组归类），并自动探测口型参数。
- **贴图降采样（导入期落盘）**：8K/4K 贴图缩到最长边 2048 并缓存，**显存 1280MB → 128MB、启动 4.7s → 1.3s**。
  运行时另有 `MAX_TEXTURE_SIZE` 兜底。
- **逐像素级点击穿透**：把模型渲染进小 FBO 回读 alpha 得到命中掩码（precision 0.997 / recall 0.96），
  模型外区域的点击直接落到桌面/下层窗口。
- **动作不会残留**：VTS 动作会把道具/手势写在参数末帧（实测某动作 68 条曲线里 42 条首尾不同、
  且与待机零重叠），本工具在动作结束/切换时把这些参数淡回基准值 —— 连切多个动作后残留为 **0**。
- **换装/物品开关互斥**：同组只保留一个（默认"服装"），避免"外套+泳衣"叠穿；组可按需勾选。
- **省电**：帧率上限 30/60/不限，窗口隐藏时暂停渲染。
- **外观预设**：把当前外观存成预设一键套用（用于复刻 VTS 的改色/异瞳等无法用 exp3 迁移的热键）。
- **遮挡层**：自动找模型目录里的 `遮挡.png` 一键叠加。
- 位置/设置持久化（下次启动回到原处）、托盘菜单、按键绑定（支持 VTS 组合键 `A+N1..N4` 时序）。

## 快速开始

**从源码跑**（开发/自用）：

```powershell
# 0) 依赖（Node 20+；Electron 二进制走镜像直连下载，绕开弱网 ECONNRESET）
npm install --ignore-scripts
node tools/fetch-electron.cjs

# 1) 取官方 Live2D Cubism 5 SDK for Web (R5) 并 vendor 到本地
node tools/fetch-sdk.cjs
node tools/vendor-sdk.cjs

# 2) 导入你自己的模型目录（同时做贴图降采样）；也可以跳过，交给首次运行的向导
npm run import:model -- "<你的模型目录>" --tex 2048

# 3) 构建并运行
npm start
```

**打成安装包**：`npm run dist` → `release/` 下产出 NSIS 安装包与便携版 exe
（`npm run dist:dir` 只出未压缩目录，便于快速验证）。安装包内含 Cubism Core 与着色器，
**不含任何模型**——首次启动会弹向导让你选模型文件夹，原目录只读，导入产物落在用户数据目录。

托盘图标 → 退出。右键宠物本体是原生菜单（动作 / 换装开关 / 位置 / 退出）；
托盘里还有：导入其他模型、回到待机、帧率上限、互斥分组、缩放、遮挡层、外观预设、开机自启动、打开数据目录。

## 自检与验证

内置一套可复现的自检：会在宠物窗口下方铺一层纯品红探针窗口，用整屏截屏取样 + 画布 alpha 回读 +
OS 级输入注入（`SetCursorPos` + `mouse_event`）真去点、去拖，因此"透明是否生效""点击是否真的穿透"
"拖拽是否跟手""动作是否残留"都是数据结论而不是观感描述。

```powershell
npm run selftest                              # 完整自检（约 40s，会短暂接管鼠标）
npx electron . --selftest --no-input-test     # 不注入点击/拖拽
npx electron . --selftest --raw               # 对照：用原图 8K 贴图
```

报告落在 `out/m0-report/report-*.json`（不入库）。实测结论摘要见 [docs/DESIGN.md](docs/DESIGN.md) §8，
开发中踩到的 Cubism 5 R5 实现陷阱（15 条）见 §9。

## 目录结构

```
src/main/        Electron 主进程：透明窗口 / pet:// 本地协议 / 穿透决策 / 拖拽 / 托盘 / 自检
src/preload/     contextBridge 最小 API（宠物窗口、探针窗口各一份）
src/renderer/    透明画布 + 循环 + 交互 + 命中掩码；petmodel.ts 是自写的 Cubism 运行时
tools/           下载/打包/导入/输入注入等脚本
docs/DESIGN.md   设计与实测记录（含 SDK 陷阱与授权说明）
vendor/         第三方依赖的落点（不随仓库分发，见 vendor/README.md）
```

## 测试与 CI

本地可跑的门禁与用例：

```powershell
npm test              # 类型门禁（src/ 必须 0 错误）+ 导入器单元测试（合成夹具）
npm run smoke         # 端到端：导入 SDK 自带示例模型 → 起桌宠自检 → 断言报告
npm run test:report   # 只对最近一次自检报告做断言（--require-transparency 可要求必须验证透明合成）
npm run selftest      # 完整自检（含透明合成与 OS 级输入注入，需要真实桌面）
```

CI（`.github/workflows/ci.yml`）两个作业：

| 作业 | 平台 | 内容 |
|---|---|---|
| `verify` | ubuntu | 取官方 GitHub 仓库的 Cubism Framework → 类型门禁 → 构建 → 导入器测试 → 校验没有把模型/SDK/产物提交进仓库 |
| `smoke` | windows | 下载 Electron 与官方 SDK → 用 SDK 自带的官方示例模型（Haru）走完整链路：导入 → 起桌宠 → 自检 → 断言报告，报告与页面截图作为 artifact 上传 |

两点环境事实（都已在 CI 里处理，不是"应该没问题"）：

- **Core 只存在于官方 zip**：`live2dcubismcore.min.js` 在 GitHub 上没有（`CubismWebSamples` 的 `Core/` 目录只有说明文件），
  所以不上非官方镜像顶替。若某个网络环境访问不到 `cubism.live2d.com`，`smoke` 会输出可见警告并如实跳过，
  不会把静态检查的绿灯伪装成端到端通过；`verify` 不受影响，因为它只需要 Framework。
- **无 GPU 的 runner** 会走 SwiftShader 软件渲染：透明合成与 OS 级输入注入依赖真实桌面，在 CI 中跳过
  （`--no-transparency-test` / `--no-input-test`），其余用例真实执行。

## 授权与合规（重要）

- **本项目代码采用 [MIT 许可证](LICENSE)**，但它**只覆盖本仓库自身的代码**：
  Live2D Cubism SDK（由脚本另行获取）与使用者自备的模型及其衍生数据都不在其覆盖范围内，
  各自遵循各自的授权条款。
- **不要把模型提交进仓库**：`model/`、`userdata/`（含降采样贴图）、`out/`（含截图）都已在 `.gitignore` 中排除。
  虚拟主播模型的授权通常禁止分享/转售/上传 AI，请遵守你所用模型的 `使用规则`。
- **SDK 不随仓库分发**：见 `vendor/README.md`，由脚本从官方渠道获取。
- **公开分发本工具前**请阅读 [Live2D SDK 许可](https://www.live2d.com/en/sdk/license/)：
  允许用户自行导入模型、可扩展性显著的软件可能属于需事前审核的 *Expandable Application*。
- 本工具**不做任何模型内容的联网上传**，无遥测。

## 已知限制

- 主战场是 Windows（透明窗口、点击穿透、托盘均按 Windows 行为实现；其他平台未验证）。
- 模型若带 Cubism Editor 的 `Layout` 段，取景会尊重该 Layout；否则按实测顶点包围盒自动铺满窗口。
- 仅支持 Cubism 3/4/5 的 `moc3`（需 Cubism 5 核心，本仓库按 moc3 v5 实测）。
- VTS 的 `ArtMeshColorPreset`（改色/异瞳）无法从 exp3 迁移，用「外观预设」手工复刻。
