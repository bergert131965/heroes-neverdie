/**
 * Selftest for the completed-Turn process drawer patched into
 * `@deepseek-ai/dsh-client-ui-chat`.
 *
 * The shipped bundle is a module-factory registration whose projection helpers
 * are module-private, so this harness extracts the *patched regions* out of the
 * real bundle source, evaluates them in a sandbox with stubbed dependencies,
 * and drives the real `ChatNodeSeat` decision path with fake Session nodes.
 * It tests the patched source itself — if the bundle stops matching the
 * extraction markers, the harness fails loudly instead of testing a copy.
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     scripts/chat-process-fold-selftest.mjs [path/to/client.js]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle =
	process.argv[2] === undefined
		? join(here, "..", "node_modules", "@deepseek-ai", "dsh-client-ui-chat", "lib", "client.js")
		: resolve(process.cwd(), process.argv[2]);
const source = readFileSync(bundle, "utf8");

const results = [];

/**
 * Record one expectation.
 * @param {string} name - assertion label.
 * @param {unknown} actual - observed value.
 * @param {unknown} expected - required value.
 */
function check(name, actual, expected) {
	results.push({ name, ok: Object.is(actual, expected), actual, expected });
}

/**
 * Extract one function declaration by its opening marker, ending at the brace
 * that closes the function body.
 * @param {string} start - literal opening marker.
 * @param {string} label - region label for error messages.
 * @param {number} offset - search start offset.
 * @returns {{ source: string, end: number }} the declaration and its end offset.
 */
function declarationAt(start, label, offset = 0) {
	const from = source.indexOf(start, offset);
	if (from < 0) throw new Error(`extraction failed: ${label} (marker absent)`);
	const body = /\)\s*\{/.exec(source.slice(from));
	if (body === null) throw new Error(`extraction failed: ${label} (body absent)`);
	const open = from + body.index + body[0].length - 1;
	let depth = 0;
	for (let index = open; index < source.length; index += 1) {
		const character = source[index];
		if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0) return { source: source.slice(from, index + 1), end: index + 1 };
		}
	}
	throw new Error(`extraction failed: ${label} (unbalanced body)`);
}

/**
 * Extract contiguous declarations by their opening markers.
 * @param {string[]} starts - accepted opening markers, in source order.
 * @param {string} label - region label for error messages.
 * @returns {string} the extracted source.
 */
function declarations(starts, label) {
	const parts = [];
	let offset = 0;
	for (const start of starts) {
		const found = declarationAt(start, label, offset);
		parts.push(found.source);
		offset = found.end;
	}
	return parts.join("\n");
}

/**
 * Extract one source region between two literal markers.
 * @param {string} start - literal opening marker.
 * @param {string} end - literal closing marker searched after `start`.
 * @param {string} label - region label for error messages.
 * @returns {string} the extracted source.
 */
function region(start, end, label) {
	const from = source.indexOf(start);
	if (from < 0) throw new Error(`extraction failed: ${label} (start marker absent)`);
	const to = source.indexOf(end, from);
	if (to < 0) throw new Error(`extraction failed: ${label} (end marker absent)`);
	return source.slice(from, to + end.length);
}

const storeRegion = declarations(
	["function storedTurnProcessEntry(state, turn)", "function storedTurnProcessProgressOpen(state, turn)"],
	"chat store helpers",
);
const hiddenRegion = declarations(["function useSearchableHidden(hidden, reveal)"], "searchable hidden");
const seatRegion = region(
	"function turnDataOf(node)",
	"//#endregion\n\t\t//#region \\0dsh-css:/home/runner/work/deepseek-harness/deepseek-harness/packages/client/ui-chat/src/client/chat/TurnNavigator",
	"ChatNodeSeat",
);
const specRegion = region(
	"function isFinalAssistant(data)",
	"/** Turn-scoped process range and answer-boundary Definition. */",
	"turn process projection",
);

/* ------------------------------------------------------------------ *
 * Minimal hook runtime: memo/useMemo/useCallback/useRef/layout effects.
 * ------------------------------------------------------------------ */

const React = {
	memo: (component) => component,
	useMemo: (factory) => factory(),
	useCallback: (fn) => fn,
	/**
	 * Every ref here is the seat's stable subtree root, so the ref is a DOM-ish
	 * node recording attributes and the `hidden` property.
	 * @returns {{ current: Record<string, unknown> }} one ref handle.
	 */
	useRef: () => {
		const handle = {
			hidden: false,
			ownerDocument: { activeElement: null },
			setAttribute(name, value) {
				handle[name] = value;
			},
			removeAttribute(name) {
				delete handle[name];
			},
			contains() {
				return false;
			},
			addEventListener() {},
			removeEventListener() {},
		};
		return { current: handle };
	},
	useLayoutEffect: (effect) => {
		effect();
	},
	useEffect: () => {},
};
const jsxRuntime = {
	jsx: (type, props) => ({ type, props }),
	jsxs: (type, props) => ({ type, props }),
};

