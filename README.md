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

```powershell
# 0) 依赖（Node 20+；Electron 二进制走镜像直连下载，绕开弱网 ECONNRESET）
npm install --ignore-scripts
node tools/fetch-electron.cjs

# 1) 取官方 Live2D Cubism 5 SDK for Web (R5) 并 vendor 到本地
node tools/fetch-sdk.cjs
node tools/vendor-sdk.cjs

# 2) 导入你自己的模型目录（同时做贴图降采样）
npx electron tools/import-cli.cjs "<你的模型目录>" --tex 2048

# 3) 构建并运行
node tools/build.cjs
npx electron .
```

托盘图标 → 退出。右键宠物本体是原生菜单（动作 / 换装开关 / 位置 / 退出）。

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

## 授权与合规（重要）

- **本项目代码采用 [MIT 许可证](LICENSE)**；第三方 SDK 与模型不在其覆盖范围内。
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
