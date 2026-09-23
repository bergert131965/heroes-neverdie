# 置顶 / 挂起（desktop profile 自有插件）

给对话内容加两个手动标记，并在「轨迹」右边多一个标签页把它们汇总起来：

```text
 对话 │ 轨迹 │ 置顶          ← 第三个标签（order 20）
                │
                ├ 本会话共 3 条                     [清空本会话]
                ├ ┌──────────────────────────────────────────┐
                │ │ 手动记一条：我自己说过的要求……             │
                │ │                          [置顶] [挂起]     │
                │ └──────────────────────────────────────────┘
                ├ 置顶  2 条  你固定住的内容，一直留在这一栏。
                │   ┌────────────────────────────────────┐
                │   │ 助手消息  2026/9/22 10:31    [移除] │
                │   │ 这段回答的关键结论……                 │
                │   └────────────────────────────────────┘
                └ 挂起  1 条  你标为暂缓、之后再看的内容。
                    ┌────────────────────────────────────┐
                    │ 手动添加  2026/9/22 10:29    [移除] │
                    │ 先别管这个，等下周再说               │
                    └────────────────────────────────────┘
```

每条**已定稿的助手消息**动作条上会多出两个按钮：📌 置顶、⏸ 挂起。再点一次取消。

## 文件

| 文件 | 角色 |
|---|---|
| `client-host.js` | Host 半：空的热座。存在的唯一理由是入口契约（见下） |
| `client.js` | Browser 半：注册 `conversation.view` 标签与 `conversation.chat.assistant-actions` 动作 |
| `package.json` | 双面包声明（`main` + `dsh.client`） |
| `selftest-client.mjs` | Browser 半自测：槽位注册、存储纯逻辑、内容快照、组件冒烟 |

挂载位置是 `profile/cordis.patch.yml` 的 `insert` 块：

```yaml
- id: pinned
  name: ./plugins/pinned/client-host.js
```

## 占用的槽位与顺序

| 槽位 | 用途 | id | order |
|---|---|---|---|
| `conversation.view` | 「置顶」标签页 | `pinned` | 20 |
| `conversation.chat.assistant-actions` | 消息上的置顶/挂起按钮 | `pinned` | 20 |

标签顺序是实测出来的，不是猜的：`client-ui-chat` 用 `order: 0` 占「对话」，
`client-ui-trajectory` 用 `order: 10` 占「轨迹」，而槽位文档写明
*"Position among the entries, ascending (default 0)"*，所以 `order: 20` 正好落在轨迹右边。

`conversation.chat.assistant-actions` 的占用者会收到 `messageId` 这个 ownerProp，
外加 `sessionId` / `useChat` / `useTrajectory` 等标准 props。本插件只用 `messageId`
和 `sessionId`。

## 存储

浏览器 localStorage，键 `dsh-desktop-pinned/v1`，按会话分桶：

```json
{
  "session-<id>": {
    "<messageId>": { "bucket": "pin", "text": "快照内容", "kind": "assistant-step", "at": 1758500000000 }
  }
}
```

- **两个分组互斥**：点「挂起」会把条目从「置顶」挪走，反之亦然。同一条内容同时
  出现在两栏只会让人怀疑哪份是新的，所以不做成两个独立开关。
- 读取时一律过 `sanitizeState`：存储可能被手改、被旧版本写入或被别的代码污染，
  未知分组整条丢掉，越界文本截断。
- 上限：单会话 300 条、单条 1200 字，超出按时间淘汰最旧的。
- `localStorage` 不可用时（访问它本身就可能抛）退化为内存态：功能照常，只是不持久。
- 版本号在键里，将来改结构可以直接换键，不必写迁移。

**这些标记不进会话日志**，因此不会同步到 `dsh web` 或别的机器，也不会出现在轨迹里。
这是刻意的取舍：不写日志就不需要动宿主存储层，代价是只在本机这个前端可见。

## 内容是怎么抓的

**动作条不在助手消息节点内部。** 这是这套功能最容易踩的坑，第一版就栽在这里。

