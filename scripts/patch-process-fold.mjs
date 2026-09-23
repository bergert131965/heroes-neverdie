#!/usr/bin/env node
/**
 * Progressive Turn-process fold patch for `@deepseek-ai/dsh-client-ui-chat`.
 *
 * The shipped client bundle is a build artifact, so this patch is applied as a
 * deterministic transform of a **pristine** copy rather than by hand-editing the
 * working file: every run starts from an untouched bundle, applies each anchored
 * replacement exactly once, and writes the result to both the workspace copy
 * (`npm start`) and the packaged `.app` copy. Re-running is therefore safe and
 * idempotent, and a bundle that no longer matches the anchors fails loudly
 * instead of being silently half-patched.
 *
 *   node scripts/patch-process-fold.mjs                 # patch + verify
 *   node scripts/patch-process-fold.mjs --check         # verify only
 *
 * A pristine source is discovered from the packaged builds under `release/`
 * (any that predates the patch) unless `--from <path>` names one explicitly. `npm install`
 * or a `@deepseek-ai/dsh` upgrade overwrites `node_modules`, so run this again
 * after either; `docs/process-fold-progressive.md` explains the behaviour.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const RELATIVE = "node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";
const targets = [join(root, RELATIVE), join(root, "release")];

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const explicit = args.includes("--from") ? args[args.indexOf("--from") + 1] : undefined;

/**
 * Every intentional change, as one anchored literal replacement. Each entry is
 * applied exactly once; a missing or duplicated anchor aborts the run.
 */
