# 后续改进方向 / Roadmap

> 这是**方向**，不是承诺。这是一个人维护的项目，优先级会随反馈调整。
> 每一项都标了"卡在哪"，方便你判断要不要来认领。
>
> **参与方式**见 [CONTRIBUTING.md](../CONTRIBUTING.md)。想推动某一项，开个 issue 比直接写 PR 更快对齐。

---

## TL;DR (English)

Near-term work is about **narrow-window support**, **host-side notifications**, and **finishing the
docs/screenshots**. Mid-term is about making **upstream upgrades cheap** — the two bundle patches
are the fragile part, so tooling that detects a moved anchor automatically is worth more than any
single feature. Exploratory: code signing, a native Android shell, and any kind of user system.

Explicitly **not** goals: forking the agent runtime or the web frontend, promising Windows/Linux
support, or shipping any kind of built-in model proxy.

---

## 1. 近期 · 路径明确，缺的是时间

### 1.1 窄窗口 / 小屏适配

上游前端是按宽屏设计的。窗口拖窄之后有几处会难受：

- **左栏**：< 1024px 时会折成 56px 图标轨道，在窄窗口里占比过大 → 改成可收起的抽屉
- **软键盘与安全区**：缺应用级的 `visualViewport` 处理和 `env(safe-area-inset-*)`
- **字号与触控目标**：窄屏下内容字号、按钮命中区需要一轮统一调整
- **剪贴板回退**：`navigator.clipboard` 在非安全上下文不可用，需要 `execCommand` 回退

> 卡点：这些改动大多落在**上游前端 bundle** 里，要么推动上游（
> [discussions #229](https://github.com/deepseek-ai/deepseek-harness/discussions/229) /
> [#5482](https://github.com/deepseek-ai/deepseek-harness/discussions/5482) 已经在推这件事），
> 要么按 `patch-brand.mjs` 的模式再加一个补丁。补丁越多，上游升级越贵——见 2.2。

### 1.2 宿主侧通知

回合结束 / 目标受阻 / 有待审批时，从宿主插件推一条到飞书或企业微信机器人。

这条路同时绕开了桌面端窗口不在前台时看不到提示的问题，而且**不需要任何原生客户端**。

> 卡点：没有。这是一个独立插件，可以完全不碰现有代码。

### 1.3 补齐功能截图

README 现在只有主界面和首启声明。缺：

- 用量面板（余额 + 本地重算的 token 账本）
- 置顶 / 挂起
- 过程行折叠的前后对比

> 卡点：这几处需要交互才能出现，`selftest` 的 `capturePage()` 抓不到。
> 拍的时候务必用隔离的 `DSH_HOME`（`DSH_HOME=$(mktemp -d) npm start`），否则会把真实会话标题拍进去。

### 1.4 `postinstall` 改成显式失败

`package.json` 的 `postinstall` 结尾是 `|| true`，会把 `node-pty` 重编译失败**静默吞掉**，
表现成"启动正常但终端/命令执行失灵"，很难查。

> 卡点：当年加上 `|| true` 是因为某些宿主环境必然失败。需要先确认哪些环境该降级、哪些该报错。

### 1.5 Windows / Linux 打包

现在 `build.mac` 是唯一的打包目标。窗口代码本身是跨平台的。

> 卡点：`node-pty` 需要各平台的原生模块；`scripts/package-macos.mjs` 里用了 `sips`/`iconutil`/`hdiutil`，
> 需要按平台拆分。此外非 macOS 平台没有验证环境。

---

## 2. 中期 · 方向明确，方案待定

### 2.1 置顶状态的持久化

`pinned` 的状态存在浏览器 `localStorage`，所以**换目录、换机器就没了**，也不进会话日志。

选项：落到 `~/.dsh` 的设置命名空间（跟随账号），或者作为会话事件的投影写进会话日志。

> 卡点：需要先确认上游是否允许插件写自定义的会话事件——如果不允许，就只能走设置命名空间。

### 2.2 让上游升级变便宜

现在最脆的地方是**两个 bundle 补丁**：上游一改，锚点就失效。而
`@deepseek-ai/dsh` 还在发 rc 版本，前端插件协议没有版本化承诺。

想做的事：

- `npm run check:upstream` —— 拉指定上游版本，只做锚点匹配检测，报告"哪些锚点还在、哪些没了"
- 一个上游新版本发布时的定时 workflow：自动跑上面的检测，失配就开 issue
- 补丁锚点尽量收窄到单行、并附上"上游改这里时该怎么找回来"的说明

> 卡点：无。这是纯工具工作，而且回报最高——它直接决定这个项目能不能跟得上上游。

### 2.3 接管更多品牌 / UI 位

`brand` 插件目前占三个槽位。上游前端里仍有零散的品牌文案与默认值（例如各设置页的说明文字）。
如果上游继续增加槽位，逐步接管比打补丁更持久。

> 卡点：需要逐个确认哪些位置有官方槽位、哪些只能改 bundle——**有槽位才接管，没槽位不打补丁**。

---

## 3. 探索 · 不确定，欢迎讨论

### 3.1 代码签名与公证

现在产物是 ad-hoc 签名、未公证，别人下载会被 Gatekeeper 拦。

> 卡点：需要 Apple 开发者账号（$99/年），且这属于**维护者个人决定**，不是技术问题。

### 3.2 原生安卓壳

宿主留在电脑上，手机当瘦客户端：Android WebView 加载 `dsh web` 的地址 + 前台服务保活 + 本地通知。

> 卡点：需要先有 HTTPS 与身份层（现在 `dsh web` 不带 TLS，而宿主等价于一个 shell）。
> 详见工作区里的移动端可行性评估——那个文档不在本仓库内。

### 3.3 用户体系 / 权限层

上游 harness 没有用户体系：**一个进程一个 owner 凭据**，多人共用一台机器等于共享一个 shell。
这决定了它目前只适合单人使用。

> 卡点：这是上游的设计，不是本外壳能补的。真要做，得在 relay/反代那一层加身份与设备撤销。

---

## 4. 明确的非目标

写下来是为了省掉无效讨论：

- **不 fork agent runtime 或 web 前端。** 上游的 bug 应该去
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 报。
  本仓库只做载体与适配。
- **不承诺 Windows / Linux 官方支持。** 见 1.5——会尽力，但只在有验证环境时才敢说支持。
- **不做内置模型代理 / 请求转发。** 这会让项目变成一个需要信任的中间人，与"数据留在本机"的定位冲突。
- **不引入需要服务端的任何功能。** 一旦有服务端，就多了一个能看你数据的角色。
- **不为了功能而打补丁。** 补丁是债务：有官方槽位就接管，没有就先别做。
