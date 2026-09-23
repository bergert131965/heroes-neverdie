/**
 * 置顶 / 挂起 —— desktop profile 自有插件的浏览器半。
 *
 * 在「轨迹」右边新增第三个标签「置顶」，并给每条已定稿的助手消息挂上
 * 「置顶」「挂起」两个动作按钮：
 *
 *   conversation.view                  → 第三个标签（id `pinned`, order 20）
 *   conversation.chat.assistant-actions → 每条助手消息动作条上的两个按钮
 *
 * 标签顺序是实测出来的：`client-ui-chat` 用 `order: 0` 占「对话」，
 * `client-ui-trajectory` 用 `order: 10` 占「轨迹」，槽位文档写明 order 升序排列，
 * 所以 `order: 20` 正好落在轨迹右边。
 *
 * 状态按会话键存在浏览器 localStorage：刷新与重启后仍在，但不写入会话日志，
 * 因而不会同步到其它前端，也不会出现在轨迹里。
 *
 * 「内容」在点击那一刻从消息 DOM 抓成快照（见 `readRowText`），所以后续的上下文
 * 折叠 / 压缩不会让已置顶的内容变空——这是刻意的：看到的就是当时看到的那段。
 *
 * 本文件是手写的模块工厂注册，而非构建产物：`@deepseek-ai/dsh-client-modules`
 * 通过调用 `window.__ModuleLoader__.load` 执行它，`react`、`react/jsx-runtime` 与
 * `@deepseek-ai/dsh-client-ui-primitives` 是加载器直接应答的平台种子名。
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-pinned",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const h = jsxRuntime.jsx;
		const hs = jsxRuntime.jsxs;
		const Fragment = react.Fragment;

		//#region 常量
		/** localStorage 键。带版本号，将来改结构时可以直接换键而不是迁移。 */
		const STORAGE_KEY = "dsh-desktop-pinned/v1";
		/** 单条快照最多保留的字符数，避免长回答把存储撑爆。 */
		const MAX_TEXT = 1200;
		/** 单会话最多保留的条目数，超出时按时间淘汰最旧的。 */
		const MAX_ITEMS_PER_SESSION = 300;
		/** 两个分组。`pin` 就是用户说的「置顶」，`hold` 是「挂起/暂缓」。 */
		const BUCKETS = ["pin", "hold"];
		const BUCKET_TITLE = { pin: "置顶", hold: "挂起" };
		const BUCKET_HINT = {
			pin: "你固定住的内容，一直留在这一栏。",
			hold: "你标为暂缓、之后再看的内容。",
		};
		/** 标签在轨迹右边的位置。 */
		const VIEW_ID = "pinned";
		const VIEW_ORDER = 20;
		/** 动作条上的位置：官方 feedback 用 order 10，这两个按钮排在它之后。 */
		const ACTION_ORDER = 20;
		/** 节点类型的中文名；未知类型回退显示原始 kind。 */
		const NODE_KIND_LABEL = {
			"assistant-step": "助手消息",
			"tool-call": "工具调用",
			user: "你的消息",
			steering: "插话",
			manual: "手动添加",
		};
		//#endregion

		//#region 样式
		/**
		 * 动作按钮的样式是从官方动作条实测抄来的（见 `client-ui-chat` 里
		 * `.xzv4MW_action` 的规则）：28px 圆形、三级文字色、悬停浅底、图标 15px，
		 * 连 `--dsh-content-font-delta` 这个随内容字号缩放的偏移都一起带上，
		 * 这样按钮跟旁边的官方动作按钮完全同高同步。
		 *
		 * 激活态用标签页高亮同一个 token（`state-business-primary`），
		 * 缺失时回退到品牌色。
		 */
		const PLUGIN_CSS = `
.dsh-pinned-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex;}
.dsh-pinned-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px));}
.dsh-pinned-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}
.dsh-pinned-action[data-active]{color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));}
.dsh-pinned-action[data-active]:hover{color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));}
.dsh-pinned-host{display:contents;}
/*
 * 滚动归属：这个槽位的垂直滚动【永远】归外层 scrollBody（它无条件带
 * data-conversation-scroll，且是 flex:1;min-height:0;overflow-y:auto），
 * 所以这里必须照官方 ChatView 的做法把自滚动让出去：
 *   [data-conversation-scroll] .EvIC1a_scroll{flex:none;min-height:auto;overflow:visible}
 *
 * 第一版在这里自建了滚动容器并加了 overscroll-behavior 的 contain，结果是：
 * viewArea 在 active 相位下是 flex:1 0 auto;min-height:auto（高度随内容），
 * 于是这个 overflow-y:auto 的容器【没有可滚动的溢出量】；它仍然是命中的最近滚动
 * 容器，滚轮事件被它吃掉，而 contain 又禁止上抛给 scrollBody——触控板滚动整个
 * 失效，只剩直接拖外层滚动条还有用。这与实测症状完全一致。
 *
 * 注意本段落在模板字面量里，不能出现反引号，否则会截断样式表。
 */
.dsh-pinned-root{flex:1 1 0%;min-height:0;overflow-y:auto;}
[data-conversation-scroll] .dsh-pinned-root{flex:none;min-height:auto;overflow:visible;}
/*
 * 底部留白按官方轨迹视图的口径算：输入框是 scrollBody 里 position:sticky 的
 * 兄弟节点，会浮在内容之上，所以底部要留出一个输入框高度再加余量。
 */
.dsh-pinned-inner{max-width:var(--dsh-chat-content-width,760px);margin:0 auto;padding:20px 24px calc(var(--dsh-composer-height,152px) + 16px);display:flex;flex-direction:column;gap:22px;}
.dsh-pinned-head{display:flex;align-items:baseline;gap:10px;}
.dsh-pinned-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary);}
.dsh-pinned-count{font-size:12px;color:var(--dsw-alias-label-tertiary);}
.dsh-pinned-spacer{flex:1;}
.dsh-pinned-section{display:flex;flex-direction:column;gap:8px;}
.dsh-pinned-sectionHead{display:flex;align-items:baseline;gap:8px;}
.dsh-pinned-sectionTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);}
.dsh-pinned-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);}
.dsh-pinned-list{display:flex;flex-direction:column;gap:8px;}
.dsh-pinned-card{border:1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.22));border-radius:10px;background:var(--dsw-alias-bg-layer-1, transparent);padding:10px 12px;display:flex;flex-direction:column;gap:6px;}
.dsh-pinned-text{margin:0;white-space:pre-wrap;word-break:break-word;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;color:var(--dsw-alias-label-primary);max-height:260px;overflow-y:auto;}
.dsh-pinned-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);}
.dsh-pinned-empty{font-size:13px;color:var(--dsw-alias-label-tertiary);}
.dsh-pinned-compose{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.22));border-radius:10px;padding:10px 12px;}
.dsh-pinned-input{width:100%;box-sizing:border-box;resize:vertical;min-height:56px;max-height:200px;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2, transparent);border:1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.22));border-radius:8px;padding:8px 10px;outline:none;}
.dsh-pinned-input:focus{border-color:var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary));}
.dsh-pinned-actions{display:flex;align-items:center;gap:8px;}
`;
		const PLUGIN_CSS_TAG = "dsh-desktop-pinned/pinned.css";
		/**
		 * 注入样式，且只在首次物化时插一次（重复 apply 不会重复插入）。
		 */
		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector(`style[data-plugin-css="${PLUGIN_CSS_TAG}"]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-desktop-pinned";
			tag.dataset.pluginCss = PLUGIN_CSS_TAG;
			tag.textContent = PLUGIN_CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region 存储
		/** localStorage 是否已经探测过。 */
		let storageReady = false;
		/** 探测结果；不可用时为 undefined，此时退化为内存态。 */
		let storageValue;
		/** 空会话的稳定引用，供快照选择器按 `Object.is` 比较。 */
		const EMPTY_SESSION = Object.freeze({});

		/**
		 * 探测可用的 localStorage。
		 *
		 * 不能只判断 `localStorage` 存在：某些上下文里访问它本身就会抛。所以真的
		 * 写一次探针键，失败就退回内存态，让功能在受限环境下仍然能用，只是不持久。
		 * @returns 可用的 Storage，或 undefined。
		 */
		function storage() {
			if (storageReady) return storageValue;
			storageReady = true;
			try {
				const candidate = globalThis.localStorage;
				if (candidate !== undefined && candidate !== null) {
					candidate.setItem(`${STORAGE_KEY}:probe`, "1");
					candidate.removeItem(`${STORAGE_KEY}:probe`);
					storageValue = candidate;
				}
			} catch {
				storageValue = undefined;
			}
			return storageValue;
		}

		function isRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}

		/**
		 * 把一条来路不明的记录收敛成合法条目，非法则丢弃。
		 *
		 * 存储可能被手改、被旧版本写入或被其它代码污染，所以读进来一律过一遍，
		 * 而不是相信它。bucket 不认识就整条丢掉——分组是这套结构的全部意义。
		 * @param value - 待校验的条目。
		 * @returns 合法条目，或 undefined。
		 */
		function sanitizeItem(value) {
			if (!isRecord(value)) return undefined;
			if (value.bucket !== "pin" && value.bucket !== "hold") return undefined;
			return {
				bucket: value.bucket,
				text: typeof value.text === "string" ? value.text.slice(0, MAX_TEXT) : "",
				kind: typeof value.kind === "string" ? value.kind.slice(0, 40) : "",
				at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
			};
		}

		/**
		 * 收敛整个存储对象：丢掉非对象会话、非法条目。
		 * @param parsed - JSON.parse 的结果。
		 * @returns 干净的会话表。
		 */
		function sanitizeState(parsed) {
			if (!isRecord(parsed)) return {};
			const next = {};
			for (const [sessionId, session] of Object.entries(parsed)) {
				if (sessionId === "" || !isRecord(session)) continue;
				const items = {};
				for (const [messageId, item] of Object.entries(session)) {
					if (messageId === "") continue;
					const clean = sanitizeItem(item);
					if (clean !== undefined) items[messageId] = clean;
				}
				if (Object.keys(items).length > 0) next[sessionId] = items;
			}
			return next;
		}

		/** 从存储读出初始状态。 */
		function readState() {
			const store = storage();
			if (store === undefined) return {};
			try {
				const raw = store.getItem(STORAGE_KEY);
				return raw === null ? {} : sanitizeState(JSON.parse(raw));
			} catch {
				return {};
			}
		}

		let state = readState();
		const listeners = new Set();

		/** 订阅变化，返回退订函数。 */
		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}

		/** 快照：只在真正写入时换引用，`useSyncExternalStore` 依赖这个性质。 */
		function getSnapshot() {
			return state;
		}

		/** 某会话的条目表；空会话返回稳定引用。 */
		function getSession(sessionId) {
			return state[sessionId] ?? EMPTY_SESSION;
		}

		/** 某条消息所属的分组，未标记时为 undefined（基本类型，可安全做快照）。 */
		function getBucket(sessionId, messageId) {
			if (typeof messageId !== "string" || messageId === "") return undefined;
			return state[sessionId]?.[messageId]?.bucket;
		}

		/** 写盘 + 通知。 */
		function commit(next) {
			state = next;
			const store = storage();
			if (store !== undefined) {
				try {
					store.setItem(STORAGE_KEY, JSON.stringify(next));
				} catch {
					// 配额满或被拒绝：内存态继续工作，只是这次不落盘。
				}
			}
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch {
					// 单个订阅者出错不影响其它订阅者。
				}
			}
		}

		/**
		 * 超过上限时按时间淘汰最旧的条目。
		 * @param items - 单会话条目表。
		 * @returns 裁剪后的条目表。
		 */
		function capItems(items) {
			const entries = Object.entries(items);
			if (entries.length <= MAX_ITEMS_PER_SESSION) return items;
			entries.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
			return Object.fromEntries(entries.slice(0, MAX_ITEMS_PER_SESSION));
		}

		/**
		 * 切换一条消息的分组（纯函数，便于自测）。
		 *
		 * 两个分组互斥：点「置顶」会把它从「挂起」挪走，反之亦然；点已经激活的那个
		 * 则取消标记。互斥是刻意的——同一条内容同时出现在两栏只会让人怀疑哪份是新的。
		 * @param current - 当前会话表。
		 * @param sessionId - 会话 id。
		 * @param messageId - 消息 id（作键用）。
		 * @param bucket - 目标分组。
		 * @param payload - 快照内容与来源。
		 * @returns 新的会话表。
		 */
		function toggleIn(current, sessionId, messageId, bucket, payload) {
			const session = isRecord(current[sessionId]) ? current[sessionId] : {};
			const existing = session[messageId];
			if (existing !== undefined && existing.bucket === bucket) {
				const nextSession = { ...session };
				delete nextSession[messageId];
				return { ...current, [sessionId]: nextSession };
			}
			const item = sanitizeItem({
				bucket,
				text: payload?.text ?? "",
				kind: payload?.kind ?? "",
				at: Date.now(),
			});
			if (item === undefined) return current;
			return {
				...current,
				[sessionId]: capItems({ ...session, [messageId]: item }),
			};
		}

		/** 删掉一条（纯函数）。 */
		function removeIn(current, sessionId, messageId) {
			const session = current[sessionId];
			if (!isRecord(session) || session[messageId] === undefined) return current;
			const nextSession = { ...session };
			delete nextSession[messageId];
			return { ...current, [sessionId]: nextSession };
		}

		/** 清空一个会话（纯函数）。 */
		function clearIn(current, sessionId) {
			if (current[sessionId] === undefined) return current;
			const next = { ...current };
			delete next[sessionId];
			return next;
		}

		/** 切换标记。 */
		function toggleBucket(sessionId, messageId, bucket, payload) {
			commit(toggleIn(state, sessionId, messageId, bucket, payload));
		}

		/** 删除一条。 */
		function removeBucket(sessionId, messageId) {
			commit(removeIn(state, sessionId, messageId));
		}

		/** 清空当前会话。 */
		function clearSession(sessionId) {
			commit(clearIn(state, sessionId));
		}

		/**
		 * 手动添加一条：覆盖「我想记的东西不在助手消息动作条上」的情况，
		 * 比如我自己说过的一句要求，或者一段还没成形的念头。
		 * @param sessionId - 会话 id。
		 * @param bucket - 目标分组。
		 * @param text - 用户输入的内容。
		 */
		function addManual(sessionId, bucket, text) {
			const clean = normalizeText(text);
			if (clean === "") return;
			const key = `manual:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			commit(toggleIn(state, sessionId, key, bucket, { text: clean, kind: "manual" }));
		}
		//#endregion

		//#region 文本快照
		/**
		 * 归一化文本：合并行内空白、压掉三行以上空行、去首尾、截断。
		 * @param value - 原始文本。
		 * @returns 归一化结果。
		 */
		function normalizeText(value) {
			if (typeof value !== "string") return "";
			return value
				.split("\n")
				.map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
				.join("\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim()
				.slice(0, MAX_TEXT);
		}

		/**
		 * 把一条消息行读成可读纯文本。
		 *
		 * 先克隆、摘掉按钮与操作条，再挂进一个屏外容器后读 `innerText`：`innerText`
		 * 只有在渲染树里才返回带换行的文本，直接对游离克隆体调用只能拿到
		 * `textContent` 那种连成一整片的结果。摘按钮是因为动作条本身也在行内，
		 * 不摘的话「复制/点赞/置顶」这些标签会混进内容里。
		 * @param row - 消息行元素（`[data-chat-flow-key]`），可能为 null。
		 * @returns 归一化后的文本，最多 MAX_TEXT 个字符。
		 */
		function readRowText(row) {
			if (row === null || typeof document === "undefined") return "";
			const host = document.createElement("div");
			host.setAttribute("aria-hidden", "true");
			host.style.cssText = "position:fixed;left:-100000px;top:0;width:760px;white-space:pre-wrap;pointer-events:none;";
			const clone = row.cloneNode(true);
			for (const node of clone.querySelectorAll("button,svg,script,style,[class*='_actions']")) node.remove();
			host.appendChild(clone);
			document.body.appendChild(host);
			try {
				return normalizeText(host.innerText ?? clone.textContent ?? "");
			} catch {
				return normalizeText(clone.textContent ?? "");
			} finally {
				host.remove();
			}
		}

		/** 行节点上的消息种类标记。 */
		function kindOf(row) {
			return row === null || row === undefined ? "" : (row.getAttribute("data-chat-flow-kind") ?? "");
		}

		/**
		 * 列出「这条消息的正文可能在哪几个节点里」，最准的排前面。
		 *
		 * 这里踩过一个真实的坑，值得写清楚：**动作条不在助手消息节点内部**。
		 * `conversation.chat.assistant-actions` 是 `turn-tail`（回合尾部）节点的子槽位，
		 * 由 `TurnTailNodeView` 渲染成 `MessageIconActions` 的 `extraActions`；而
		 * `[data-chat-flow]` 列容器下的所有节点（`user` / `assistant-step` /
		 * `tool-call` / `turn-tail` …）都是**兄弟**，只用 `data-chat-turn` 标出所属回合。
		 * 所以从按钮 `closest()` 上溯只会拿到 `turn-tail`，那里只有产出文件行和动作
		 * 按钮，摘掉按钮后什么都不剩——第一版就是这么把空内容存进去的。
		 *
		 * 正文因此必须**横向**找：先用槽位给的 messageId 直击锚点节点，再取同回合的
		 * `assistant-step` 兄弟（从最后一个往前试，一个回合可能有多个步骤），
		 * 最后才退回按钮最近的 flow 祖先兜底。
		 * @param button - 被点击的动作按钮。
		 * @param messageId - 槽位给的持久消息 id。
		 * @returns 候选节点数组（可能为空）。
		 */
		function contentCandidates(button, messageId) {
			const candidates = [];
			const push = (node) => {
				if (node !== null && node !== undefined && !candidates.includes(node)) candidates.push(node);
			};
			const scope = typeof document === "undefined" ? null : document;

			if (scope !== null && messageId !== "") {
				const anchored = [...scope.querySelectorAll("[data-chat-anchor-key]")]
					.find((node) => node.getAttribute("data-chat-anchor-key") === messageId);
				push(anchored ?? null);
			}

			const tail = button.closest('[data-chat-flow-kind="turn-tail"]');
			if (tail !== null && scope !== null) {
				const turn = tail.getAttribute("data-chat-turn");
				const steps = [...scope.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
					.filter((node) => node.getAttribute("data-chat-turn") === turn);
				for (const step of steps.reverse()) push(step);
			}

			push(button.closest("[data-chat-flow-key]"));
			return candidates;
		}

		/**
		 * 抓一条消息的内容快照：按候选顺序取第一个「渲染着且非空」的节点。
		 *
		 * 「非空」这一条是必须的：折叠的 `turn-process`、只有工具调用的中间步骤都会给出
		 * 空文本，而正文在收尾那个节点里。「渲染着」用来跳过被折叠隐藏的节点——它们虽然
		 * 还能读出 `textContent`，但用户当时并没看到。
		 * @param button - 被点击的动作按钮。
		 * @param messageId - 槽位给的持久消息 id。
		 * @returns `{ text, kind }`；全部候选都空时 text 为空串，由界面显示「没抓到内容」。
		 */
		function captureFrom(button, messageId) {
			const candidates = contentCandidates(button, messageId);
			let hidden = null;
			for (const row of candidates) {
				const text = readRowText(row);
				if (text === "") continue;
				const rendered = typeof row.getClientRects !== "function" || row.getClientRects().length > 0;
				if (rendered) return { text, kind: kindOf(row) };
				if (hidden === null) hidden = { text, kind: kindOf(row) };
			}
			if (hidden !== null) return hidden;
			return { text: "", kind: candidates.length === 0 ? "" : kindOf(candidates[0]) };
		}

		/**
		 * 收敛消息键，优先用槽位给的 messageId，缺失时回退到 DOM 上的锚点键。
		 * @param value - 候选键。
		 * @returns 非空字符串，或空串。
		 */
		function cleanKey(value) {
			return typeof value === "string" && value !== "" ? value : "";
		}
		//#endregion

		//#region 图标
		/**
		 * 置顶图钉。
		 *
		 * 官方图标集里没有图钉/书签（81 个图标逐个查过：`Icon` 前缀下只有
		 * `IconPauseOutline16` 之类，没有 pin/bookmark/flag/star），而这件事语义上
		 * 就该是图钉，所以这里内联一个 24 网格的实心图钉路径，用 `currentColor`
		 * 跟按钮文字色联动。挂起则直接用官方 `IconPauseOutline16`。
		 * @param props - 仅取尺寸。
		 * @returns 图钉 svg。
		 */
		function PinGlyph({ size = 15 }) {
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "currentColor",
				"aria-hidden": "true",
				focusable: "false",
				children: h("path", {
					d: "M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z",
				}),
			});
		}
		//#endregion

		//#region 组件
		/**
		 * 动作条上的两个按钮。
		 *
		 * 键优先取槽位给的 `messageId`；万一它缺失，就在挂载后从最近的
		 * `[data-chat-flow-key]` 行上补一个锚点键——这样「已标记」的高亮和切换用的
		 * 是同一个键，不会出现「点了没反应」或「高亮对不上」。
		 * @param props - `sessionId` 与槽位给的 `messageId`。
		 * @returns 两个动作按钮。
		 */
		function PinnedActions({ sessionId, messageId }) {
			const hostRef = react.useRef(null);
			const [key, setKey] = react.useState(() => cleanKey(messageId));

			react.useEffect(() => {
				if (key !== "") return;
				const row = hostRef.current === null ? null : hostRef.current.closest("[data-chat-flow-key]");
				if (row === null) return;
				const anchor = cleanKey(row.getAttribute("data-chat-anchor-key")) || cleanKey(row.getAttribute("data-chat-flow-key"));
				if (anchor !== "") setKey(anchor);
			}, [key]);

			const active = react.useSyncExternalStore(subscribe, () => getBucket(sessionId, key));

			const toggle = (bucket) => (event) => {
				if (key === "") return;
				// 注意不能只从按钮上溯取内容：动作条在 turn-tail 节点里，与正文是兄弟关系
				toggleBucket(sessionId, key, bucket, captureFrom(event.currentTarget, cleanKey(messageId) || key));
			};

			return hs("span", {
				ref: hostRef,
				className: "dsh-pinned-host",
				children: [
					h(primitives.Tooltip, {
						key: "pin",
						label: active === "pin" ? "取消置顶" : "置顶",
						side: "bottom",
						children: h("button", {
							type: "button",
							className: "dsh-pinned-action",
							"aria-label": "置顶",
							"aria-pressed": active === "pin",
							"data-active": active === "pin" || undefined,
							onClick: toggle("pin"),
							children: h(PinGlyph, { size: 15 }),
						}),
					}),
					h(primitives.Tooltip, {
						key: "hold",
						label: active === "hold" ? "取消挂起" : "挂起",
						side: "bottom",
						children: h("button", {
							type: "button",
							className: "dsh-pinned-action",
							"aria-label": "挂起",
							"aria-pressed": active === "hold",
							"data-active": active === "hold" || undefined,
							onClick: toggle("hold"),
							children: h(primitives.IconPauseOutline16, {}),
						}),
					}),
				],
			});
		}

		/**
		 * 取某分组下的条目，新的在前。
		 * @param session - 单会话条目表。
		 * @param bucket - 分组。
		 * @returns 条目数组，每项带上自己的键。
		 */
		function listBucket(session, bucket) {
			const rows = [];
			for (const [messageId, item] of Object.entries(session)) {
				if (item.bucket !== bucket) continue;
				rows.push({ messageId, ...item });
			}
			rows.sort((a, b) => b.at - a.at);
			return rows;
		}

		/**
		 * 「置顶」标签页：两个分组 + 一个手动添加框。
		 * @param props - 槽位注入的 `sessionId`。
		 * @returns 标签页内容。
		 */
		function PinnedView({ sessionId }) {
			const session = react.useSyncExternalStore(subscribe, () => getSession(sessionId));
			const [draft, setDraft] = react.useState("");
			const [confirmingClear, setConfirmingClear] = react.useState(false);

			const groups = BUCKETS.map((bucket) => ({ bucket, rows: listBucket(session, bucket) }));
			const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

			react.useEffect(() => {
				if (!confirmingClear) return undefined;
				const timer = setTimeout(() => setConfirmingClear(false), 4000);
				return () => clearTimeout(timer);
			}, [confirmingClear]);

			const add = (bucket) => {
				addManual(sessionId, bucket, draft);
				setDraft("");
			};

			const card = (row) =>
				h("div", {
					key: row.messageId,
					className: "dsh-pinned-card",
					children: hs(Fragment, {
						children: [
							h("div", {
								className: "dsh-pinned-meta",
								children: [
									h("span", { key: "kind", children: NODE_KIND_LABEL[row.kind] ?? (row.kind === "" ? "未知来源" : row.kind) }),
									h("span", { key: "time", children: row.at === 0 ? "" : new Date(row.at).toLocaleString() }),
									h("span", { key: "spacer", className: "dsh-pinned-spacer" }),
									h(primitives.Button, {
										key: "remove",
										variant: "ghost",
										onClick: () => removeBucket(sessionId, row.messageId),
										children: "移除",
									}),
								],
							}),
							h("pre", {
								className: "dsh-pinned-text",
								children: row.text === "" ? "（这条没抓到内容，消息 id：" + row.messageId + "）" : row.text,
							}),
						],
					}),
				});

			const section = (group) =>
				h("div", {
					key: group.bucket,
					className: "dsh-pinned-section",
					children: [
						h("div", {
							key: "head",
							className: "dsh-pinned-sectionHead",
							children: [
								h("span", { key: "title", className: "dsh-pinned-sectionTitle", children: BUCKET_TITLE[group.bucket] }),
								h("span", { key: "count", className: "dsh-pinned-count", children: `${group.rows.length} 条` }),
								h("span", { key: "hint", className: "dsh-pinned-hint", children: BUCKET_HINT[group.bucket] }),
							],
						}),
						group.rows.length === 0
							? h("div", { key: "empty", className: "dsh-pinned-empty", children: `还没有${BUCKET_TITLE[group.bucket]}的内容。` })
							: h("div", { key: "list", className: "dsh-pinned-list", children: group.rows.map(card) }),
					],
				});

			return h("div", {
				className: "dsh-pinned-root",
				children: h("div", {
					className: "dsh-pinned-inner",
					children: [
						h("div", {
							key: "head",
							className: "dsh-pinned-head",
							children: [
								h("span", { key: "title", className: "dsh-pinned-title", children: "置顶与挂起" }),
								h("span", { key: "count", className: "dsh-pinned-count", children: `本会话共 ${total} 条` }),
								h("span", { key: "spacer", className: "dsh-pinned-spacer" }),
								h(primitives.Button, {
									key: "clear",
									variant: "outline",
									disabled: total === 0,
									onClick: () => {
										if (!confirmingClear) {
											setConfirmingClear(true);
											return;
										}
										clearSession(sessionId);
										setConfirmingClear(false);
									},
									children: confirmingClear ? "再点一次确认清空" : "清空本会话",
								}),
							],
						}),
						h("div", {
							key: "compose",
							className: "dsh-pinned-compose",
							children: [
								h("textarea", {
									key: "input",
									className: "dsh-pinned-input",
									value: draft,
									placeholder: "手动记一条：我自己说过的要求、还没成形的念头……",
									onChange: (event) => setDraft(event.target.value),
								}),
								h("div", {
									key: "actions",
									className: "dsh-pinned-actions",
									children: [
										h(primitives.Button, { key: "addPin", variant: "primary", disabled: normalizeText(draft) === "", onClick: () => add("pin"), children: "置顶" }),
										h(primitives.Button, { key: "addHold", variant: "outline", disabled: normalizeText(draft) === "", onClick: () => add("hold"), children: "挂起" }),
									],
								}),
							],
						}),
						...groups.map(section),
					],
				}),
			});
		}
		//#endregion

		/** 需要的客户端服务：UI 槽位注册表。 */
		const inject = ["slots"];

		/**
		 * 注册一个标签页与一组消息动作。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			installStyles();
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: VIEW_ID,
				order: VIEW_ORDER,
				label: () => BUCKET_TITLE.pin,
				inject: (sessionId) => ({ sessionId }),
			}, PinnedView));
			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
				name: "conversation.chat.assistant-actions",
				id: VIEW_ID,
				order: ACTION_ORDER,
				inject: (sessionId) => ({ sessionId }),
			}, PinnedActions));
		}

		exports.apply = apply;
		exports.inject = inject;
		/** 自测接缝：纯逻辑与常量，供 `selftest-client.mjs` 直接驱动，不经过渲染。 */
		exports.__test = {
			ACTION_ORDER,
			BUCKETS,
			MAX_ITEMS_PER_SESSION,
			MAX_TEXT,
			STORAGE_KEY,
			VIEW_ID,
			VIEW_ORDER,
			addManual,
			PLUGIN_CSS,
			captureFrom,
			cleanKey,
			contentCandidates,
			kindOf,
			clearIn,
			getBucket,
			getSession,
			getSnapshot,
			listBucket,
			normalizeText,
			readRowText,
			removeIn,
			sanitizeItem,
			sanitizeState,
			subscribe,
			toggleIn,
			PinnedActions,
			PinnedView,
		};
		return module.exports;
	},
});