const regions = [storeRegion, hiddenRegion, seatRegion, specRegion].join("\n\n");

/*
 * The extracted regions reach helpers that live elsewhere in the bundle. Each
 * stub is added only when the regions do not declare it themselves, so a bundle
 * that starts shipping one cannot silently shadow the stub nor fail as a
 * duplicate declaration.
 */
const stubCandidates = [
	["react", "const react = React;"],
	["react_jsx_runtime", "const react_jsx_runtime = JSX;"],
	["_deepseek_ai_dsh_client_store", "const _deepseek_ai_dsh_client_store = { defineStore: undefined };"],
	[
		"hasAssistantReplyContent",
		"function hasAssistantReplyContent(blocks) { return blocks.some((block) => block.kind !== 'tool-call'); }",
	],
	["fallbackState", "function fallbackState() { return undefined; }"],
	["turnLocation$1", "function turnLocation$1() { return undefined; }"],
	[
		"TURN_PROCESS_INDEPENDENT_KINDS",
		"const TURN_PROCESS_INDEPENDENT_KINDS = new Set(['system-prompt', 'user', 'steering', 'turn-process', 'turn-error', 'turn-max-tokens', 'turn-tail']);",
	],
	["_deepseek_ai_dsh_client_ui_primitives", "const _deepseek_ai_dsh_client_ui_primitives = { JsonBlock: null };"],
	["ChatView_module_css_default", "const ChatView_module_css_default = { flowItem: 'flowItem' };"],
	[
		"TurnProcessNodeView_module_css_default",
		"const TurnProcessNodeView_module_css_default = { root: 'processRoot', label: 'processLabel', chevron: 'processChevron' };",
	],
];
const declared = new Set(
	[...regions.matchAll(/^[\t ]*(?:function|const|let|var)[\t ]+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]),
);
const stubs = stubCandidates.filter(([name]) => !declared.has(name)).map(([, text]) => text);

const helperNames = ["processStepOf", "processStepOfNode", "turnWithCompletion", "isFinalAnswerRow", "answerStepOf"];
const body = [
	...stubs,
	regions,
	`return { ChatNodeSeat, processSpec, ${helperNames.join(", ")} };`,
	"//# sourceURL=chat-process-fold.sandbox.js",
].join("\n\n");

let sandbox;
try {
	sandbox = new Function("React", "JSX", body)(React, jsxRuntime);
} catch (error) {
	const at = Number(/sandbox\.js:(\d+)/.exec(String(error.stack ?? ""))?.[1] ?? 0);
	const lines = body.split("\n");
	const context = lines.slice(Math.max(0, at - 6), at + 3).map((line, index) => `${at - 5 + index}: ${line}`);
	throw new Error(`patched sandbox failed: ${error.message}\n${context.join("\n")}`);
}
const { ChatNodeSeat, processSpec, processStepOf, processStepOfNode, turnWithCompletion, isFinalAnswerRow, answerStepOf } = sandbox;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * Build one Turn fixture.
 * @param {"running"|"closed"} status - Turn status.
 * @param {("open"|"closed")[]} stepStatuses - per-Step status, oldest first.
 * @param {number} [endSeq] - durable Turn-end sequence, when the Turn ended.
 * @returns {Record<string, unknown>} the Turn fixture.
 */
function makeTurn(status, stepStatuses, endSeq) {
	return {
		turn: 7,
		status,
		start: { seq: 10 },
		...(endSeq === undefined ? {} : { end: { seq: endSeq } }),
		steps: stepStatuses.map((stepStatus, index) => ({
			step: index + 1,
			status: stepStatus,
			turn: 7,
			data: new Map([["assistant-step", { step: index + 1, blocks: [] }]]),
		})),
		data: new Map(),
	};
}

/**
 * Build one fake Chat node.
 * @param {Record<string, unknown>} turn - owning Turn fixture.
 * @param {string} kind - Chat node kind.
 * @param {number} stepNumber - owning Step number.
 * @param {number} anchorSeq - projection anchor.
 * @param {Record<string, unknown>} data - node payload.
 * @returns {Record<string, unknown>} the fake node.
 */
function makeNode(turn, kind, stepNumber, anchorSeq, data = {}) {
	const step = turn.steps.find((candidate) => candidate.step === stepNumber) ?? turn.steps[0];
	return {
		key: `${kind}:${anchorSeq}`,
		kind,
		anchorSeq,
		visibility: "visible",
		location: { kind: "step", step, turn },
		data: { step: stepNumber, ...data },
	};
}

