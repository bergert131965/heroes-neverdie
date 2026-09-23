# 过程行「完成后收进抽屉」

## 需求

对话流里的「思考 / Bash / 读取 / 工具调用」这些过程行：**任务还在跑的时候保持原样**，
**整个轮次彻底结束后**统一收进一个抽屉容器，默认只留一条摘要条，点击可展开。历史轮次不动。

## 为什么需要补丁

上游 `@deepseek-ai/dsh-client-ui-chat` 的「紧凑」显示本应做类似的事，但在实际使用里不生效。
在真实会话里逐层实测（把工作区 bundle 临时加上诊断属性，用 probe 读渲染结果）定位到三个原因：

1. **轮次进行中没有 process 投影节点**：`turnProcessNodes: 0`，80+ 行过程行的
   `data-turn-process-*` 标记全为空——上游的轮次级折叠挂在投影上，运行中的轮次没有它。
2. **`historyIncomplete` 会全局关掉折叠**：分页每次 50 条，而当时那个会话有 371 个 step、
   2600+ 事件，只要读者没一直往回翻，`hasMore` 就为真，于是**连已结束的轮次也不折叠**。
3. **折叠所需的 step 号可能缺失**：诊断读到 `closed/undefined/0/0/true`——轮次确实已结束、
   紧凑模式也开着，但 `turn.steps.at(-1)` 里没有 `step` 字段，取不到"答案步"，判定随之失效。

补丁因此做三件事：只看节点自身的轮次事实、不受 `historyIncomplete` 影响、并且不依赖 step 号。

## 行为

| 场景 | 表现 |
|---|---|
| 轮次进行中 | 完全维持上游行为：思考/Bash/读取 全部可见 |
| 轮次彻底结束（`turn.status === "closed"`） | 该轮**所有过程行**进抽屉（`hidden="until-found"`，Ctrl+F 可定位） |
| 最终答案 | 保留可见；其上方常驻一条开关：收起态 `已收起 N 个步骤 · 点击展开`，展开态 `点击收起` |
| 重复开合 | 摘要条在两种状态下都在，点一下切换，不会出现"展开了就收不回去" |
| 缺 step 号的轮次 | 同样折叠（不依赖 step 号，只按"是不是最终答案行"区分） |
| 上游控件的手动展开 | 抽屉一并展开（两者共享手动展开状态，不会互相打架） |
| 历史轮次 | 不受影响——本抽屉只管刚结束的那一轮 |
| 标准显示 | 一切照旧（只有紧凑模式参与） |

关键点：**不再"让位给上游"**。上游投影存在时它自己的折叠可能仍被 `historyIncomplete` 关着，
若再让位就会两边都不折——这正是之前"看起来完全没生效"的直接原因。

## 落地方式

**不要手工改 bundle。** 补丁以确定性脚本施加：

```
cd heroes-neverdie
npm run patch:process-fold     # 从 vendor 原始副本重建补丁产物，写入工作区 + 所有 .app
npm run check:process-fold     # 幂等性检查 + 行为自测
```

| 文件 | 角色 |
|---|---|
| `scripts/patch-process-fold.mjs` | 锚定替换；锚点缺失/重复会直接报错，不会产出半成品 |
| `scripts/vendor/dsh-client-ui-chat-0.1.5-rc.2.client.js` | 从 npm 缓存取出的**未打补丁**原始 bundle，作为唯一真源 |
| `scripts/chat-process-fold-selftest.mjs` | 从真实 bundle 抽取补丁区域，用桩依赖驱动真实 `ChatNodeSeat` 做行为断言（28 条） |
| `node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js` | 写入目标：`npm start` 读这份 |
| `release/manual-*/**/*.app/.../lib/client.js` | 写入目标：已打包 .app 读各自那份（脚本会扫描目录下所有 `.app`） |

补丁实际改了这些地方：

1. store 分片新增「本轮抽屉被手动展开」的标记（沿用 `answerStep` 的 `-1` 保留值）；
2. 座位旁新增 `processStepOfNode` / `processStepOf` / `turnWithCompletion` / `answerStepOf` /
   `isFinalAnswerRow` 判定；
3. `ChatNodeSeat` 的抽屉分支：紧凑模式 + 轮次已结束即折叠，且与上游控件的手动展开状态对齐；
4. 折叠规则：该轮过程行全部隐藏，最终答案行保留；
5. 最终答案行上方渲染摘要条（复用既有 `TurnProcessNodeView` 样式类）；
6/7. 摘要条胶囊样式；中英文案 `正在执行…` / `已收起 {count} 个步骤`。

## 验证情况

- 应用侧端到端实测（真实会话、真实渲染）：诊断值 `closed/true/true/false` ×18（过程行已折叠）、
  `closed/true/false/true` ×1（答案行带摘要条），**76 行隐藏 / 11 行可见**，`progressNodes: 6`。
- `npm run check:process-fold`：幂等通过；工作区与 `.app` 两份产物**逐字节等于**补丁脚本输出；
  28 条断言对两份产物各跑一遍全过。
- 自测覆盖：运行中不收、结束后收、答案保留、答案行带摘要条、工具收尾步不算答案、单步轮次不收、
  缺 step 号仍折叠、标准模式不受影响、手动展开生效。

## 注意

- **重启才生效**：桌面端没有客户端热更新。
- **`npm install` / 升级 `@deepseek-ai/dsh` 会覆盖补丁**：升级后跑一次 `npm run patch:process-fold`。
  若上游改了 bundle 结构导致锚点失配，脚本会报错并指出是哪一处，届时更新 vendor 原始副本即可。
- 单步轮次不做折叠（没有"过程"可收）；如需连它一起收，把 `progressChip` 的
  `progressStep !== 1` 条件去掉即可。
