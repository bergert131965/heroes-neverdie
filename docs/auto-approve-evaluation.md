# 「5 秒无操作自动同意」审批开关 — 难度评估（未执行修改）

> 目标：桌面端「设置」内新增一个开关，开启后在审批弹窗上倒计时，**用户无操作满 5 秒**即自动提交「允许一次」。
> 本文只评估，不含改动。所有结论都附 `文件:行号` 真源。

---

## 零、探针结论（2026-09-16 实测，已推翻 §三 发现 B 的不确定性）

**结论：本地手写的客户端插件可以被桌面端启动图收录并真实挂载。** 按原路线的 4–5 天估算成立，无需 fork 官方包或搭建前端构建。

实测证据（dev 实例 `DSH_DESKTOP_SELFTEST=1`，隔离 `DSH_HOME`/`--user-data-dir`）：

| 断言 | 结果 |
|---|---|
| 启动图插件数 | 51 → **52**（`booted 52 client plugins`） |
| 启动图收录本条 | `bootGraph.entries` 含 `@dsh-probe/client-ui-autoapprove-probe`，带 `url` 与 `rev` |
| bundle 可被 shell 载体服务 | advertised combo URL `200`、`text/javascript`、11 056 266 字节、含探针标记 |
| 客户端半侧执行 | 运行时标记 `host half apply()` → `locale registered` → `settings row registered` |
| 真实 UI 渲染 | 打开「设置」后 `[data-slot="settings.general.item"]` 行数 0 → 1，`行渲染` 标记出现 2 次 |

**过程中确认的三个硬约束（正式实现必须遵守）**：

1. **必须拆成两个文件**：host 半侧（Node 里被 import）与 client bundle（浏览器里执行）不能是同一个文件。直接把带 `window` 的代码放进行指向的文件，会让整个插件树以 `window is not defined` 启动失败。
2. **行必须指向具体文件**，不能是目录：`await import(目录)` 解析到 `client.js` 而非 `main`，会把浏览器半侧当 host 半侧加载。
3. **`dsh.client` 声明由「最近的祖先 package.json」提供**（`dsh-client-modules/lib/index.js:664-700` 的 `locatePkgJson`），路径形式的行不需要是真 npm 包，但 `package.json` 必须有 `dsh.client.platform = "web"` 与 `exports["./client"]`。

产物保留：`probe/autoapprove-probe/{package.json,index.js,client.js}`、`probe/boot-probe.js`、`main.js` 中两处 `TEMPORARY (feasibility probe)` 块（都在 `DSH_DESKTOP_SELFTEST=1` 内，打包运行不受影响）。
复现：恢复 `profile/cordis.patch.yml` 里的 `autoapprove-probe` 行，跑
`env -u ELECTRON_RUN_AS_NODE DSH_HOME=/tmp/dsh-home DSH_DESKTOP_SELFTEST=1 DSH_DESKTOP_DISABLE_SANDBOX=1 electron . --user-data-dir=/tmp/dsh-ud`，
读 `/tmp/dsh-ud/selftest-result.json` 的 `bootProbe`。默认已移除该行，日常运行与打包都不含探针。

---

## 一、结论速览

| 维度 | 判断 |
|---|---|
| 整体难度 | **中等偏高**（跨 Host 插件 / 客户端插件 / 设置持久化三层，但不是高不可攀） |
| 纯编码量 | 新增约 **250–350 行**（一个客户端插件 bundle + 一行 profile 配置 + 一个设置命名空间） |
| 是否需要改主进程 `main.js` / `preload.js` / IPC 桥 | **完全不需要**——审批与设置都走已有的 fetch 载体 |
| 是否需要重建前端 dist | **不需要**（关键发现，见 §三） |
| 真正的工作量在哪 | 不是写代码，而是 **§四 的语义定义** 与 **§五 的安全护栏** |
| 建议 | 做成**默认关闭 + 全屏风险告知 + 可撤销**；先只覆盖「允许一次」，不要碰持久权限 |