/**
 * Render one node through the real seat and report what it produced.
 * @param {Record<string, unknown>} node - fake Chat node.
 * @param {Record<string, unknown>} presentation - Turn process presentation.
 * @param {Record<string, unknown>} store - Chat store snapshot.
 * @param {boolean} historyIncomplete - whether older history is still unloaded.
 * @param {boolean} compactTranscript - whether the compact display is active.
 * @returns {{ hidden: boolean, rows: unknown[] }} visibility plus wrapper children.
 */
function render(node, presentation, store = { turnProcesses: [] }, historyIncomplete = true, compactTranscript = true) {
	const element = ChatNodeSeat({
		nodeKey: node.key,
		useChatNode: () => node,
		useChatNodeProcess: () => presentation,
		historyIncomplete,
		compactTranscript,
		cwd: "/workspace",
		openFile: () => {},
		inspectCall: () => {},
		forkAt: () => {},
		loadImage: () => {},
		renderMessageImages: () => {},
		fileMentions: () => {},
		useStore: (selector) => selector(store ?? { turnProcesses: [] }),
		actions: { setTurnProcessOpen: () => {} },
		renderSlot: () => "slot",
		t: (key) => key,
	});
	const children = element.props.children;
	const rows = Array.isArray(children) ? children : [children];
	return { hidden: element.props.ref.current.hidden === "until-found", rows };
}

/**
 * Report only the hidden state of one rendered node.
 * @param {Record<string, unknown>} node - fake Chat node.
 * @param {Record<string, unknown>} presentation - Turn process presentation.
 * @param {Record<string, unknown>} store - Chat store snapshot.
 * @param {boolean} historyIncomplete - whether older history is still unloaded.
 * @param {boolean} compactTranscript - whether the compact display is active.
 * @returns {boolean} whether the seat hid the row.
 */
function renderHidden(node, presentation, store, historyIncomplete, compactTranscript) {
	return render(node, presentation, store, historyIncomplete, compactTranscript).hidden;
}

/**
 * Report whether one rendered node carries the drawer chip.
 * @param {Record<string, unknown>} node - fake Chat node.
 * @param {Record<string, unknown>} presentation - Turn process presentation.
 * @param {Record<string, unknown>} store - Chat store snapshot.
 * @returns {boolean} whether the chip renders with the row.
 */
function renderChip(node, presentation, store) {
	return render(node, presentation, store).rows.some((row) => row?.props?.["data-turn-process-progress"] === "");
}

/**
 * Read the drawer chip's toggle state marker.
 * @param {Record<string, unknown>} node - fake Chat node.
 * @param {Record<string, unknown>} presentation - Turn process presentation.
 * @param {Record<string, unknown>} store - Chat store snapshot.
 * @returns {boolean} whether the chip renders in its expanded (collapse) state.
 */
function renderChipOpen(node, presentation, store) {
	const row = render(node, presentation, store).rows.find((entry) => entry?.props?.["data-turn-process-progress"] === "");
	return row?.props?.["data-turn-process-open"] === true;
}


/* Running Turn: everything stays exactly as shipped. */
const openTurn = makeTurn("running", ["closed", "open"]);
const settledReasoning = makeNode(openTurn, "assistant-step", 1, 12, { status: "settled" });
const settledCall = makeNode(openTurn, "tool-call", 1, 14, {});
const runningReasoning = makeNode(openTurn, "assistant-step", 2, 30, { status: "running" });
const userRow = makeNode(openTurn, "user", 1, 5, { text: "hi" });

check("running Turn keeps settled reasoning visible", renderHidden(settledReasoning, undefined), false);
check("running Turn keeps settled tool rows visible", renderHidden(settledCall, undefined), false);
check("running Turn keeps the newest Step visible", renderHidden(runningReasoning, undefined), false);
check("running Turn shows no drawer chip", renderChip(settledReasoning, undefined), false);
check("user row is never a process row", renderHidden(userRow, undefined), false);

/* Finished Turn: the whole process run folds behind one chip. */
const doneTurn = makeTurn("closed", ["closed", "closed"], 60);
const doneReasoning = makeNode(doneTurn, "assistant-step", 1, 12, { status: "settled" });
const doneCall = makeNode(doneTurn, "tool-call", 1, 14, {});
const doneTailCall = makeNode(doneTurn, "tool-call", 1, 52, {});
const doneAnswer = makeNode(doneTurn, "assistant-step", 2, 60, {
	status: "settled",
	finalNode: { seq: 60, step: 2, blocks: [{ kind: "text", text: "Done." }] },
});
const answerWithoutText = makeNode(doneTurn, "assistant-step", 2, 61, {
	status: "settled",
	finalNode: { seq: 61, step: 2, blocks: [{ kind: "reasoning", text: "thinking" }] },
});

