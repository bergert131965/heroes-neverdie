# DeepSeek 用量面板（desktop profile 自有插件）

桌面端侧栏底部的用量面板：把 DeepSeek **官方唯一公开的用量类数据（账户余额）** 与本机
**token 用量重算账本** 并排展示，并给出费用估算。

```text
侧栏底部  📊 用量  93.82 CNY        ← 点开后
┌─────────────────────────────────────────┐
│ 官方账户                                 │
│   官方余额 · CNY            93.82        │
│   账户可用                  是            │
│ 本地 token 用量                          │
│   总 token（本地累计）      235.84M       │
│   缓存命中输入        224,877,952 · 99.4% │
│   缓存未命中输入            1,466,062     │
│   输出                      1,469,080     │
│ 估算花费（本地重算）        1.776 USD     │
│   折合人民币                ≈ 12.6 CNY    │
│ 按天用量（柱状图） / 用量最高的会话 / 数据来源 │
└─────────────────────────────────────────┘
```

## 文件

| 文件 | 角色 |
|---|---|
| `client-host.js` | Host 半：注册两条 `GET /api/usage/*` 路由，解析凭据、转发官方接口、读取本地用量 |
| `client.js` | Browser 半：注册 `sidebar.footer.action` 占位，渲染按钮与面板 |
| `package.json` | 双面包声明（`main` + `dsh.client`） |
| `selftest.mjs` | Host 半自测（真实 DSH home + 真实接口） |
| `selftest-client.mjs` | Browser 半自测（模拟模块加载器 + 环回服务器跑真实路由） |

挂载位置是 `profile/cordis.patch.yml` 的 `insert` 块：

```yaml
- id: usage-panel
  name: ./plugins/usage-panel/client-host.js
```

## 数据来源

| 数字 | 来源 | 权威性 |
|---|---|---|
| 余额、`is_available` | `GET https://api.deepseek.com/user/balance` | **官方**，真金白银的锚点 |
| token 四个桶 | `$DSH_HOME/storages/session_projcache/sessions/*.json` 的 `record.rows.tokenUsage.val.totals` | 本地重算，仅覆盖本机发出的请求 |
| 回退路径 | 会话日志 `session.jsonl.zstd` 中的 `usage` 字段 | 同上，用于投影缓存尚未写入的会话 |
| 费用 | 固定单价表 × token 桶 | **估算** |

官方**不提供** token 用量查询或账单接口，所以历史消耗只能由客户端自己记账——这正是
harness 已经在做的：`dsh-llm-deepseek` 解析每次响应的 `usage`，`dsh-token-meter` 把它折成
`tokenUsage` 投影落盘。本插件只是把这个已有事实读出来展示，不重复记账。

## 路由

| 路由 | 说明 |
|---|---|
| `GET /api/usage/balance[?refresh=1]` | 官方余额；成功结果在 host 侧缓存 30 秒，避免 UI 轮询打到官方接口 |
| `GET /api/usage/tokens?scope=all` | 全量聚合：桶、比率、费用、按天、Top 会话、来源诊断 |
| `GET /api/usage/tokens?scope=current&sessionId=<id>` | 单会话聚合 |

凭据通过 `ctx.credentials.resolve("DEEPSEEK_API_KEY")` 在 **host 进程内**解析，密钥永不进入
渲染进程；凭据缺失时返回结构化的 `usage/credential-missing` 而不是抛异常。

## 配置

```yaml
- id: usage-panel
  name: ./plugins/usage-panel/client-host.js
  config:
    apiKeyEnv: DEEPSEEK_API_KEY          # 凭据引用名
    apiBase: https://api.deepseek.com     # 官方基址，可指向代理
    pricing:                              # 单价表（每 1M token，USD）
      currency: USD
      cacheHit: 0.003                     # 缓存命中输入
      cacheMiss: 0.15                     # 缓存未命中输入
      output: 0.6                         # 输出
      usdToCny: 7.1                       # 仅用于折算展示
```

默认值取官方**非高峰**价（高峰翻倍）。持久日志只有 token 桶、没有逐次请求时间戳，所以只有
一张平价表、费用必然是估算——这一点在面板里明确标注。

## 三个必须知道的实现约束

这三条都是实测踩出来的，改动前请先读：

1. **裸 `fetch` 在桌面端到不了 host。** 桌面 shell 把桥接挂在
   `globalThis.__DSH_TRANSPORT__.fetch`，**故意不覆盖页面全局 `fetch`**（`dsh-client-connection`
   直接读 `transport.fetch`）。因此页面里 `fetch("/api/…")` 仍然是原生 fetch，在 `file://`
   下直接被 Electron 拒绝（`TypeError: Failed to fetch`），IPC 请求根本不会发出。
   浏览器半必须用 `resolveFetch()` 优先取载体。

2. **`file://` 页面的 `location.origin` 是字符串 `"file://"`。** 照着它拼 URL 会得到
   `file:///api/...`。`dsh-client-connection` 的 `resolveBase()` 判的是 `"null"`，
   在 Electron 里这个判断不成立，所以本插件按**协议**判断（`/^https?:$/`），非 http(s)
   一律落到 `http://dsh.internal`。

3. **入口文件名必须与 manifest 的 `main` 一致。** `dsh-client-modules` 通过“从模块位置向上找
   最近的 `package.json`”来定位 `dsh.client` 声明：Loader 行若指向 `./plugins/usage-panel/index.js`，
   最近的清单会是 profile 自己的 `package.json`（没有 `dsh.client`），客户端 bundle 会**静默**不组合。
   这里把 host 入口命名为 `client-host.js`，与 `main` 完全一致，让 Loader 行、清单、bundle 三者对齐。
   （行也可以直接写包目录，但显式文件更不容易踩错。）

另外：会话日志是 zstd 压缩的，回退路径依赖 Node 内置的 `zlib.zstdDecompressSync`。

## 弹窗高度与内部滚动

报告比一般笔记本窗口高，而共享的 `Modal` 原语**自身不设高度上限**——对话框会一直长到超出
视口，把标题栏和报告顶部顶到屏幕外。因此浏览器半通过 `className` / `contentClassName`
（原语用 `clsx` **追加**这两个类，不是替换）挂上两条规则：

- `.dsh-usage-modal` — 兜底把对话框整体限制在视口内；
- `.dsh-usage-content` — 把内容包装成 flex 列并 `overflow-y: auto`，让超长报告在**弹窗内部**
  滚动，标题栏与「刷新 / 关闭」始终可见。

实测（1440×868 视口）：对话框 35 → 833，完全落在窗口内；内容区 `clientHeight 718`、
`scrollHeight 1216`，`scrollTop` 可正常移动。样式随 bundle 首次物化时注入一次，重复 apply
不会重复插入。

## 自测

```bash
cd dsh-desktop
NODE=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron

# Host 半：真实 DSH home + 真实官方接口，并与独立重读投影缓存的结果交叉比对
ELECTRON_RUN_AS_NODE=1 "$NODE" profile/plugins/usage-panel/selftest.mjs

# Browser 半：模拟模块加载器/React/seed 模块，环回服务器跑真实路由，并模拟 file:// 页面
SELFTEST_API_KEY=... ELECTRON_RUN_AS_NODE=1 "$NODE" profile/plugins/usage-panel/selftest-client.mjs
```

启动后要看到效果需要**重启 App**（桌面端没有客户端 HMR）。
