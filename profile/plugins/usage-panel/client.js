/**
 * DeepSeek usage panel — browser half.
 *
 * Registers one `sidebar.footer.action` occupant: a sidebar-foot button that
 * opens a panel showing the official account balance (the only usage figure
 * DeepSeek publishes) beside a locally recomputed token ledger.
 *
 * Data arrives from the sibling host half over the Connection shared Fetch
 * handler (`/api/usage/balance`, `/api/usage/tokens`), which the desktop
 * Electron shell dispatches in-process — the page never holds the API key.
 *
 * The bundle is a hand-written module-factory registration rather than a build
 * artifact: `@deepseek-ai/dsh-client-modules` executes it by calling
 * `window.__ModuleLoader__.load`, and `react`, `react/jsx-runtime`,
 * `@deepseek-ai/dsh-client-ui-primitives`, and `@deepseek-ai/dsh-client-ui-slots`
 * are platform seed words the loader answers without a graph row.
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-usage-panel",
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

		/**
		 * The panel is taller than a laptop window, and the shared `Modal`
		 * primitive applies no height cap of its own — its dialog simply grows
		 * past the viewport, which pushes the header and the top of the report
		 * off-screen. These rules cap the modal's content wrapper to the viewport
		 * and scroll it internally, so the title bar and the footer buttons stay
		 * reachable while the report scrolls under them.
		 *
		 * `contentClassName` lands on the primitive's content wrapper and
		 * `className` on its dialog box, both appended after the primitive's own
		 * class (the primitive composes them with `clsx`), so a two-class
		 * descendant selector is enough to win without `!important`. The wrapper
		 * is set up as a flex column so `overflow-y: auto` resolves against a
		 * definite height instead of the content's own size.
		 */
		const PANEL_CSS = `
.dsh-usage-modal{max-height:calc(100vh - 48px);}
.dsh-usage-content{display:flex;flex-direction:column;max-height:calc(100vh - 150px);overflow-y:auto;overscroll-behavior:contain;}
.dsh-usage-content::-webkit-scrollbar{width:8px;}
.dsh-usage-content::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,0.4));border-radius:4px;}
.dsh-usage-content::-webkit-scrollbar-track{background:transparent;}
`;
		const PANEL_CSS_TAG = "dsh-desktop-usage-panel/panel.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${PANEL_CSS_TAG}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-desktop-usage-panel";
			tag.dataset.pluginCss = PANEL_CSS_TAG;
			tag.textContent = PANEL_CSS;
			document.head.appendChild(tag);
		}

		/** Host routes owned by this plugin's host half. */
		const BALANCE_PATH = "/api/usage/balance";
		const TOKENS_PATH = "/api/usage/tokens";
		/** Panel polling cadence while the panel is open, in milliseconds. */
		const POLL_MS = 20_000;
		/** Longest a single host request may take before the UI gives up. */
		const REQUEST_TIMEOUT_MS = 20_000;
		/**
		 * Authority the shell's bridge reconstructs requests against.
		 *
		 * The desktop page is served over `file://` and electron reports that
		 * page's `location.origin` as the literal string `"file://"`, so a URL
		 * resolved against it (`file:///api/usage/balance`) is a file URL.
		 * Electron refuses to fetch a file URL from a page like this, and the
		 * rejection happens before the IPC bridge is ever reached. The HTTP-like
		 * check therefore keys on the protocol rather than on the `"null"` string
		 * that `@deepseek-ai/dsh-client-connection`'s `resolveBase()` tests for,
		 * which no `file://` page actually reports.
		 */
		const INTERNAL_BASE = "http://dsh.internal";

		/** Resolve the `/api` authority this page's carrier expects. */
		function resolveApiBase() {
			try {
				const origin = globalThis.location?.origin;
				if (origin !== undefined && /^https?:$/.test(new URL(origin).protocol)) return origin;
			} catch {
				// An unparseable origin falls through to the internal authority.
			}
			return INTERNAL_BASE;
		}

		/**
		 * Resolve the fetch implementation that can actually reach the host.
		 *
		 * The shell installs its IPC carrier on `globalThis.__DSH_TRANSPORT__`
		 * (see this profile's `desktop-runtime` plugin) and deliberately does not
		 * replace the page's `fetch`: `dsh-client-connection` reads
		 * `transport.fetch` directly, so the app's own Remote traffic never
		 * touches the global. A page-level `fetch("/api/…")` therefore stays the
		 * native browser fetch, which cannot reach the host from `file://` and
		 * rejects with `TypeError: Failed to fetch` before any IPC request is
		 * made. Preferring the carrier keeps this plugin working on the Web
		 * surface too, where no carrier is installed and the same-origin native
		 * fetch is the correct transport.
		 *
		 * @returns a Fetch-compatible function.
		 */
		function resolveFetch() {
			const carrier = globalThis.__DSH_TRANSPORT__;
			if (carrier !== undefined && typeof carrier.fetch === "function") return carrier.fetch;
			return (input, init) => globalThis.fetch(input, init);
		}

		/**
		 * Call one host route and decode its JSON body.
		 * @param path - absolute route path below `/api`.
		 * @param query - optional query string (without the leading `?`).
		 * @returns the decoded body, or a thrown Error carrying the HTTP status.
		 */
		async function callHost(path, query = "") {
			const href = new URL(`${path}${query === "" ? "" : `?${query}`}`, resolveApiBase()).href;
			const response = await resolveFetch()(new Request(href, {
				method: "GET",
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}));
			let body;
			try {
				body = await response.json();
			} catch {
				throw new Error(`${path}: HTTP ${String(response.status)} with a non-JSON body`);
			}
			if (!response.ok && body?.ok !== false) throw new Error(`${path}: HTTP ${String(response.status)}`);
			return body;
		}

		/** Format an integer token count with thousands separators. */
		function int(value) {
			return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "–";
		}

		/** Format a large token count compactly (12.3M / 456K). */
		function compact(value) {
			if (!Number.isFinite(value)) return "–";
			const abs = Math.abs(value);
			if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
			if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
			if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
			return String(Math.round(value));
		}

		/** Format a 0..1 ratio as a percentage. */
		function percent(value) {
			return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "–";
		}

		/** Format an amount with at most four decimals, trimming trailing zeros. */
		function amount(value) {
			if (!Number.isFinite(value)) return "–";
			return String(Number(value.toFixed(4)));
		}

		/** Inline style helpers keep the panel independent of shell CSS modules. */
		const styles = {
			root: { position: "relative", display: "flex", flexDirection: "column" },
			button: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				width: "100%",
				boxSizing: "border-box",
				cursor: "pointer",
				border: "none",
				background: "transparent",
				borderRadius: "12px",
				color: "var(--dsw-alias-label-primary)",
				font: "inherit",
				fontSize: "14px",
				lineHeight: "22px",
				padding: "8px 10px",
				textAlign: "left",
			},
			buttonRail: { justifyContent: "center", padding: "8px 0" },
			grow: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			value: { color: "var(--dsw-alias-label-secondary)", fontVariantNumeric: "tabular-nums", fontSize: "13px" },
			section: { display: "flex", flexDirection: "column", gap: "10px", padding: "4px 0 14px" },
			sectionTitle: {
				color: "var(--dsw-alias-label-secondary)",
				fontSize: "12px",
				letterSpacing: "0.04em",
				textTransform: "uppercase",
			},
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))",
				borderRadius: "16px",
				padding: "14px 16px",
			},
			row: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "12px" },
			label: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px" },
			strong: { fontSize: "20px", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
			mono: { fontVariantNumeric: "tabular-nums" },
			note: { color: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))", fontSize: "12px", lineHeight: "18px" },
			error: { color: "var(--dsw-alias-label-error, #d4380d)", fontSize: "13px", lineHeight: "20px" },
			ok: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px" },
			table: { display: "flex", flexDirection: "column", gap: "6px" },
			tableRow: { display: "grid", gridTemplateColumns: "1fr auto auto", gap: "10px", alignItems: "baseline", fontSize: "13px" },
			bars: { display: "flex", alignItems: "flex-end", gap: "6px", height: "72px", paddingTop: "6px" },
			barCol: { display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", flex: "1 1 0", minWidth: 0 },
			bar: {
				width: "100%",
				minHeight: "2px",
				borderRadius: "4px 4px 0 0",
				// The alias-hover token is far too faint for a data mark, so the
				// bars ride the primary label color at a fixed opacity instead.
				background: "var(--dsw-alias-label-primary)",
				opacity: 0.55,
			},
			barDay: { color: "var(--dsw-alias-label-secondary)", fontSize: "10px", whiteSpace: "nowrap" },
		};

		/** One labelled value row inside a card. */
		function Row({ label, value, strong = false }) {
			return hs("div", {
				style: styles.row,
				children: [
					h("span", { style: styles.label, children: label }),
					h("span", { style: strong ? styles.strong : { ...styles.mono, fontSize: "14px" }, children: value }),
				],
			});
		}

		/** One section heading. */
		function SectionTitle({ children }) {
			return h("div", { style: styles.sectionTitle, children });
		}

		/** Render the balance card from one host answer. */
		function BalanceCard({ balance }) {
			if (balance === undefined) return h("div", { style: styles.ok, children: "余额加载中…" });
			if (balance.ok !== true) {
				return hs("div", { style: styles.card, children: [
					h(Row, { label: "官方余额", value: "不可用" }),
					h("div", { style: styles.error, children: String(balance.message ?? balance.code ?? "未知错误") }),
					h("div", { style: styles.note, children: `凭据引用：${String(balance.apiKeyEnv ?? "–")}（在 Settings → Models 中配置 API Key）` }),
				] });
			}
			const infos = Array.isArray(balance.infos) ? balance.infos : [];
			return hs("div", { style: styles.card, children: [
				...infos.map((info) => h(Row, {
					key: `${info.currency}`,
					label: `官方余额 · ${info.currency}`,
					value: info.totalBalance,
					strong: true,
				})),
				infos.length === 0 ? h("div", { style: styles.ok, children: "接口未返回余额明细" }) : null,
				h(Row, { label: "账户可用", value: balance.isAvailable === true ? "是" : "否" }),
				h("div", { style: styles.note, children: balance.cached === true ? "来自 host 短缓存（30s）" : "刚向官方接口查询" }),
			] });
		}

		/** Render the estimated-cost card. */
		function CostCard({ tokens }) {
			const cost = tokens?.cost;
			if (cost === undefined) return null;
			return hs("div", { style: styles.card, children: [
				h(Row, { label: "估算花费（本地重算）", value: `${amount(cost.usd)} ${cost.currency}`, strong: true }),
				h(Row, { label: "折合人民币", value: `≈ ${amount(cost.cny)} CNY` }),
				h(Row, {
					label: "单价 / 1M",
					value: `缓存命中 ${amount(cost.cacheHitPerMillion)} · 未命中 ${amount(cost.cacheMissPerMillion)} · 输出 ${amount(cost.outputPerMillion)}`,
				}),
				h("div", { style: styles.note, children: String(cost.note ?? "") }),
			] });
		}

		/** Render the token-bucket card. */
		function TokenCard({ tokens }) {
			const buckets = tokens?.buckets;
			const metrics = tokens?.metrics;
			if (buckets === undefined || metrics === undefined) {
				return h("div", { style: styles.ok, children: "用量加载中…" });
			}
			return hs("div", { style: styles.card, children: [
				h(Row, { label: "总 token（本地累计）", value: compact(metrics.totalTokens), strong: true }),
				h(Row, { label: "缓存命中输入", value: `${int(buckets.cacheReadTokens)} · ${percent(metrics.cacheHitRatio)}` }),
				h(Row, { label: "缓存未命中输入", value: int(buckets.uncachedInputTokens) }),
				h(Row, { label: "输出", value: int(buckets.outputTokens) }),
				buckets.cacheWriteTokens > 0 ? h(Row, { label: "缓存写入", value: int(buckets.cacheWriteTokens) }) : null,
				h("div", { style: styles.note, children: `覆盖 ${String(tokens.sessions ?? 0)} 个本地会话；缓存命中率越高，单价越低（命中约为未命中的 1/50）。` }),
			] });
		}

		/** Render the per-day bars. */
		function DayBars({ days }) {
			if (!Array.isArray(days) || days.length === 0) return null;
			const recent = days.slice(-14);
			const peak = recent.reduce((max, day) => Math.max(max, (day.uncachedInputTokens ?? 0) + (day.cacheReadTokens ?? 0) + (day.outputTokens ?? 0)), 0);
			return hs("div", { style: styles.section, children: [
				h(SectionTitle, { children: `按天用量（近 ${String(recent.length)} 个有记录的日期）` }),
				h("div", { style: styles.bars, children: recent.map((day) => {
					const total = (day.uncachedInputTokens ?? 0) + (day.cacheReadTokens ?? 0) + (day.outputTokens ?? 0);
					const height = peak === 0 ? 2 : Math.max(2, Math.round((total / peak) * 62));
					return hs("div", {
						key: day.day,
						style: styles.barCol,
						title: `${day.day}\n总 token ${int(total)}\n缓存命中 ${int(day.cacheReadTokens)}\n未命中 ${int(day.uncachedInputTokens)}\n输出 ${int(day.outputTokens)}\n会话 ${String(day.sessions)}`,
						children: [
							h("div", { style: { ...styles.bar, height: `${String(height)}px` } }),
							h("div", { style: styles.barDay, children: day.day.slice(5) }),
						],
					});
				}) }),
			] });
		}

		/** Render the per-session table. */
		function SessionTable({ sessions }) {
			if (!Array.isArray(sessions) || sessions.length === 0) return null;
			return hs("div", { style: styles.section, children: [
				h(SectionTitle, { children: "用量最高的会话" }),
				h("div", { style: styles.table, children: [
					h("div", { style: { ...styles.tableRow, ...styles.label }, children: [
						h("span", { children: "会话" }),
						h("span", { children: "命中率" }),
						h("span", { children: "总 token" }),
					] }),
					...sessions.map((session) => {
						const cached = session.buckets?.cacheReadTokens ?? 0;
						const uncached = session.buckets?.uncachedInputTokens ?? 0;
						const ratio = cached + uncached === 0 ? null : cached / (cached + uncached);
						return h("div", {
							key: session.sessionId,
							style: styles.tableRow,
							title: `${session.sessionId}${session.createdAt === null ? "" : `\n${new Date(session.createdAt).toLocaleString()}`}`,
							children: [
								h("span", { style: styles.grow, children: session.title === "" ? session.sessionId : session.title }),
								h("span", { style: styles.mono, children: percent(ratio) }),
								h("span", { style: styles.mono, children: compact(session.totalTokens) }),
							],
						});
					}),
				] }),
			] });
		}

		/** Render the diagnostics footer. */
		function Diagnostics({ tokens }) {
			const diagnostics = tokens?.diagnostics;
			if (diagnostics === undefined) return null;
			return hs("div", { style: styles.section, children: [
				h(SectionTitle, { children: "数据来源" }),
				h("div", { style: styles.note, children: [
					`DSH home：${String(diagnostics.home)}`,
					` · 投影缓存 v${String(diagnostics.supportedProjectionVersion)}：${String(diagnostics.projectionCacheRows)} 条可用，${String(diagnostics.projectionCacheSkipped)} 条跳过`,
					` · 会话日志 ${String(diagnostics.logFiles)} 个（回退解析 ${String(diagnostics.logFallbackRows)} 条）`,
				].join("") }),
				h("div", { style: styles.note, children: "官方接口只提供余额，不提供 token 用量；token 数字来自本地会话日志重算，仅覆盖本机发出的请求。" }),
			] });
		}

		/**
		 * The sidebar-foot occupant: one button plus the panel it opens.
		 * @param props - slot runtime props (`wide`) plus this plugin's injected face.
		 */
		function UsagePanel({ wide, loadUsage }) {
			const [open, setOpen] = react.useState(false);
			const [state, setState] = react.useState({ phase: "idle", balance: undefined, tokens: undefined, error: undefined });

			const refresh = react.useCallback(async () => {
				setState((previous) => ({ ...previous, phase: "loading" }));
				try {
					const [balance, tokens] = await Promise.all([loadUsage("balance"), loadUsage("tokens")]);
					setState({ phase: "ready", balance, tokens, error: undefined });
				} catch (error) {
					setState((previous) => ({ ...previous, phase: "error", error: error instanceof Error ? error.message : String(error) }));
				}
			}, [loadUsage]);

			react.useEffect(() => {
				if (!open) return undefined;
				void refresh();
				const timer = setInterval(() => void refresh(), POLL_MS);
				return () => clearInterval(timer);
			}, [open, refresh]);

			const balanceValue = (() => {
				const infos = state.balance?.infos;
				if (state.balance?.ok !== true || !Array.isArray(infos) || infos.length === 0) return "";
				const info = infos[0];
				return `${info.totalBalance} ${info.currency}`;
			})();

			return hs(Fragment, { children: [
				h("div", { style: styles.root, children: h("button", {
					type: "button",
					style: wide ? styles.button : { ...styles.button, ...styles.buttonRail },
					title: "DeepSeek 用量与余额",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					onClick: () => setOpen(true),
					children: [
						h("span", { "aria-hidden": "true", children: "📊" }),
						wide ? h("span", { style: styles.grow, children: "用量" }) : null,
						wide && balanceValue !== "" ? h("span", { style: styles.value, children: balanceValue }) : null,
					],
				}) }),
				h(primitives.Modal, {
					open,
					onClose: () => setOpen(false),
					title: "DeepSeek 用量与余额",
					closeLabel: "关闭",
					description: "官方余额 + 本地 token 用量重算",
					className: "dsh-usage-modal",
					contentClassName: "dsh-usage-content",
					footer: hs(Fragment, { children: [
						h(primitives.Button, {
							variant: "outline",
							onClick: () => void refresh(),
							disabled: state.phase === "loading",
							children: state.phase === "loading" ? "刷新中…" : "刷新",
						}),
						h(primitives.Button, { variant: "outline", onClick: () => setOpen(false), children: "关闭" }),
					] }),
					children: hs("div", { style: { display: "flex", flexDirection: "column" }, children: [
						state.error === undefined ? null : h("div", { style: styles.error, children: state.error }),
						h(SectionTitle, { children: "官方账户" }),
						h(BalanceCard, { balance: state.balance }),
						h(SectionTitle, { children: "本地 token 用量" }),
						h(TokenCard, { tokens: state.tokens }),
						h(CostCard, { tokens: state.tokens }),
						h(DayBars, { days: state.tokens?.byDay }),
						h(SessionTable, { sessions: state.tokens?.topSessions }),
						h(Diagnostics, { tokens: state.tokens }),
					] }),
				}),
			] });
		}

		/** Required client services: the UI slot registry. */
		const inject = ["slots"];

		/**
		 * Register the footer action.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const loadUsage = async (kind) => {
				if (kind === "balance") return callHost(BALANCE_PATH);
				return callHost(TOKENS_PATH, "scope=all");
			};
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "usage-panel",
				order: 90,
				inject: () => ({ loadUsage }),
			}, UsagePanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		/** Test seam: the host-route caller, exercised directly by `selftest-client.mjs`. */
		exports.callHost = callHost;
		return module.exports;
	},
});
