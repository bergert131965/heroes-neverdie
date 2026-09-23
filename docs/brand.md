# 品牌：哪些是 HeRoes，哪些仍属上游

本应用是 DeepSeek Harness（DSH）的第三方桌面外壳。上游前端是**构建产物**，产品身份硬编码在若干位置，因此"改名"分成三种手段：

| 手段 | 适用 | 是否在仓库内可控 |
|---|---|---|
| **槽位插件**（`profile/plugins/brand/`） | 官方留了 `single` 槽位的地方 | ✅ 纯插件，升级不破 |
| **渲染层注入**（`desktop-runtime.js` 的 `renderIndex()`） | 启动时生成的 `index.html` | ✅ 纯代码，升级不破 |
| **确定性补丁**（`scripts/patch-brand.mjs`） | 上游 bundle 里写死的字面量 | ⚠️ 上游升级需重新核对锚点 |

---

## 1. 已经换成 HeRoes 的

| 界面位置 | 机制 | 值 |
|---|---|---|
| 侧栏左上标记 | 槽位 `sidebar.brand.mark` | HeRoes 标记（自绘 SVG） |
| 侧栏左上字标 | 槽位 `sidebar.brand.name` | `HeRoes` + 反白徽章 `[NEVER DIE]` |
| **首页中央标记** | 槽位 `conversation.hero.brand.mark` | HeRoes 标记（官方回退是 DeepSeek 鱼形 logo） |
| **窗口标题 / `document.title`** | 补丁 `dsh-client-ui-layout` 的 `productTitle` | `HeRoes NEVERDIE` |
| **窗口初始标题** | `renderIndex()` 注入 | `HeRoes NEVERDIE` |
| **首页大字** | 补丁 `dsh-client-ui-conversation` 的 `hero.headline` | `英雄永不谢幕` / `Heroes Never Die` |
| **首启声明** | 补丁 `dsh-client-ui-settings-models` 的 `welcomeTitle` / `welcomeBody` | `关于 HeRoes NEVERDIE`：基于 DSH 构建、欢迎产品反馈、跟随 DSH 迭代、声明非官方 |
| **API 引导文案** | 补丁 `onboardingDescription` | 不再声称"只能配 DeepSeek 官方模型"（见第 1.1 节） |

### 1.1 为什么 API 引导文案必须改

原文案是"配置 DeepSeek 官方模型，即可开始使用"，但**多 provider 是真实能力**。依据 `@deepseek-ai/dsh-base/cordis.patch.yml`：

> The pi-ai multi-provider twin, **mounted dormant**: zero routes (and no extra models in the picker) until a `llm-pi-ai:` settings section supplies provider profiles — then those routes register live. Supplying those profiles is exactly what the web Models page does.

也就是说 `dsh-llm-pi-ai` 已挂载（休眠态），用户在「设置 → 模型」里创建提供方即可启用。`@deepseek-ai/dsh-llm-pi-ai` 的 README 明确覆盖：

- pi-ai 目录中的各家 provider
- **OpenAI 兼容网关**
- 自建服务

前端也已具备 `customBaseUrl` / `customApi`（`API 协议`）/ `创建提供方` 等界面。因此引导文案改成"填入 DeepSeek 官方 API Key 即可开始；也可以稍后在「设置 → 模型」中添加其他提供方"才是准确的。

## 2. 刻意**没有**改的（描述性使用，上游规范明确允许）

上游 [`BRAND_GUIDELINES.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/BRAND_GUIDELINES.zh.md) 写着：

> 在项目的描述性文字中，您可以使用"DeepSeek Harness"真实、准确地说明您的项目与 DeepSeek Harness 的关系……
> 在项目命名时，请避免直接使用完整的"DeepSeek Harness"商标。

因此下面这些**描述上游**的文案被保留——它们说的是事实，改掉反而会变成假话：

| 位置 | 文案 | 为什么保留 |
|---|---|---|
| `dsh-client-connection` | 联网搜索的演示/样例文案 | 非用户可见，属测试数据 |
| `README.md` / `THIRD_PARTY_NOTICES.md` | "基于 DeepSeek Harness 构建"、商标归属声明 | 规范明确鼓励的描述方式 |
| 设置页模型区 | "配置 DeepSeek 官方模型"之外的 DeepSeek 字样（如 `DeepSeek 官方模型` 作为默认项） | 描述真实存在的默认提供方 |

**边界很清楚**：凡是把 DeepSeek 当成**本应用的身份**（标题、logo、slogan）→ 改；凡是**陈述本应用依赖的上游或真实存在的默认提供方**→ 留。

## 3. 改文案

编辑 `scripts/patch-brand.mjs` 顶部的 `BRAND` 表，然后重新应用：

```sh
npm run patch:brand
```

```js
const BRAND = {
  productTitle: "HeRoes NEVERDIE",   // 窗口标题 + 文档标题
  heroHeadlineZh: "英雄永不谢幕",     // 首页大字（中文）
  heroHeadlineEn: "Heroes Never Die", // 首页大字（英文）
};
```

侧栏与 hero 的**图形**不走这里——它们是 `profile/plugins/brand/client.js` 里内联的 SVG path 字符串。

## 4. 什么时候必须重跑

`npm install` / `npm ci` 会覆盖 `node_modules`，**补丁随之丢失**。以下时机都要重跑：

```sh
npm ci && npm run patch:brand && npm run check:process-fold
```

或者一次性全验：

```sh
npm run verify
```

`npm run check:brand` 只校验不写入；锚点对不上会以非零退出，**不会静默留下半补丁状态**。上游升级后如果锚点变了，会看到 `ANCHOR MISSING` —— 那时按新 bundle 的实际字面量更新 `patch-brand.mjs` 的 `from` 字段即可。

## 5. 已知未覆盖

- 底栏/"关于"里上游自己的版本号与版权行（属事实陈述）。
- 上游 locale 里其他提到 DeepSeek 的键（若有），目前均属描述性。
- 真正的上游大版本升级可能新增品牌位，需要按第 4 节重新核对。
