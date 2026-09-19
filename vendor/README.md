# vendor —— 第三方依赖（不随仓库分发）

本目录**不包含任何第三方代码**，克隆后是空的。首次使用前请执行：

```powershell
node tools/fetch-sdk.cjs     # 从 Live2D 官方站点下载 Cubism 5 SDK for Web (R5)
node tools/vendor-sdk.cjs    # 把 Core / Framework / Shaders 解包到 vendor/cubism/
```

## 为什么不用提交进仓库

Live2D Cubism SDK 由 Live2D Inc. 以**专有许可**（Core）与**开放软件许可**（Framework）发布，
许可条款要求使用者自行从官方渠道获取并同意其条款。因此本仓库：

- 不包含 `live2dcubismcore.min.js` 等 Core 文件，也不包含 Framework 源码；
- 只提供下载与解包脚本，SDK 的许可原文随下载内容一起落到 `vendor/cubism/*.md`；
- 开发者与使用者需自行遵守 [Live2D SDK 许可](https://www.live2d.com/en/sdk/license/)，
  公开分发本工具前应确认是否属于需要事前审核的 Expandable Application。

Electron 二进制同样不入库（体积大且可由 npm/镜像重新获取），见 `tools/fetch-electron.cjs`。
