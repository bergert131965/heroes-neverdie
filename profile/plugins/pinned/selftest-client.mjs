/**
 * 「置顶 / 挂起」浏览器半自测。
 *
 * 跑法（在 dsh-desktop 目录下，任选其一）：
 *   node profile/plugins/pinned/selftest-client.mjs
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron profile/plugins/pinned/selftest-client.mjs
 *
 * 这个插件没有 host 半可测（`apply` 是空的），而桌面端没有客户端 HMR、改完必须重启
 * App 才看得到效果，所以自测是提交前唯一的反馈回路。它覆盖五件事：
 *
 *   1. **bundle 能加载**：真实读取 `client.js`，在模拟的 `window.__ModuleLoader__`
 *      下执行，断言导出 `apply` / `inject`。
 *   2. **槽位注册正确**：用一个记录型 ctx 跑 `apply`，断言两个槽位名、id、order 与
 *      标签文案——`order: 20` 决定了标签落在「轨迹」右边，是这套功能的关键约定。
 *   3. **存储与纯逻辑正确**：切换、互斥、删除、清空、上限淘汰、脏数据收敛、
 *      文本归一化。
 *   4. **组件冒烟**：用桩 React 直接调用两个组件，遍历产出的元素树断言没有
 *      `undefined` 类型；并借助记录型 primitives 代理断言**只访问了真实存在的**
 *      primitives 成员——这是唯一能在不启动 App 的前提下抓出
 *      「图标/组件名写错」的手段。
 *   5. **无 localStorage 的环境**：功能照常，只是不持久。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundleSource = readFileSync(join(here, "client.js"), "utf8");

let failures = 0;
let checks = 0;

/**
 * 断言。
 * @param condition - 必须为真。
 * @param label - 结果说明。
 */