---

## 二、审批链路（现状）

```
工具请求升权 / 沙箱重试
   └─ Host: ctx.approval.request(req)                    ← dsh-user-approval
        └─ 策略检查：ask → 交给应答者 waterfall；never → 直接拒绝
             └─ 应答者之一：浏览器审批面板（Agent-scoped Remote Event）
                  └─ 渲染端 PendingApproval.answer("allowed-once" | "rejected")
                       └─ 结果回写日志事件 approval/asked + approval/decided
```

关键事实：

1. **面板只提供临时决定**（`dsh-client-ui-approval/README.zh.md` 已知限制）：「允许一次 / 拒绝」，持久策略归 Host 侧所有。
2. **面板是 composer 接管组件**，渲染在 `ApprovalFlow`（`dsh-client-ui-approval/lib/client.js:45-105`），两个按钮最终都调用 `answer()`（同文件 `:49-53`、`:63-67`、`:104-107`）。
3. **`answer()` 是一次性结算**，二次调用会抛 `pending approval <key> is already settled`（`:203-205` 的 `finish()`），因此自动同意必须做**防重**。
4. 候选结果词汇只有 `allowed-once` / `rejected`（`dsh-client-ui-approval/lib/client.js:221-236` 的 `zh` 字典与按钮映射）。
5. **`never` 策略在服务内部、waterfall 分发之前执行**（`dsh-user-approval/README.zh.md`：分发一节）。所以本开关对 `never` 无效，也不会绕过它——这一点是好的。

---

## 三、扩展点（可行性核心，含关键发现）

### 发现 A：待审批对象是「活对象」，可以被第三方插件自动应答

`uiSession.pendingInteractions` 是 `HostObservable<ReadonlyMap<SessionId, PendingApproval>>`，而 `publishPendingInteractions()` 推入 map 的是**领域持有的同一个 interaction 实例**，不是序列化快照：

- `dsh-client-ui-session/lib/types/client/index.d.ts:96`（observable 类型）
- `dsh-client-ui-session/lib/client.js:213-229`（`interaction` 原样放进 map 并广播）
- `dsh-client-ui-approval/lib/client.js:120-205`（`PendingApproval` 就是那个 interaction，`answer()` 在实例上）

⇒ **可以在不改官方插件的前提下，新增一个客户端插件订阅同一 observable，自行 `answer("allowed-once")`。** 这是本方案能低成本落地的原因。

### 发现 B：新增客户端插件不需要重建 dist

`README.zh.md:22` 明确「宿主提供的是已构建的客户端 bundle」；而 bundle 位置由包的 `dsh.client` 声明决定，宿主端由 `clientModules.fetchBundle()` 按记录提供 `/plugins/<id>/client.js`（`dsh-client-modules/lib/index.js:515`、`:213`、`:298`）。

⇒ 只要新包 `package.json` 里声明 `dsh.client`（`platform: 'web'`）并直接**手写 `lib/client.js`**（现有 `dsh-web-frontend` 的 dist 里也全是预构建的 `lib/client.js`），就可以被启动图收录并加载，**无需 pnpm 构建前端**。

⚠️ **待验证前提**：桌面 profile 目前只从真实 npm 包引入客户端插件（如 `@deepseek-ai/dsh-client-ui-directory-picker-native`）。一个**本地路径的新客户端包**能否被启动图收录尚未实测。这是唯一可能推翻"低成本"结论的未知项，建议动工前先用 30 分钟做一次最小探针（加一个只注册设置行的空插件，看 `booted N client plugins` 的 N 是否 +1 且面板无报错）。

### 发现 C：设置项已有现成落点