真实层级（`client-ui-chat` 的 `ChatView`）：`conversation.chat.assistant-actions` 是
**`turn-tail`（回合尾部）节点的子槽位**，由 `TurnTailNodeView` 渲染成
`MessageIconActions` 的 `extraActions`。而 `[data-chat-flow]` 列容器下的所有节点
（`user` / `assistant-step` / `tool-call` / `turn-tail` …）都是**兄弟**，各自带
`data-chat-flow-key` / `data-chat-flow-kind` / `data-chat-turn`（见 chat client 里那个
`flowItem` 包裹层）。

所以正文在**同回合的前一个兄弟节点**里，不在按钮的祖先链上。第一版写的是
`button.closest("[data-chat-flow-key]")`，取到的必然是 `turn-tail`——那里只有产出文件
行和动作按钮，摘掉按钮后什么都不剩，于是置顶卡片显示「（这条没抓到内容，消息 id：…）」，
来源还会显示成 `turn-tail`。顺手记一下：`MessageIconActions` 拿到的 `text` 只用在复制
按钮的闭包里（`writeClipboard(text)`），**没有落进 DOM**，所以没有捷径可抄。

现在按 `captureFrom()` 的候选顺序**横向**找，逐个试到「渲染着且非空」为止：

1. **槽位给的 `messageId` 直击锚点节点**：在 `[data-chat-anchor-key]` 里找等值节点。
2. **同回合的 `assistant-step` 兄弟**，从最后一个往前试——一个回合可能有多个步骤，
   收尾那条才是这条尾部对应的回答；折叠的 `turn-process`、只有工具调用的中间步骤都会
   给出空文本，被这一步自然跳过。
3. **按钮最近的 `[data-chat-flow-key]` 祖先**兜底。

「非空」和「渲染着」两个条件都是必须的：前者跳过空节点，后者跳过被折叠隐藏的节点
（它们仍能读出 `textContent`，但用户当时并没看到）。全部候选都空时才落回空串，由界面
显示「没抓到内容」并带上消息 id，方便回头查。

拿到节点后，克隆、摘掉按钮与操作条、挂进屏外容器再读 `innerText`：

- **为什么要克隆再摘按钮**：动作条与正文可能落在同一子树里，不摘的话「复制 / 点赞 /
  置顶」这些标签会混进内容里。
- **为什么要挂到屏外容器才能读 `innerText`**：`innerText` 只在渲染树里才返回带换行的
  文本，对游离克隆体调用只能拿到 `textContent` 那种连成一整片的结果。

存的是**快照**而不是引用，所以后续的上下文折叠 / 压缩不会让已置顶的内容变空——
你看到的就是当时看到的那段。代价是它不会跟着消息更新，而且丢格式：markdown 的粗体、
链接、表格会退化成线性纯文本，图片只剩 alt 文字。

## 滚动归属（踩过的第二个坑）

**这个槽位的垂直滚动永远归外层 `scrollBody`，占用者不该自建滚动容器。**

结构上（`client-ui-conversation` 的 `ConversationRoot`）：

```jsx
<div data-phase={phase}>
  <div class="body">
    <div class="scrollBody" data-conversation-scroll="">   // 垂直滚动归它
      {renderSlot("conversation.session")}                   // conversation.view 在这里
      {composerSeat}                                        // 输入框也是它的子节点
```

`data-conversation-scroll` 是**无条件**挂上的，`.scrollBody{flex:1;min-height:0;overflow-y:auto}`；
所以官方 `ChatView` 那条
`[data-conversation-scroll] .EvIC1a_scroll{flex:none;min-height:auto;overflow:visible}`
**永远生效**——这就是这个槽位的约定：**别自己滚**。

第一版违反了它，症状是**触控板滚动整个失效，只剩拖外层滚动条有效**。机制三步：

1. `viewArea` 在 active 相位下是 `flex:1 0 auto;min-height:auto`，高度随内容；
2. 于是那个 `overflow-y:auto` 的容器**没有可滚动的溢出量**，却仍然是命中的最近滚动容器；
3. 滚轮事件被它吃掉，而 `overscroll-behavior:contain` 又禁止上抛给 `scrollBody`。

