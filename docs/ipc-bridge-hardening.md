# IPC 主进程桥：打磨清单与测试方案

> 状态基线（2026-09-16 实测，非历史记录）：自检实例一次通过，
> `bootGraph=51 / transport=true / uploadHook=true / $events 首帧 ready(host=<workspace>) / 假方法 RPC 404`
> —— 四条载体（一元 fetch、逻辑流、插件 bundle、文件上传）均已连通。
> 下面列的不是"没通"，而是**连通之后离生产级还差的那些面**，按严重度排序。

## 一、桥的现状（供对照）

| 载体 | 渲染端 | 主进程 | 解析文件 |
|---|---|---|---|
| 一元 fetch | `bridgeFetch` 前置脚本 | `installFetchBridge()` | `profile/plugins/desktop-runtime.js:107-189`、`main.js:242-339` |
| 逻辑流 | `bridgeOpenStream` | `installStreamBridge()` | `desktop-runtime.js:190-233`、`main.js:342-381` |
| 插件 bundle | URL 重写为 `dsh://harness/plugins/…` | `protocol.handle("dsh")` → `clientModules.fetchBundle` | `main.js:591-599`、`desktop-runtime.js:313-321` |
| 文件上传 | `__DSH_FILE_UPLOAD__ = { fetch }` | 复用一元 fetch（`bodyIsStream` 分支） | `desktop-runtime.js:235`、`main.js:298-330` |

官方契约点已核对：`dsh-client-connection` 只读 `__DSH_TRANSPORT__.{fetch,openStream,ownsHost}`；
`dsh-client-file-upload` 走 `customTransport(hook.fetch)` 并要求返回**真 `Response`**（读 `.status`/`.text()`）。二者当前都满足。

---

## 二、需要打磨的方面（按优先级）

### P0 — 正确性/资源边界，会被真实用法触发

1. **响应体在渲染端整体聚合（公认的记忆体上界）**
   位置：`desktop-runtime.js:158-184`。所有 chunk 收齐才 `new Response()`。
   - 影响：会话日志导出、大附件下载、任何 >100MB 的响应会把整份字节留在渲染堆，且首个字节到 `Response` 之间有全量延迟。
   - 打磨：①渲染端直接构造 `ReadableStream`（`head` 事件后立即 resolve，后续 chunk 进流，`end` 关流），保留现有 waiters 队列即可；②主进程加水位控制（见第 2 条）避免 IPC 队列先爆。

2. **主进程 → 渲染进程无背压**
   位置：`main.js:246-263`（`streamResponse`）、`main.js:354-373`（stream pump）。
   `webContents.send` 是 fire-and-forget，`for await` 的背压只约束 host 迭代器，不约束 IPC 队列。慢渲染端（大 session 事件风暴）会让主进程内存和渲染端事件队列同时增长。
   - 打磨：批量发送（按字节/时间窗口合并 `chunk`）、或加信用窗口（渲染端 `stream-ack`），并给单流加"未确认字节"上限。

3. **`onProgress` 上传进度从未上报**
   位置：`desktop-runtime.js:107-148`。`dsh-client-file-upload` 的 `customTransport` 会传 `onProgress`，但 `bridgeFetch` 既不接收也不回调；只有 Blob 走 ReadableStream 分支时才有意义。
   - 影响：桌面端大文件上传进度条不动（网页版走 XHR/Worker 有进度）。
   - 打磨：`bridgeFetch(input, init)` 增加 `init.onProgress`，按 chunk 累计 `loaded`（有 total 时一并给），在 `bridge.send("dsh-bridge:fetch-body")` 前后回调。

4. **渲染端销毁/重载时的挂起 Promise**
   位置：`desktop-runtime.js:149-171` 的 `poll()` 只在 head/ended/error/abort 四条路径兑现。
   若请求在 head 到达前渲染端被 reload，或主进程侧 `webContents.isDestroyed()` 提前 return（`main.js:257/262`），Promise 永不结算。
   - 打磨：主进程在 sender 销毁时补发终态 `error` 事件；渲染端加 `pagehide`/`beforeunload` 时统一 reject 所有在途请求。