- 通用设置行槽位：`settings.general.item`（`dsh-client-ui-settings-general/lib/client.js:344` 渲染、`dsh-client-ui-permission-presets/lib/client.js:471-475` 是最贴近的注册范例）
- 持久化：`ctx.remote.settings.mutate(NS, ops)`（`dsh-client-ui-permission-presets/lib/client.js:319`）+ Host 侧 `settings.register(ns, schema)`（`dsh-settings/lib/index.js:281`）
- ⇒ 开关状态落在既有的 `~/.dsh/settings.yaml`，**不引入新存储**

### 发现 D：面板本身支持「复制/文案」级改造

`ApprovalFlow` 的文案来自 locale 字典（`dsh-client-ui-approval/lib/client.js:221-236`）。若希望卡片里显示「5 秒后自动允许」，最干净的办法是在桌面 profile 里注册一个**同 id 覆盖行**注入改写后的面板（因为桌面自持 profile），或退一步：倒计时只在后台静默进行，卡片不显示变化。

---

## 四、必须先定的语义问题（这才是难点）

「5 秒无操作」有两种截然不同的读法，风险差一个数量级：

| 方案 | 语义 | 后果 | 风险 |
|---|---|---|---|
| **T1 到达计时** | 弹窗出现即开始 5 秒倒计时，期间无点击 → 自动允许 | 实现最简单 | **危险**。你去倒水、接电话、切到别的应用时，审批照样自动通过；破坏性命令（rm/推送/发送）会在无人看的情况下执行 |
| **T2 空闲判定** | 仅当**弹窗出现时用户已连续空闲 ≥ N 秒**（且窗口未聚焦/无输入）才启动倒计时 | 只有真正离开键盘才会自动通过 | 明显更安全，需记录全局输入空闲时间 |
| **T3 保持活动** | 鼠标/键盘活动会**重置**倒计时，只有「完全静止 5 秒」才同意 | 与字面描述一致 | 中等：解决问题时的手部停顿可能被误判为同意 |

推荐 **T2 为默认，T3 作为可选项**；T1 作为默认是我不建议的（它把"没来得及点"当成"同意"）。

另外三个必须一并定义的点：

1. **自动通过是否要让用户看见**：若在 Host 侧注册应答者（`approval/request` waterfall），面板根本不出现，审批静默通过——实现更简单但**失去可审计的视觉痕迹**（日志里仍有 `approval/asked|decided`，因此审计不丢）。若在客户端侧做（发现 A），面板正常出现并可见倒计时，透明度更好。
2. **失败语义**：无应答者/超时/断连时应以拒绝关闭（沿用现有 `unavailable` 语义），绝不能让"自动同意"变成"自动兜底通过"。
3. **生效范围**：仅「允许一次」；**不允许**自动点击"完全权限"确认弹窗、不允许改写会话持久策略、不影响 `never`。

---

## 五、安全护栏（必须与开关同时上线）

沿用 `dsh-client-ui-permission-presets` 的既有模式（`预设启用完全权限`就有"我已知晓风险"确认弹窗，`lib/client.js:32-40` 的确认文案）：

1. 开关**默认关闭**；首次开启弹出确认，文案明确写「无人值守时敏感操作将被自动放行」。
2. 开关在**权限分区**内呈现（与「权限」行同区），不要埋在通用设置深处。
3. **只对 `allowed-once` 生效**，且**可配置按工具类型豁免**（例如删除/写入类工具永不自动同意，只对读类自动同意）——建议作为第一阶段的硬编码白名单。
4. **每会话自动同意次数上限**（例如 10 次），超过后退回人工确认，避免"漏斗式放权"。
5. 触发时在会话里留一条**可见记录**（toast 或系统消息），让用户事后知道"哪一步是机器替他点的"。当前 UI 没有这条，需要新增。
6. 主进程侧的窗口聚焦状态可经 `desktopShell` 暴露（`browserWindow.isFocused()`）作为 T2 的输入之一；渲染端自身的输入空闲用 `pointerdown/keydown/focus/blur/visibilitychange` 计时即可。

---

## 六、难度分解（按模块）