const patches = [
	{
		name: "store helper for the open-Turn progressive disclosure",
		from: `		function storedTurnProcessEntry(state, turn) {
			return state.turnProcesses.find((entry) => entry.turn === turn);
		}`,
		to: `		function storedTurnProcessEntry(state, turn) {
			return state.turnProcesses.find((entry) => entry.turn === turn);
		}
		/**
		* Whether the local progressive fold of one open Turn is manually expanded.
		* The same store slice carries both disclosures: a closed Turn keys its entry
		* by answer Step, while an open Turn keys it by the reserved \`-1\` generation.
		* @param state - Chat store snapshot.
		* @param turn - owning Turn.
		* @returns whether the open Turn's progressive fold is expanded.
		*/
		function storedTurnProcessProgressOpen(state, turn) {
			return state.turnProcesses.find((entry) => entry.turn === turn)?.answerStep === -1;
		}`,
	},
	{
		name: "location helpers beside the seat",
		from: `		function turnOf(node) {
			const location = node?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : void 0;
		}
		/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */`,
		to: `		function turnOf(node) {
			const location = node?.location;
			return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : void 0;
		}
		/**
		* Read the Step number that owns one Chat Node, when the projection exposes it.
		* @param node - routed Chat Node.
		* @returns the Step number, or 0 when the Node carries none.
		*/
		function processStepOfNode(node) {
			const step = node?.data?.step;
			if (typeof step === "number") return step;
			const location = node?.location;
			if (location?.kind === "step" && typeof location.step?.step === "number") return location.step.step;
			return 0;
		}
		/**
		* Read the Step number of one Turn Step record.
		* @param step - Turn Step record, when present.
		* @returns the Step number, or null when absent.
		*/
		function processStepOf(step) {
			return typeof step?.step === "number" ? step.step : null;
		}
		/**
		* Resolve the Turn that owns one routed Node once that Turn really ended.
		* The shipped Turn-level fold keys on the same fact, but it additionally
		* requires fully loaded history; this drawer must not.
		* @param node - routed Chat Node.
		* @returns the finished Turn, or undefined while it still runs.
		*/
		function turnWithCompletion(node) {
			const location = node?.location;
			if (location?.kind !== "step" && location?.kind !== "turn") return void 0;
			return location.turn.status === "closed" ? location.turn : void 0;
		}
		/**
		* Whether one routed Node is the final answer row of its finished Turn.
		* @param node - routed Chat Node.
		* @returns whether the row carries the Turn's closing text.
		*/
		function isFinalAnswerRow(node) {
			const final = node?.data?.finalNode;
			if (final === void 0) return false;
			return (final.blocks ?? []).some((block) => block.kind === "text" && block.text.trim() !== "");
		}
		/**
		* Read the Step number that opens a finished Turn's final answer, which is
		* the boundary the drawer keeps visible. The projected step record is the
		* primary source; when a window omits its step number, the Turn end falls
		* back to the answer Step the final settled Assistant node reports.
		* @param turn - Turn that already ended.
		* @param node - routed Chat Node being rendered.
		* @returns the final answer Step number, or null when neither source has it.
		*/
		function answerStepOf(turn, node) {
			const last = processStepOf(turn?.steps?.at(-1));
			if (last !== null) return last;
			const final = node?.data?.finalNode;
			return final === void 0 || typeof final.step !== "number" ? null : final.step;
		}
		/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */`,
	},
	{
		name: "open-Turn disclosure state inside ChatNodeSeat",
		from: `			const setOpen = (0, react.useCallback)((open) => {
				if (processSpec !== void 0 && processSpec.answerStep !== null) actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep, open);
			}, [actions, processSpec]);`,
		to: `			const setOpen = (0, react.useCallback)((open) => {
				if (processSpec !== void 0 && processSpec.answerStep !== null) actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep, open);
			}, [actions, processSpec]);
			const progressOpen = useStore((state) => turn === void 0 ? false : storedTurnProcessProgressOpen(state, turn));
			const setProgressOpen = (0, react.useCallback)((open) => {
				if (turn !== void 0) actions.setTurnProcessOpen(turn, -1, open);
			}, [actions, turn]);`,
	},
	{
		name: "progressive branch and chip wiring",
		from: `			const controllerInactive = routedNode?.kind === "turn-process" && !foldable;
			const compactAnswer = processAnswer && foldable && processPresentation.compactAnswer && !processOpen;
			const processHidden = controllerInactive || foldable && processMember && !processOpen;
			const wrapperRef = useSearchableHidden(processHidden, (0, react.useCallback)(() => {
				if (processMember) setOpen(true);
			}, [processMember, setOpen]));`,
		to: `			/*
			 * Completed-Turn process drawer. While a Turn runs, every process row
			 * stays exactly as the shipped UI renders it. Once the Turn is really
			 * finished (its Turn-end event is durable), the whole process run folds
			 * behind one summary chip and the final answer stays visible.
			 * The unrelated historyIncomplete flag deliberately does not gate this: with older
			 * history still unloaded the shipped fold is off, and a Turn with a
			 * hundred Steps would otherwise stay fully expanded forever.
			 */
			const progressTurn = routedNode !== void 0 && compactTranscript ? turnWithCompletion(routedNode) : void 0;
			const progressStep = progressTurn === void 0 ? null : answerStepOf(progressTurn, routedNode);
			const progressFolded = progressTurn !== void 0 && !progressOpen && !processOpen;
			const progressAnswer = isFinalAnswerRow(routedNode);
			const progressMember = progressFolded && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind) && !progressAnswer;
			const progressChip = progressTurn !== void 0 && progressStep !== 1 && progressAnswer;
			const controllerInactive = routedNode?.kind === "turn-process" && !foldable;
			const compactAnswer = processAnswer && foldable && processPresentation.compactAnswer && !processOpen;
			const processHidden = controllerInactive || foldable && processMember && !processOpen || progressMember;
			const wrapperRef = useSearchableHidden(processHidden, (0, react.useCallback)(() => {
				if (processMember) setOpen(true);
				else if (progressMember) setProgressOpen(true);
			}, [processMember, progressMember, setOpen, setProgressOpen]));`,
	},
	{
		name: "progress chip markup",
		from: `			return (0, react_jsx_runtime.jsx)("div", {
				ref: wrapperRef,
				className: ChatView_module_css_default.flowItem,
				"data-chat-anchor-key": routedNode.key,
				"data-chat-flow-key": routedNode.key,
				"data-chat-flow-kind": routedNode.kind,
				"data-chat-turn": turn,
				"data-turn-process-member": processMember || void 0,
				"data-turn-process-hidden": processHidden || void 0,
				"data-turn-process-answer": compactAnswer || void 0,
				children: renderSlot("conversation.chat.node", routedOwner, {
					entryKey: routedNode.kind,
					hookContext: turnData,
					fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
						label: t("message.unknownSurface", { type: routedNode.kind }),
						payload: routedNode.data,
						truncatedLabel: (total) => t("json.truncated", { total })
					})
				})
			});`,
		to: `			const slot = renderSlot("conversation.chat.node", routedOwner, {
				entryKey: routedNode.kind,
				hookContext: turnData,
				fallback: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.JsonBlock, {
					label: t("message.unknownSurface", { type: routedNode.kind }),
					payload: routedNode.data,
					truncatedLabel: (total) => t("json.truncated", { total })
				})
			});
			const progressChipNode = progressChip ? (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: TurnProcessNodeView_module_css_default.root,
				"data-turn-process": turn,
				"data-turn-process-progress": "",
				"data-turn-process-steps": progressStep - 1,
				"data-turn-process-open": !progressFolded || void 0,
				"aria-expanded": !progressFolded,
				onClick: (event) => {
					event.currentTarget.focus();
					setProgressOpen(progressFolded);
				},
				children: [(0, react_jsx_runtime.jsx)("span", {
					className: TurnProcessNodeView_module_css_default.label,
					children: (progressFolded ? t(progressStep - 1 === 1 ? "message.turnProcess.foldedSteps.one" : "message.turnProcess.foldedSteps.other", { count: progressStep - 1 }) + t("message.turnProcess.separator") : "") + t(progressFolded ? "message.turnProcess.expand" : "message.turnProcess.collapse")
				}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, {
					className: TurnProcessNodeView_module_css_default.chevron
				})]
			}) : null;
			return (0, react_jsx_runtime.jsx)("div", {
				ref: wrapperRef,
				className: ChatView_module_css_default.flowItem,
				"data-chat-anchor-key": routedNode.key,
				"data-chat-flow-key": routedNode.key,
				"data-chat-flow-kind": routedNode.kind,
				"data-chat-turn": turn,
				"data-chat-turn-step": processStepOfNode(routedNode),
				"data-turn-process-member": processMember || progressMember || void 0,
				"data-turn-process-hidden": processHidden || void 0,
				"data-turn-process-answer": compactAnswer || void 0,
				children: progressChipNode === null ? slot : [progressChipNode, slot]
			});`,
	},
	{
		name: "progress chip styling",
		from: `@media (prefers-reduced-motion:reduce){.l_V-RG_chevron{transition:none}}";`,
		to: `.l_V-RG_root[data-turn-process-progress]{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);width:fit-content;max-width:100%;height:auto;border-radius:16px;align-items:center;padding:1px 10px}.l_V-RG_root[data-turn-process-progress]:not([data-open]){margin-bottom:8px}.l_V-RG_root[data-turn-process-progress] .l_V-RG_label{color:var(--dsw-alias-label-tertiary)}.l_V-RG_root[data-turn-process-progress] .l_V-RG_chevron{margin-left:4px}@media (prefers-reduced-motion:reduce){.l_V-RG_chevron{transition:none}}";`,
	},
	{
		name: "locale keys (zh)",
		from: `			"message.turnProcess.thoughtForAWhile": "已思考",
			"message.turnProcess.separator": " · ",
			"message.stopped": "已停止",`,
		to: `			"message.turnProcess.thoughtForAWhile": "已思考",
			"message.turnProcess.separator": " · ",
			"message.turnProcess.working": "正在执行…",
			"message.turnProcess.expand": "点击展开",
			"message.turnProcess.collapse": "点击收起",
			"message.turnProcess.foldedSteps.one": "已收起 {count} 个步骤",
			"message.turnProcess.foldedSteps.other": "已收起 {count} 个步骤",
			"message.stopped": "已停止",`,
	},
	{
		name: "locale keys (en)",
		from: `			"message.turnProcess.thoughtForAWhile": "Thought for a while",
			"message.turnProcess.separator": " · ",
			"message.stopped": "Stopped",`,
		to: `			"message.turnProcess.thoughtForAWhile": "Thought for a while",
			"message.turnProcess.separator": " · ",
			"message.turnProcess.working": "Working…",
			"message.turnProcess.expand": "Click to expand",
			"message.turnProcess.collapse": "Click to collapse",
			"message.turnProcess.foldedSteps.one": "{count} step folded",
			"message.turnProcess.foldedSteps.other": "{count} steps folded",
			"message.stopped": "Stopped",`,
	},
];

