# 应用图标（macOS Dock / 访达 / Cmd-Tab）

`scripts/package-macos.mjs`（`npm run package`）和 electron-builder（`npm run dist`）
都从本目录取图标：放一个文件就行，**不需要改任何配置**。

## 放哪个文件

| 文件 | 行为 |
| --- | --- |
| `build/icon.icns` | 直接嵌入，优先级最高。 |
| `build/icon.png` | 打包脚本用 `sips` + `iconutil` 自动展开成 10 档 icns。 |
| 两个都没有 | 保持 Electron 出厂图标（当前状态）。 |

两者同时存在时以 `icon.icns` 为准。

## 开发模式 vs 打包产物

上面的表只作用于**打包产物**。`npm start` / `npm run selftest` 直接跑 `node_modules`
里的 Electron 二进制，没有 `.app` 外壳可嵌图标，所以：

- 打包后（`npm run dist` / `npm run package`）：Dock / 访达 / Cmd-Tab 显示 HeRoes 图标。
- 开发模式：`main.js` 的 `applyDevelopmentDockIcon()` 会在启动时调 `app.dock.setIcon()`
  把 `build/icon.png` 设成 Dock 图标（仅 macOS，且文件存在时才设）。启动日志里会有
  `dsh-desktop: Dock icon set for this unpackaged run (...)`。
- `build/` 不在 asar 的 `files` 列表里，所以打包版不依赖这个函数——图标已经烘进 bundle 了。

> 看到 Electron 原子 logo 时先确认自己跑的是哪种模式：开发模式若仍显示出厂图标，
> 多半是 `build/icon.png` 不存在。

## 素材规格

- **格式**：PNG（推荐）或 .icns。给 PNG 即可，转 icns 由脚本负责。
- **尺寸**：1024 × 1024 像素，且**必须是正方形**。低于 1024 会被放大导致发虚，
  非正方形脚本会在打包日志里告警。
- **透明通道**：**需要 Alpha**。底色留空，不要自带白底方块。
- **色彩**：sRGB、8 bit/通道。不要提交 CMYK 或灰度图。
- **形状**：macOS **不会**替你把图标裁成圆角矩形。系统原生观感是 1024 画布内
  四周各留约 100 px（可见形状约 824 × 824）、圆角半径约 185 px。
  交一幅满边方图，Dock 里就是一张方图——这是设计选择，不是脚本能补救的。
- **文件大小**：几 MB 以内都可以，最终 icns 通常 100–500 KB。

## 重新打包

```bash
cd heroes-neverdie
npm run package          # 产出 release/manual-<时间戳>/HeRoes NEVERDIE.app
```

打包日志里会有一行 `[package] app icon: ...`，指明本次用了哪个图标。

`.app` 是未签名或 ad-hoc 签名的包，**换图标后不需要重新签名**；Dock 图标缓存
偶尔滞后，`killall Dock` 可强制刷新。

## 只想看效果、不重新打包

直接覆盖现有应用包里的图标文件即可（这是临时手段，重新打包会被覆盖）：

```bash
cp build/icon.icns "/Applications/HeRoes NEVERDIE.app/Contents/Resources/electron.icns"
```

改完必须**完全退出并重启 App**，Dock 才会重新读取图标。