| 模块 | 改动 | 难度 | 预估 |
|---|---|---|---|
| 客户端插件骨架 + `dsh.client` 声明 | 新包目录、package.json、手写 `lib/client.js` | 中（发现 B 的未知项） | 0.5 天 |
| 设置行（开关 UI） | `settings.general.item` 注册 + 中英文案 | 低（有现成范例） | 0.25 天 |
| 设置持久化 | 新 namespace + schema + `remote.settings.mutate` | 低 | 0.25 天 |
| 待审批订阅 + 倒计时 + 防重 | 订阅 `pendingInteractions`，定时器，`answer()` 竞态保护 | **中高**（一次性结算 + 重连/重载竞态） | 0.5–1 天 |
| 空闲判定（T2/T3） | 输入事件计时 + 窗口聚焦/可见性 | 中 | 0.5 天 |
| 安全护栏（确认弹窗/次数上限/审计可见） | 新 UI + 状态 | 中 | 0.5 天 |
| 面板倒计时可见化（可选） | 覆盖官方面板或改文案 | 中高（依赖官方内部结构） | 0.5–1 天 |
| profile 接线 | `cordis.patch.yml` 一行 + profile `package.json` 依赖 | 低 | 0.1 天 |
| 测试 | 见 §七 | 中 | 1 天 |

合计（含侦察与测试）：**约 4–5 个工作日**；若发现 B 不成立（本地客户端包无法被启动图收录），需改用真实包结构或 fork 官方面板，追加 **1–2 天**。

**不需要动**：`main.js`、`preload.js`、IPC 桥、`dsh://` 协议、打包脚本。

---

## 七、验证方案（验收前必须全绿）

**V1 静态**

- 开关默认关闭；`~/.dsh/settings.yaml` 写入后重启仍保持。
- 开关关闭时，桥与审批行为与现状**逐字节一致**（回归基线）。

**V2 单元**

- 倒计时只在「开关开 + 有待审批 + 用户空闲达阈值」时启动。
- 任意用户决定（点击/键盘）立即取消倒计时且**不产生第二次 `answer()`**（触发 `already settled` 视为失败）。
- 断连/重载/审批被 abort 时定时器被清理，无悬挂 Promise。

**V3 集成（自检探针扩展）**

- 探针构造一次真实升权请求（例：沙箱外写入），断言：弹出面板 → 无操作 5 秒 → 结果事件为 `allowed-once` 且面板消失。
- 断言 `never` 策略下开关完全无效（请求直接拒绝，面板根本不出现）。
- 断言窗口失焦时行为符合 T2 定义。

**V4 端到端（真实窗口）**

- 场景 1：开启开关后离开工位 30 秒再回来 → 会话中能看到"已自动允许 N 次"的可见记录，且每次都能追溯到具体工具调用。
- 场景 2：中途随时点击"拒绝" → 立即拒绝、倒计时取消、无自动同意。
- 场景 3：连续触发 20 次审批 → 达到次数上限后回退人工确认。
- 场景 4：长会话（>1 小时）+ 开关开启 → 无内存增长、无重复弹窗、无 `already settled` 报错。

---

## 八、建议的落地路径

1. **先做 30 分钟探针**：验证发现 B（本地客户端包能否进启动图）。这是唯一的前置不确定性。
2. 实现 **T2 语义 + 只允许一次 + 默认关闭 + 确认弹窗 + 次数上限**，先不做面板倒计时可见化（静默倒计时）。
3. 通过 V1–V3 后再做 V4 与面板可见化。

## 九、我的保留意见（供判断，不是反对）

这个开关的本质是**用便利换审计与安全边界**。你已经确认"很多插件需要手动确认"确实是痛点，值得解；但同样值得考虑的是**另一条路**：把当前权限预设从"工作区内修改"改成更贴近你实际信任范围的一档，或给常用只读工具做豁免，可能在不引入"无人值守自动放行"的前提下解决大部分确认噪音。两条路可以并行评估，不必先做重的那个。