/**
 * Apply one anchored replacement exactly once.
 * @param {string} text - current bundle source.
 * @param {{name: string, from: string, to: string}} patch - patch entry.
 * @returns {string} the patched source.
 */
function apply(text, patch) {
	const first = text.indexOf(patch.from);
	if (first < 0) throw new Error(`patch anchor missing: ${patch.name}`);
	if (text.indexOf(patch.from, first + 1) >= 0) throw new Error(`patch anchor is ambiguous: ${patch.name}`);
	return `${text.slice(0, first)}${patch.to}${text.slice(first + patch.from.length)}`;
}

/**
 * Locate a pristine (unpatched) bundle.
 * @returns {string} absolute path of the source bundle.
 */
function findPristine() {
	if (explicit !== undefined) {
		const path = resolve(process.cwd(), explicit);
		if (!existsSync(path)) throw new Error(`--from bundle not found: ${path}`);
		return path;
	}
	const vendored = join(root, "scripts", "vendor", "dsh-client-ui-chat-0.1.5-rc.2.client.js");
	if (existsSync(vendored)) return vendored;
	const releaseDir = join(root, "release");
	const candidates = readdirSync(releaseDir)
		.filter((name) => name.startsWith("manual-"))
		.sort()
		.reverse()
		.map((name) => join(releaseDir, name, "HeRoes NEVERDIE.app/Contents/Resources/app", RELATIVE))
		.filter((path) => existsSync(path));
	for (const path of candidates) {
		const text = readFileSync(path, "utf8");
		if (text.includes("function storedTurnProcessEntry(state, turn) {") && !text.includes("progressMember")) return path;
	}
	throw new Error("no pristine client bundle found; pass --from <path/to/client.js>");
}