修法就是照官方写：非委托模式下保留自滚动作为兜底，带 `data-conversation-scroll` 时让出去。

**实测口径**：在真实 `scrollBody` 里插一个同 class 的桩量计算样式（不需要会话，因为样式表是
全局注入的）。委托规则生效后 `.dsh-pinned-root` 算得 `overflow-y:visible` /
`overscroll-behavior-y:auto` / `flex:0 0 auto` / `min-height:auto`，自身可滚动量为 0。

注意：`overscroll-behavior:contain` 只在「自己确实是滚动者」的元素上才该用——官方轨迹视图里
`contain` 都挂在实际滚动的面板上，而 ChatView 那个让出去的滚动容器没有它。`contain` 的
「吃掉滚轮且禁止上抛」这一步是 CSS 规范行为，没有实测（合成的 wheel 事件在 Chromium 里
不会触发真实滚动，测不了），只做了机制比对。

底部留白也跟着官方轨迹视图的口径改成 `calc(var(--dsh-composer-height,152px) + 16px)`：
输入框是 `scrollBody` 里 `position:sticky` 的兄弟节点，会浮在内容之上。

## 已知限制

这些是当前实现的边界，不是待办清单：

1. **只能标记助手消息**。全仓只有 `conversation.chat.assistant-actions` 这一个消息级动作
   槽位，没有「用户消息动作」槽位。要标记自己说过的话，用标签页顶部的**手动添加**框
   （这也是加这个框的原因）。要走真按钮得替换 `conversation.chat.node` 里 `user` 那个
   key，槽位文档把它的 `replaceRisk` 标为 `shadows-shipped-ui`，不值得为这个功能承担。
2. **不能跳回原消息**。目前只显示快照。`conversation.view` 的占用者确实能拿到
   `openView`，理论上可以先切回「对话」再按 `[data-chat-anchor-key]` 滚动定位，
   但需要跨视图等挂载，没做。
3. **标签上没有计数徽标**。标签的 `label` 是 thunk，但只在槽位或语言变化时重读，
   计数变化不会触发它重算。计数放在标签页内部。
4. **单击即写入**，没有撤销提示。移除入口在每张卡片上。

## 自测

```bash
cd dsh-desktop
node profile/plugins/pinned/selftest-client.mjs
```

覆盖 82 项断言：bundle 能加载、两个槽位的 id/order/文案正确、切换与互斥、上限淘汰、
脏数据收敛、文本归一化、内容快照真的排除了按钮文案、两个组件在桩 React 下渲染不抛异常，
并借记录型 primitives 代理确认**只访问了真实存在的 primitives 成员**——这是不启动 App
的情况下唯一能抓出「图标名写错」的手段。另外覆盖没有 `localStorage` 时的内存回退。

其中 6 项是**滚动归属契约**（`[6]` 一节）：断言样式表里委托规则存在且把
`overflow` 让成 `visible`、`min-height` 让成 `auto`、`flex` 让成 `none`，并且**没有**把
`overscroll-behavior` 声明加回来。这是「契约存在性」断言而不是布局测试——它能拦住
有人把那个禁止上抛的声明改回来，但真实的滚动行为只能靠实机验证。

其中 9 项是**节点抓取回归**（`[3b]` 一节）：用 DOM 桩还原「`turn-tail` 与
`assistant-step` 是兄弟」的真实层级，断言正文是横向抓到的、来源种类取的是正文节点、
`messageId` 命中空尾部时能继续改用同回合正文、多步骤回合取收尾那条、收尾被折叠时回退到
可见节点，以及确实没正文时才返回空串。这几条正是第一版抓错节点那个 bug 的钉子——
`turn-tail 自身确实没有正文` 那一条本身就说明了旧逻辑为什么必然产出空内容。

启动后要看到效果需要**重启 App**（桌面端没有客户端 HMR）。