5. **错误路径不统一**
   `main.js:284-291` 在已发 `head` 之后出错只发 `error` 事件，渲染端在等 `end` 的 Promise 上被 reject（行为正确），但 `head` 已 resolve 的情况下 `Response` 语义已经承诺；应明确"head 之后错误 = 流中断错误"，并考虑用 `ReadableStream.error()` 传达（配合第 1 条）。

### P1 — 性能/架构

6. **每请求一个全通道监听器 ⇒ 事件扇出 O(N×M)**
   位置：`preload.js:14`（`setMaxListeners(0)`）+ `desktop-runtime.js:120` 每次 `bridgeFetch` 都 `bridge.on("dsh-bridge:fetch-event")`。
   主进程每发一个事件，preload 会把**所有** N 个在途请求的监听器都调一遍，各自按 `requestId` 早退。
   - 打磨：preload 内做一次中心分发（`Map<requestId, Set<handler>>`），页面只看到 `invoke/send/on` 或直接暴露 `subscribe(requestId, fn)`；顺便把 `setMaxListeners(0)` 收回成有界值。

7. **Base64 边界与结构化克隆**
   - 请求体永远 base64 字符串（`desktop-runtime.js:116`）：`ArrayBuffer`/`Uint8Array` 本可直接结构化克隆，省一次 33% 膨胀 + 两次编解码。上传大文件时明显。
   - 响应 chunk 是 `Uint8Array`，经 contextBridge 后形状不确定，靠 `bytesOf()` 兜底（`desktop-runtime.js:89-100`）；空 chunk 会落进 `throw "unhandled bridge chunk shape"`，应显式处理零长。
   - 打磨：统一"二进制走 ArrayBuffer、文本走 string"的传输约定，并在两端加断言。

8. **`dsh://` 路由与缓存**
   位置：`main.js:591-599`。目前无 method 校验、无 `Content-Type` 兜底、无缓存头验证。
   - 打磨：只允许 GET/HEAD；透传 `clientModules.fetchBundle` 的 MIME 与 `ETag`/`Cache-Control`；对 `graph.rev` 变化后的旧 URL 明确行为（404 还是重建）。

9. **CSP 缺失（Electron 已告警）**
   自检日志里明确出现 `Electron Security Warning (Insecure Content-Security-Policy)`。file:// 页面目前无 `Content-Security-Policy`。
   - 打磨：在 `renderIndex()` 注入 meta CSP；先确认模块系统是否依赖 `unsafe-eval`（很可能需要 `script-src 'self' 'unsafe-eval' dsh:`），把它作为**已知放宽项**写进 README，而不是继续无声告警。

### P2 — 可观测性/测试性/一致性

10. **桥逻辑埋在 `main.js` 里，不可单测**
    287 行核心桥与 Electron API 直接耦合（`ipcMain`、`webContents`、`protocol`）。
    - 打磨：抽出 `bridge/fetch-bridge.js` / `bridge/stream-bridge.js`，注入一个 `{ handle, on, send, isAlive, failure }` 传输接口；`main.js` 只做接线。这一步是第三层单测的前提。

11. **无诊断指标**
    只有 `DSH_DESKTOP_TRACE=1` 的一行 stdout（`main.js:280-282`）。
    - 打磨：在途请求数、单请求字节/耗时、IPC 往返、流事件速率、abort/错误计数；出错时带 `requestId` 前缀写入 `desktop.log`。

12. **无超时/无心跳**
    `wireStream` 的 WebSocket 载体有 heartbeat，桌面载体没有等价物。长空闲的 `$events` 流如果 host 侧静默死亡，渲染端不会感知。
    - 打磨：主进程对在途 stream 发周期 ping 事件（或让 host 侧已有心跳事件透传），渲染端超时后触发 `connection.reconnect()`。

13. **多窗口/多 sender 语义未定义**
    `senderCleanups` 已按 `webContents.id` 归集，但 `stream-cancel` 不校验 sender（`main.js:377-380`），`protocol.handle` 全局单例。
    - 打磨：`stream-cancel` 加 sender 校验；`app.on("activate")` 二次开窗路径（`main.js:623-630`）做一次实测，确认两窗口并存时桥不串。

14. **与 README 的表述对齐**
    `README.md:76` 已自认"响应体聚合"这一差异。第 1 条修掉后需同步更新，避免文档说谎。

---

## 三、测试方案