function ok(condition, label) {
  checks++;
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL ${label}\n`);
  }
}

/** 按 JSON 比较两个值，失败时打印差异。 */
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(a === b, `${label}${a === b ? "" : ` — 实际 ${a}，期望 ${b}`}`);
}

// ── 模拟 DOM ────────────────────────────────────────────────────────────────
/** 造一个元素节点；`innerText` 把子节点文本换行连接，`textContent` 直连。 */
function el(tag, options = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    className: options.className ?? "",
    text: options.text ?? "",
    dataset: {},
    unrendered: options.unrendered === true,
    style: { cssText: "" },
    attributes: {},
    childNodes: [],
    parentNode: null,
    get children() {
      return node.childNodes;
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
    },
    getAttribute(name) {
      return name in node.attributes ? node.attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    remove() {
      const parent = node.parentNode;
      if (parent !== null) {
        const index = parent.childNodes.indexOf(node);
        if (index !== -1) parent.childNodes.splice(index, 1);
      }
      node.parentNode = null;
    },
    get textContent() {
      return collect(node, "");
    },
    get innerText() {
      return collect(node, "\n");
    },
    /** 未被渲染的节点（折叠、display:none）返回空矩形列表。 */
    getClientRects() {
      return node.unrendered === true ? [] : [{ width: 100, height: 20 }];
    },
    /** 沿祖先链找最近的匹配节点（不含自身）。 */
    closest(selector) {
      let cursor = node.parentNode;
      while (cursor !== null && cursor !== undefined) {
        if (typeof cursor.tagName === "string" && matches(cursor, selector)) return cursor;
        cursor = cursor.parentNode;
      }
      return null;
    },
    /** 只实现本插件真正用到的那类选择器。 */
    querySelectorAll(selector) {
      return descendants(node).filter((candidate) => matches(candidate, selector));
    },
    cloneNode() {
      const copy = el(node.tagName, { className: node.className, text: node.text, unrendered: node.unrendered });
      copy.attributes = { ...node.attributes };
      for (const child of node.childNodes) copy.appendChild(child.cloneNode(true));
      return copy;
    },
  };
  return node;
}

/** 递归收集文本。 */
function collect(node, joiner) {
  const parts = [];
  if (node.text !== "") parts.push(node.text);
  for (const child of node.childNodes) {
    const inner = collect(child, joiner);
    if (inner !== "") parts.push(inner);
  }
  return parts.join(joiner);
}

/** 后代节点（不含自身）。 */
function descendants(node, out = []) {
  for (const child of node.childNodes) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

/**
 * 匹配自测用到的选择器：标签名、`[attr]` 存在性、`[attr="v"]` 等值、
 * `[class*='x']` 子串。不是通用实现，够用即可。
 */
function matches(node, selector) {
  for (const part of selector.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    if (token.startsWith("[")) {
      const body = token.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq === -1) {
        if (node.attributes[body] !== undefined) return true;
        continue;
      }
      const name = body.slice(0, eq);
      const value = body.slice(eq + 1).replace(/^["']|["']$/g, "");
      if (name === "class*") {
        if (node.className.includes(value)) return true;
        continue;
      }
      if (node.attributes[name] === value) return true;
      continue;
    }
    if (node.tagName === token.toUpperCase()) return true;
  }
  return false;
}

/** 造一个 document 桩。 */
function makeDocument() {
  const head = el("head");
  const body = el("body");
  return {
    head,
    body,
    createElement: (tag) => el(tag),
    querySelectorAll: (selector) => descendants(body).filter((node) => matches(node, selector)),
    querySelector(selector) {
      const found = /^style\[data-plugin-css="(.+)"\]$/.exec(selector);
      if (found === null) return null;
      return head.childNodes.find((n) => n.tagName === "STYLE" && n.dataset.pluginCss === found[1]) ?? null;
    },
  };
}

/** 造一个内存 localStorage 桩。 */
function makeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** 写入全局；优先 defineProperty，失败再退回赋值。 */
function setGlobal(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    globalThis[name] = value;
  }
}

/** 读取全局（可能本来就不存在）。 */
function getGlobal(name) {
  return globalThis[name];
}

// ── 加载 bundle ─────────────────────────────────────────────────────────────
/** 真实存在的 primitives 成员；代理据此抓拼写错误。 */
const REAL_PRIMITIVES = ["Button", "IconPauseOutline16", "Tooltip"];

/**
 * 在可控全局环境里执行真实 bundle。**不会自动还原全局**——插件内部的
 * `readRowText` 会在调用时才去读 `document`，测试期间必须让它一直可见；
 * 用完请调用返回的 `restore()`。
 * @param root - localStorage 桩；传 undefined 表示这个环境没有 localStorage。
 * @returns 导出、被访问的 primitives 名、document、还原函数、bundle id。
 */
function loadBundle(root) {
  const document = makeDocument();
  const accessed = new Set();
  const primitives = new Proxy(
    Object.fromEntries(REAL_PRIMITIVES.map((name) => [name, (props) => ({ type: name, props: props ?? {} })])),
    {
      get(target, prop) {
        if (typeof prop === "string") accessed.add(prop);
        return target[prop];
      },
    },
  );
  const react = {
    Fragment: "Fragment",
    useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const requireStub = (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`unexpected require: ${name}`);
  };

  const snapshot = { window: getGlobal("window"), document: getGlobal("document"), localStorage: getGlobal("localStorage") };
  let entry;
  setGlobal("window", { __ModuleLoader__: { load: (value) => { entry = value; } } });
  setGlobal("document", document);
  setGlobal("localStorage", root);

  // 等价于模块加载器调用工厂之前的宿主执行环境。
  new Function(bundleSource)();
  if (entry === undefined) throw new Error("bundle 没有调用 window.__ModuleLoader__.load");
  const restore = () => {
    for (const [name, value] of Object.entries(snapshot)) setGlobal(name, value);
  };
  return { exports: entry.factory(requireStub), accessed, document, restore, entryId: entry.id };
}

/** 遍历元素树，收集问题。 */
function inspect(node, path, problems) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((child, index) => inspect(child, `${path}[${index}]`, problems));
    return;
  }
  if (!("type" in node)) return;
  if (node.type === undefined || node.type === null) problems.push(`${path}: type 为 ${String(node.type)}`);
  const children = node.props === undefined ? undefined : node.props.children;
  if (children !== undefined) inspect(children, `${path}.children`, problems);
}

/** 收集元素树里所有字符串子节点。 */
function collectStrings(node, out = []) {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return out;
  }
  if ("props" in node && node.props !== undefined) collectStrings(node.props.children, out);
  return out;
}

// ── 1. 加载与注册 ──────────────────────────────────────────────────────────
process.stdout.write("\n[1] bundle 加载与槽位注册\n");
const storage = makeStorage();
const first = loadBundle(storage);
const bundle = first.exports;
const T = bundle.__test;

eq(first.entryId, "dsh-desktop-pinned", "模块 id");
ok(typeof bundle.apply === "function", "导出 apply");
eq(bundle.inject, ["slots"], "导出 inject");

const registrations = [];
const ctx = {
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    },
  },
};
bundle.apply(ctx);
eq(registrations.length, 2, "apply 注册了两个槽位占用者");

const viewReg = registrations.find((r) => r.options.name === "conversation.view");
const actionReg = registrations.find((r) => r.options.name === "conversation.chat.assistant-actions");
ok(viewReg !== undefined, "注册了 conversation.view");
ok(actionReg !== undefined, "注册了 conversation.chat.assistant-actions");
eq(T.VIEW_ORDER, 20, "标签 order 为 20（轨迹 order 10 之后）");
if (viewReg !== undefined) {
  eq(viewReg.options.id, "pinned", "标签 id");
  eq(viewReg.options.order, T.VIEW_ORDER, "标签 order");
  eq(viewReg.options.label(), "置顶", "标签文案");
  eq(viewReg.options.inject("s-1"), { sessionId: "s-1" }, "标签 inject 透出 sessionId");
  ok(typeof viewReg.component === "function", "标签挂的是组件");
}
if (actionReg !== undefined) {
  eq(actionReg.options.id, "pinned", "动作 id");
  eq(actionReg.options.order, 20, "动作 order");
  eq(actionReg.options.inject("s-1"), { sessionId: "s-1" }, "动作 inject 透出 sessionId");
}
eq(first.document.head.childNodes.filter((n) => n.tagName === "STYLE").length, 1, "注入了样式标签");
bundle.apply(ctx);
eq(first.document.head.childNodes.filter((n) => n.tagName === "STYLE").length, 1, "重复 apply 不重复注入样式");

// ── 2. 纯逻辑 ──────────────────────────────────────────────────────────────
process.stdout.write("\n[2] 存储与纯逻辑\n");
const S = "session-a";

const s0 = T.toggleIn({}, S, "m1", "pin", { text: "第一条", kind: "assistant-step" });
eq(s0[S].m1.bucket, "pin", "置顶写入 pin 分组");
eq(s0[S].m1.text, "第一条", "快照内容被保存");
eq(s0[S].m1.kind, "assistant-step", "来源被保存");
ok(typeof s0[S].m1.at === "number" && s0[S].m1.at > 0, "写入时间戳");

const s1 = T.toggleIn(s0, S, "m1", "hold", { text: "第一条" });
eq(s1[S].m1.bucket, "hold", "再点挂起会从置顶挪到挂起（互斥）");
eq(Object.keys(s1[S]).length, 1, "互斥后仍只有一条");

const s2 = T.toggleIn(s1, S, "m1", "hold", { text: "第一条" });
eq(s2[S].m1, undefined, "点已激活的分组会取消标记");
eq(s2[S], {}, "取消后该会话没有条目，但会话键仍在");
eq(T.removeIn(s2, S, "不存在") === s2, true, "删除不存在的条目不换引用");
eq(T.clearIn(s0, S)[S], undefined, "清空会话");
eq(T.clearIn({}, S).constructor, Object, "清空空会话仍返回对象");

// 排序用手工构造的会话，避免同毫秒时间戳导致断言依赖排序稳定性
const handBuilt = {
  a: { bucket: "pin", text: "", kind: "", at: 100 },
  b: { bucket: "pin", text: "", kind: "", at: 200 },
  c: { bucket: "hold", text: "", kind: "", at: 50 },
};
eq(T.listBucket(handBuilt, "pin").map((r) => r.messageId), ["b", "a"], "同组按时间新的在前");
eq(T.listBucket(handBuilt, "hold").map((r) => r.messageId), ["c"], "另一组只含本组条目");
eq(T.listBucket({}, "pin"), [], "空会话返回空数组");

// 上限淘汰：桩掉 Date.now 让时间戳严格递增，淘汰顺序才可断言
const total = T.MAX_ITEMS_PER_SESSION + 25;
const realNow = Date.now;
let clock = 0;
Date.now = () => ++clock;
let capped = {};
try {
  for (let i = 0; i < total; i++) capped = T.toggleIn(capped, S, `m${String(i).padStart(4, "0")}`, "pin", { text: `t${String(i)}` });
} finally {
  Date.now = realNow;
}
eq(Object.keys(capped[S]).length, T.MAX_ITEMS_PER_SESSION, "超出上限后按数量裁剪");
eq(capped[S].m0000, undefined, "最旧的被淘汰");
eq(capped[S][`m${String(total - 1).padStart(4, "0")}`] !== undefined, true, "最新的保留");

// 脏数据收敛
eq(T.sanitizeState(null), {}, "sanitizeState(null) 返回空表");
eq(T.sanitizeState({ s: "不是对象" }), {}, "丢掉非对象会话");
eq(T.sanitizeState({ s: { m: { bucket: "nope" } } }), {}, "丢掉未知分组");
eq(T.sanitizeState({ s: { m: { bucket: "pin", text: 5, at: "x" } } }).s.m, { bucket: "pin", text: "", kind: "", at: 0 }, "非法字段回落到默认值");
eq(T.sanitizeItem("字符串"), undefined, "sanitizeItem 拒绝非对象");
eq(T.sanitizeItem({ bucket: "pin", text: "x".repeat(T.MAX_TEXT + 50) }).text.length, T.MAX_TEXT, "超长文本被截断");

// 文本归一化
eq(T.normalizeText("  a  \n\n\n\n  b  "), "a\n\nb", "归一化：去首尾、压空行、清行内空白");
eq(T.normalizeText(undefined), "", "归一化：非字符串返回空");
eq(T.normalizeText("x".repeat(T.MAX_TEXT + 10)).length, T.MAX_TEXT, "归一化：截断");
eq(T.cleanKey(""), "", "cleanKey 拒绝空串");
eq(T.cleanKey(undefined), "", "cleanKey 拒绝非字符串");
eq(T.cleanKey("m1"), "m1", "cleanKey 透传");

// ── 3. 内容快照 ────────────────────────────────────────────────────────────
process.stdout.write("\n[3] 内容快照（真实 DOM 桩）\n");
const row = el("div");
row.setAttribute("data-chat-flow-key", "m-row");
row.setAttribute("data-chat-flow-kind", "assistant-step");
row.appendChild(el("div", { className: "body_hash", text: "助手回答正文" }));
row.appendChild(el("pre", { text: "const a = 1;" }));
const actionsRow = el("div", { className: "xzv4MW_actions" });
actionsRow.appendChild(el("button", { text: "复制" }));
actionsRow.appendChild(el("button", { text: "置顶" }));
row.appendChild(actionsRow);

const snapshotText = T.readRowText(row);
ok(snapshotText.includes("助手回答正文"), "快照包含正文");
ok(snapshotText.includes("const a = 1;"), "快照包含代码块");
ok(!snapshotText.includes("复制"), "快照排除了官方动作按钮文案");
ok(!snapshotText.includes("置顶"), "快照排除了我们自己按钮的文案");
ok(first.document.body.childNodes.length === 0, "快照用的屏外容器已移除");
eq(T.readRowText(null), "", "快照：null 行返回空串");

// ── 3b. 回归：正文节点与动作条是兄弟，不是祖先 ──────────────────────────────
process.stdout.write("\n[3b] 回归：turn-tail 与 assistant-step 是兄弟节点\n");
/**
 * 真实层级来自 client-ui-chat 的 ChatView：`[data-chat-flow]` 列容器下的所有节点
 * （`user` / `assistant-step` / `tool-call` / `turn-tail` …）都是**兄弟**，各自带
 * `data-chat-flow-kind` 与 `data-chat-turn`；而动作条属于 `turn-tail` 节点。
 * 第一版就是从按钮 `closest()` 上溯取内容，抓到的 `turn-tail` 里只有产出文件行和
 * 按钮，摘掉按钮即为空——于是置顶卡片显示「没抓到内容」。下面几条钉住这个 bug。
 */
const buildFlow = (steps, tailTurn) => {
  const flow = el("div");
  flow.setAttribute("data-chat-flow", "");
  for (const step of steps) {
    const node = el("div", { unrendered: step.unrendered === true });
    node.setAttribute("data-chat-flow-key", step.key);
    node.setAttribute("data-chat-anchor-key", step.key);
    node.setAttribute("data-chat-flow-kind", step.kind ?? "assistant-step");
    node.setAttribute("data-chat-turn", step.turn);
    if (step.text !== undefined) node.appendChild(el("div", { className: "body", text: step.text }));
    flow.appendChild(node);
  }
  const tail = el("div");
  tail.setAttribute("data-chat-flow-key", `${tailTurn}-tail`);
  tail.setAttribute("data-chat-flow-kind", "turn-tail");
  tail.setAttribute("data-chat-turn", tailTurn);
  const actionRow = el("div", { className: "xzv4MW_actions" });
  const button = el("button", { text: "置顶" });
  actionRow.appendChild(button);
  tail.appendChild(actionRow);
  flow.appendChild(tail);
  return { flow, button, tail };
};

const single = buildFlow([{ key: "msg-1", turn: "t1", text: "这是助手回答的正文" }], "t1");
first.document.body.appendChild(single.flow);
eq(T.readRowText(single.tail), "", "turn-tail 自身确实没有正文（这正是第一版存空的原因）");
const captured = T.captureFrom(single.button, "msg-1");
ok(captured.text.includes("这是助手回答的正文"), "横向抓到兄弟节点的正文");
eq(captured.kind, "assistant-step", "来源种类取正文节点，而不是 turn-tail");
eq(T.captureFrom(single.button, "").text.includes("这是助手回答的正文"), true, "messageId 缺失时靠回合关系仍能抓到");
eq(T.contentCandidates(single.button, "msg-1")[0].getAttribute("data-chat-flow-key"), "msg-1", "messageId 命中锚点时排第一");

const multi = buildFlow([
  { key: "s-1", turn: "t2", text: "中间步骤的说明" },
  { key: "s-2", turn: "t2", text: "收尾回答" },
], "t2");
first.document.body.appendChild(multi.flow);
eq(T.captureFrom(multi.button, "").text, "收尾回答", "多步骤回合取收尾那条");

const folded = buildFlow([
  { key: "f-1", turn: "t3", text: "可见的中间步骤" },
  { key: "f-2", turn: "t3", text: "被折叠的收尾", unrendered: true },
], "t3");
first.document.body.appendChild(folded.flow);
eq(T.captureFrom(folded.button, "").text, "可见的中间步骤", "收尾被折叠时回退到可见节点，而不是取空");

// 万一 messageId 命中的就是那个空尾部，也要靠「非空」继续往下试
const tailAnchored = buildFlow([{ key: "ta-1", turn: "t5", text: "正文在这里" }], "t5");
tailAnchored.tail.setAttribute("data-chat-anchor-key", "tail-anchor");
first.document.body.appendChild(tailAnchored.flow);
eq(T.captureFrom(tailAnchored.button, "tail-anchor").text, "正文在这里", "messageId 命中空尾部时继续改用同回合正文");

const barren = buildFlow([{ key: "b-1", turn: "t4" }], "t4");
first.document.body.appendChild(barren.flow);
eq(T.captureFrom(barren.button, "").text, "", "确实没有正文时才返回空串");

// ── 4. 组件冒烟 ────────────────────────────────────────────────────────────
process.stdout.write("\n[4] 组件冒烟（桩 React）\n");
const render = (label, component, props) => {
  const problems = [];
  let tree;
  try {
    tree = component(props);
  } catch (error) {
    problems.push(`抛出异常：${error instanceof Error ? error.message : String(error)}`);
  }
  if (tree !== undefined) inspect(tree, label, problems);
  ok(problems.length === 0, `${label} 渲染无异常${problems.length === 0 ? "" : ` — ${problems.join("; ")}`}`);
  return tree;
};

const emptyTree = render("PinnedView（空）", T.PinnedView, { sessionId: S });
ok(collectStrings(emptyTree).some((s) => s.includes("还没有置顶的内容")), "空态提示可见");

T.addManual(S, "pin", "手动置顶的内容");
T.addManual(S, "hold", "手动挂起的内容");
const filledTree = render("PinnedView（有内容）", T.PinnedView, { sessionId: S });
const filledStrings = collectStrings(filledTree);
ok(filledStrings.some((s) => s.includes("手动置顶的内容")), "置顶分区渲染出内容");
ok(filledStrings.some((s) => s.includes("手动挂起的内容")), "挂起分区渲染出内容");
ok(filledStrings.some((s) => s.includes("本会话共 2 条")), "总数正确");
ok(filledStrings.some((s) => s.includes("手动添加")), "来源标签渲染为中文");

eq(T.getBucket(S, T.listBucket(T.getSession(S), "pin")[0].messageId), "pin", "提交后的状态可被读取");
ok(storage.map.has(T.STORAGE_KEY), "状态已写入 localStorage");
const persisted = JSON.parse(storage.map.get(T.STORAGE_KEY));
eq(Object.keys(persisted[S]).length, 2, "落盘的是两条");

render("PinnedActions", T.PinnedActions, { sessionId: S, messageId: "m1" });

const unknownPrimitives = [...first.accessed].filter((name) => !REAL_PRIMITIVES.includes(name));
eq(unknownPrimitives, [], "只访问了真实存在的 primitives 成员");
ok(first.accessed.has("IconPauseOutline16"), "确实用到了官方暂停图标（而非拼错的名字）");

// ── 5. 无 localStorage 的环境 ───────────────────────────────────────────────
process.stdout.write("\n[5] 无 localStorage 的环境\n");
first.restore();
const bare = loadBundle(undefined);
try {
  bare.exports.apply({ slots: { inject: (_n, cb) => cb(), register: () => () => {} } });
  ok(true, "没有 localStorage 时 apply 不抛异常");
} catch (error) {
  ok(false, `没有 localStorage 时 apply 抛了异常：${error instanceof Error ? error.message : String(error)}`);
}
try {
  bare.exports.__test.addManual(S, "pin", "内存态");
  eq(bare.exports.__test.getBucket(S, bare.exports.__test.listBucket(bare.exports.__test.getSession(S), "pin")[0].messageId), "pin", "没有 localStorage 时功能照常（内存态）");
} catch (error) {
  ok(false, `没有 localStorage 时写入抛了异常：${error instanceof Error ? error.message : String(error)}`);
}
bare.restore();

// ── 6. 滚动归属契约（CSS）──────────────────────────────────────────────────
process.stdout.write("\n[6] 滚动归属契约（CSS）\n");
/**
 * 这个槽位的垂直滚动**永远**归外层 `scrollBody`（它无条件带
 * `data-conversation-scroll`，且 `flex:1; min-height:0; overflow-y:auto`），
 * 所以占用者必须像官方 `ChatView` 那样把自滚动让出去。
 *
 * 第一版在这里自建了滚动容器并加了 overscroll-behavior 的 contain：`viewArea` 在
 * active 相位下高度随内容，于是这个滚动容器没有溢出量，却仍是命中的最近滚动容器——
 * 滚轮被它吃掉，contain 又禁止上抛给 `scrollBody`。症状就是触控板完全不能滚、
 * 只剩直接拖外层滚动条有效。
 *
 * 这几条是「契约存在性」断言，不是布局测试：它们只能保证这份样式表仍然写着正确的
 * 归属规则、没有把那个禁止上抛的声明加回来。真正的滚动行为只能靠实机验证。
 */
const css = T.PLUGIN_CSS;
ok(/\[data-conversation-scroll\] \.dsh-pinned-root\{[^}]*overflow:visible/.test(css), "带 data-conversation-scroll 时让出滚动（overflow:visible）");
ok(/\[data-conversation-scroll\] \.dsh-pinned-root\{[^}]*min-height:auto/.test(css), "同上：min-height:auto，高度随内容");
ok(/\[data-conversation-scroll\] \.dsh-pinned-root\{[^}]*flex:none/.test(css), "同上：flex:none，不再抢父级的空间分配");
ok(/\.dsh-pinned-root\{[^}]*overflow-y:auto/.test(css), "非委托模式下仍保留自滚动作为兜底");
ok(!/[{;]\s*overscroll-behavior\s*:/.test(css), "没有把 overscroll-behavior 声明加回来（正是它禁止了上抛）");
ok(/padding:[^;]*--dsh-composer-height/.test(css), "底部留白计入输入框高度，避免内容被 sticky 输入框压住");

// ── 汇总 ───────────────────────────────────────────────────────────────────
process.stdout.write(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}\n`);
if (failures > 0) process.exit(1);