const pristine = findPristine();
const pristineText = readFileSync(pristine, "utf8");
let patched = pristineText;
for (const patch of patches) patched = apply(patched, patch);

const expectedMarkers = ["storedTurnProcessProgressOpen", "progressMember", "data-turn-process-progress", "message.turnProcess.foldedSteps"];
for (const marker of expectedMarkers) {
	if (!patched.includes(marker)) throw new Error(`patched output lacks ${marker}`);
}
if (patched.length <= pristineText.length) throw new Error("patched output did not grow the bundle");

const destinations = [];
const workspace = join(root, RELATIVE);
if (existsSync(workspace)) destinations.push(workspace);
const releaseDir = join(root, "release");
for (const name of existsSync(releaseDir) ? readdirSync(releaseDir) : []) {
	if (!name.startsWith("manual-")) continue;
	// One release directory may hold differently named bundles; patch every .app.
	for (const bundle of readdirSync(join(releaseDir, name)).filter((entry) => entry.endsWith(".app"))) {
		const path = join(releaseDir, name, bundle, "Contents/Resources/app", RELATIVE);
		if (existsSync(path)) destinations.push(path);
	}
}

const summary = destinations.map((path) => {
	const already = readFileSync(path, "utf8") === patched;
	if (!checkOnly && !already) writeFileSync(path, patched);
	return { path: path.replace(`${root}/`, ""), bytes: statSync(path).size, already };
});

for (const entry of summary) {
	console.log(`${entry.already ? "already patched" : checkOnly ? "would patch   " : "patched       "} ${entry.bytes}  ${entry.path}`);
}
if (checkOnly) {
	const stale = summary.filter((entry) => !entry.already);
	if (stale.length > 0) process.exit(1);
}
console.log(`process-fold patch OK (source: ${pristine.replace(`${root}/`, "")})`);