### L0 单测（提取后即可跑，`node --test`）

前提：完成第 10 条重构。用假的 IPC 总线（`handle/on/send` 三个 Map）驱动桥模块。

| 编号 | 用例 | 断言 |
|---|---|---|
| U1 | 一元 fetch：ack 即返回、head/chunk/end 顺序 | 事件序列严格为 `head→chunk*→end`，`Response.status` 透传 |
| U2 | `bodyIsStream`：body chunk 先累积、`end` 后才 dispatch | dispatch 只发生一次，且发生在最后一个 body chunk 之后 |
| U3 | abort：`fetch-abort` 触发 host `AbortController` | host 侧 signal 为 aborted，pendingBodies 条目被清 |
| U4 | sender 销毁 | 在途 fetch/stream 的 host 迭代器被 abort，Map 清空（无泄漏） |
| U5 | stream-open 生成的 id 唯一、取消后不再发 item | `stream-cancel` 后事件计数停止 |
| U6 | host 抛错 | `kind:"error"` 事件带 `wireStream.failure()` 结构的 `code/message` |
| U7 | 非法请求（缺 requestId、未知 kind、超大 body） | 被拒绝且不产生未处理 rejection |

### L1 集成探针（扩展现有自检，`DSH_DESKTOP_SELFTEST=1`）

把 `main.js:443-501` 里那段一次性 `executeJavaScript` 抽成 `scripts/bridge-probe.mjs`，输出 JSON 报告到 `userData/selftest-result.json` + 截图。新增探针：

| 编号 | 探针 | 通过标准 |
|---|---|---|
| I1 | 大响应（`/api/session/<id>/log/export` 或造 200MB 假响应） | 首字节延迟 < 1s；主进程 RSS 峰值增量 < 50MB；渲染端不 OOM |
| I2 | 大上传（80MB `ReadableStream` body） | 成功落盘；`onProgress` 单调递增至 total（对应第 3 条修复） |
| I3 | 中途 abort（发起后 300ms `AbortController.abort()`） | 渲染端 `AbortError`；主进程在途表清零；host 侧日志出现 abort |
| I4 | `$events` 流在 1 分钟内连发 5k 事件 | 无丢失、顺序一致、单条延迟 P95 < 50ms |
| I5 | 渲染端 `location.reload()` 时有在途请求 | reload 后新页面可用；旧请求不泄漏（主进程在途表清零） |
| I6 | 并发 1000 个 RPC | 全部 200/404 正确；渲染端监听器数不随请求数增长（对应第 6 条修复后） |
| I7 | `dsh://harness/plugins/…` 直取 | 200 + 正确 MIME；非 `/plugins/` 路径 404；非 GET 405 |
| I8 | 桥往返延迟 | `invoke` → `head` 的 P50/P95，记录基线（本地应 < 10ms） |

### L2 端到端（真实窗口，人工/脚本半自动）

在打包后的 `HeRoes NEVERDIE.app` 上跑一轮"用户旅程"，每项都要在 `desktop.log` 留下可核对的行：

1. 新会话 → 发一条消息 → 事件流实时出现（打字机效果中途不间断）→ 中途点停止 → 会话恢复正常。
2. 上传一张大图/大文件 → 进度条走完（第 3 条修复后）→ 模型能看到附件。
3. 断网 10s → UI 进入重连态 → 恢复后自动接续（验证第 12 条心跳/重连）。
4. 关闭窗口再 `activate` 开新窗口（main.js:623）→ 历史会话可读、桥可用。
5. 崩溃注入：`kill -9` 渲染进程 → 主进程自愈路径与桥的重建（`render-process-gone` 分支）。
6. 长会话（>2h、事件数 > 50k）：内存曲线平稳（验证第 2 条背压）。

---

## 四、建议的落地顺序

1. 先做第 10 条重构（可测性）→ 补 L0；
2. 再做 P0 的 1/2/3/4（一次性把响应流、背压、进度、销毁清理打通）→ 补 I1/I2/I3/I5；
3. 然后 P1 的 6/7/8/9 → 补 I6/I7 与 CSP 断言；
4. 最后 P2 的 11/12/13/14 与长稳测试 I4/L2。

每条修复都应绑定一条上表用例；没有用例的修复不合并。