check("finished Turn folds earlier Step reasoning", renderHidden(doneReasoning, undefined), true);
check("finished Turn folds earlier Step tools", renderHidden(doneCall, undefined), true);
check("finished Turn folds its own last tool row", renderHidden(doneTailCall, undefined), true);
check("finished Turn keeps the final answer visible", renderHidden(doneAnswer, undefined), false);
check("the final answer carries the drawer chip", renderChip(doneAnswer, undefined), true);
check("process rows carry no chip", renderChip(doneReasoning, undefined), false);
check("a tool-only closing Step is not an answer", renderChip(answerWithoutText, undefined), false);

/* The drawer honours the existing per-Turn manual disclosure. */
const expandedStore = { turnProcesses: [{ turn: 7, answerStep: -1 }] };
check("manual expand reveals the folded rows", renderHidden(doneCall, undefined, expandedStore), false);
check("manual expand keeps a chip to collapse with", renderChip(doneAnswer, undefined, expandedStore), true);
check("expanded chip reports the collapse state", renderChipOpen(doneAnswer, undefined, expandedStore), true);
check("folded chip reports the collapsed state", renderChipOpen(doneAnswer, undefined), false);

/*
 * Measured in the running app: a closed Turn can reach the window with Step
 * records that carry no step number at all. The drawer must still fold, using
 * the final answer Step and the Turn-end boundary as the fallback.
 */
const bareTurn = makeTurn("closed", ["closed", "closed"], 60);
for (const step of bareTurn.steps) delete step.step;
const bareCall = makeNode(bareTurn, "tool-call", 1, 14, {});
const bareTailCall = makeNode(bareTurn, "tool-call", 2, 50, {});
const bareAnswer = makeNode(bareTurn, "assistant-step", 2, 62, {
	status: "settled",
	finalNode: { seq: 62, step: 2, blocks: [{ kind: "text", text: "Done." }] },
});
check("no Step numbers: earlier process rows still fold", renderHidden(bareCall, undefined), true);
check("no Step numbers: the last process row folds", renderHidden(bareTailCall, undefined), true);
check("no Step numbers: the final answer stays visible", renderHidden(bareAnswer, undefined), false);
check("no Step numbers: the answer still carries the chip", renderChip(bareAnswer, undefined), true);

/* A single-Step finished Turn folds nothing and shows no chip. */

/* A single-Step finished Turn folds nothing and shows no chip. */
const singleStepTurn = makeTurn("closed", ["closed"], 60);

check(
	"single-Step finished Turn shows no chip",
	renderChip(
		makeNode(singleStepTurn, "assistant-step", 1, 60, {
			finalNode: { seq: 60, step: 1, blocks: [{ kind: "text", text: "Done." }] },
		}),
		undefined,
	),
	false,
);

/* Standard display keeps every process row visible. */
check("standard display keeps process rows visible", renderHidden(doneCall, undefined, undefined, true, false), false);

/* Closed Turn with a final answer keeps the shipped turn-level fold intact. */
const closedSpec = {
	turn: 7,
	controlAnchorSeq: 11,
	processStartSeq: 10,
	answerAnchorSeq: 50,
	answerStep: 2,
	inlineReasoning: false,
	messageCount: 3,
	toolCallCount: 4,
	subagentCount: 0,
};
const closedPresentation = { turn: 7, turnClosed: true, spec: closedSpec, hasExternalProcess: true, compactAnswer: true };
const closedControl = makeNode(doneTurn, "turn-process", 1, 11, closedSpec);

check("shipped fold still hides process rows on loaded history", renderHidden(doneCall, closedPresentation, undefined, false), true);
check("shipped disclosure control stays visible", renderHidden(closedControl, closedPresentation, undefined, false), false);
check(
	"shipped disclosure honours its own manual expand",
	renderHidden(doneCall, closedPresentation, { turnProcesses: [{ turn: 7, answerStep: 2 }] }, false),
	false,
);

/* Helper contracts the drawer depends on. */
check("turnWithCompletion ignores a running Turn", turnWithCompletion(settledCall), undefined);
check("turnWithCompletion returns a closed Turn", turnWithCompletion(doneCall)?.turn, 7);
check("answerStepOf reads the projected Step", answerStepOf(doneTurn, doneCall), 2);
check("answerStepOf reports null without any Step source", answerStepOf(bareTurn, bareCall), null);
check("isFinalAnswerRow needs closing text", isFinalAnswerRow(answerWithoutText), false);

/* ------------------------------------------------------------------ */

const failed = results.filter((result) => !result.ok);
for (const result of failed) {
	console.error(`  FAIL ${result.name}: expected ${JSON.stringify(result.expected)}, observed ${JSON.stringify(result.actual)}`);
}
if (failed.length > 0) {
	console.error(`chat-process-fold selftest FAILED (${failed.length} of ${results.length})`);
	process.exit(1);
}
console.log(`chat-process-fold selftest OK (${results.length} assertions)`);
