/**
 * Standalone harness for the usage-panel browser half.
 *
 * The bundle is a module-factory registration, so this test supplies the loader
 * facade, React, the UI primitives, and the seed modules the bundle requires,
 * then drives the registered component with a minimal hook runtime. The real
 * host half is mounted behind a throwaway loopback HTTP server, so
 * `callHost` exercises the complete route contract — URL building, JSON
 * decoding, and the non-2xx paths — exactly as the desktop page will.
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     profile/plugins/usage-panel/selftest-client.mjs
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { apply as applyHost } from "./client-host.js";

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Minimal React runtime: plain-object elements plus the two hooks the
 * panel uses. Good enough to prove the render path never throws and
 * that the loader contract is satisfied.
 * ------------------------------------------------------------------ */

globalThis.IS_REACT_ACT_ENVIRONMENT = false;
let hookCursor = 0;
const hookStates = [];
const effectQueue = [];
/** Requested re-renders, drained by the test after it settles promises. */
const pendingRenders = [];

function createElement(type, props, ...children) {
	const key = props?.key;
	const element = {
		type,
		key: key === undefined ? null : key,
		props: { ...(props ?? {}) },
	};
	if (children.length === 1) element.props.children = children[0];
	else if (children.length > 1) element.props.children = children;
	return element;
}

const React = {
	Fragment: Symbol.for("react.fragment"),
	createElement,
	useState(initial) {
		const slot = hookCursor++;
		if (hookStates.length <= slot) hookStates[slot] = typeof initial === "function" ? initial() : initial;
		return [
			hookStates[slot],
			(next) => {
				hookStates[slot] = typeof next === "function" ? next(hookStates[slot]) : next;
				pendingRenders.push(true);
			},
		];
	},
	useRef(initial) {
		const slot = hookCursor++;
		if (hookStates.length <= slot) hookStates[slot] = { current: initial };
		return hookStates[slot];
	},
	useCallback(fn, deps) {
		const slot = hookCursor++;
		const previous = hookStates[slot];
		const changed =
			previous === undefined ||
			!Array.isArray(previous.deps) ||
			!Array.isArray(deps) ||
			deps.length !== previous.deps.length ||
			deps.some((value, index) => !Object.is(value, previous.deps[index]));
		// Memoize by slot, exactly as React does. Returning `fn` fresh would hand
		// the component a new identity every render, re-arming any effect that
		// lists it as a dependency and turning the harness into a render loop.
		if (changed) hookStates[slot] = { deps, value: fn };
		return hookStates[slot].value;
	},
	useMemo(fn) {
		hookCursor++;
		return fn();
	},
	useEffect(fn, deps) {
		const slot = hookCursor++;
		const previous = hookStates[slot];
		const changed =
			previous === undefined ||
			!Array.isArray(deps) ||
			!Array.isArray(previous.deps) ||
			deps.length !== previous.deps.length ||
			deps.some((value, index) => !Object.is(value, previous.deps[index]));
		if (!changed) return;
		effectQueue.push({ slot, fn, deps, previous });
	},
	useLayoutEffect(fn, deps) {
		React.useEffect(fn, deps);
	},
};

/** Flush effects for one already-invoked component render. */
function render(tree) {
	effectQueue.length = 0;
	for (const effect of effectQueue) {
		const cleanup = effect.fn();
		if (typeof cleanup === "function") hookStates[effect.slot] = { ...hookStates[effect.slot], cleanup };
	}
	return tree;
}

/** Invoke the component with a fresh hook cursor, then flush its effects. */
function renderComponent(component, props) {
	hookCursor = 0;
	effectQueue.length = 0;
	const tree = component(props);
	for (const effect of effectQueue) {
		const previous = effect.previous;
		if (typeof previous?.cleanup === "function") previous.cleanup();
		const cleanup = effect.fn();
		// Merge rather than replace: the slot's `deps` must survive for the next
		// render's comparison, and any non-effect state it shares must not be lost.
		hookStates[effect.slot] = { ...hookStates[effect.slot], deps: effect.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
	}
	return tree;
}

/** Apply every queued state update, re-rendering until none remain. */
function flush(component, props, passes = 6) {
	let tree = renderComponent(component, props);
	for (let pass = 0; pass < passes && pendingRenders.length > 0; pass += 1) {
		pendingRenders.length = 0;
		tree = renderComponent(component, props);
	}
	return tree;
}

/**
 * Walk every host element in the tree, invoking function components through the
 * hook runtime, to prove the whole painted surface renders without throwing.
 * @returns the number of nodes visited.
 */
function walk(node) {
	if (node === null || node === undefined || typeof node !== "object") return 0;
	if (Array.isArray(node)) return node.reduce((sum, child) => sum + walk(child), 0);
	let visited = 1;
	if (typeof node.type === "function") {
		hookCursor = 0;
		effectQueue.length = 0;
		const rendered = node.type(node.props);
		for (const effect of effectQueue) {
			const cleanup = effect.fn();
			if (typeof cleanup === "function") hookStates[effect.slot] = { ...hookStates[effect.slot], cleanup };
		}
		visited += walk(rendered);
	} else if (node.props !== undefined) {
		visited += walk(node.props.children);
	}
	return visited;
}

/* ------------------------------------------------------------------ *
 * Loader facade + seed modules.
 * ------------------------------------------------------------------ */

let registration;
globalThis.__ModuleLoader__ = {
	mode: "queue",
	pendingQueue: [],
	load(value) {
		registration = value;
	},
};

const slotsInjected = [];

const primitives = {
	Modal: function Modal(props) {
		return props.open === false ? null : React.createElement("div", { "data-modal": props.title }, [props.children, props.footer]);
	},
	Button: function Button(props) {
		return React.createElement("button", { type: "button", disabled: props.disabled }, props.children);
	},
	useDismissOnOutsidePointer() {},
};

const seedModules = {
	react: React,
	"react/jsx-runtime": { jsx: createElement, jsxs: createElement, Fragment: React.Fragment },
	"@deepseek-ai/dsh-client-ui-primitives": primitives,
	"@deepseek-ai/dsh-client-ui-slots": {},
	"@deepseek-ai/dsh-client-connection": {},
};

// The desktop shell installs its IPC carrier on this global and deliberately
// leaves the page's own fetch alone, so the harness installs a carrier too. On
// the Web surface no carrier exists and the same code path resolves to the
// native same-origin fetch instead.
let carrierOrigin = "http://dsh.internal";
globalThis.__DSH_TRANSPORT__ = {
	ownsHost: true,
	fetch(input, init) {
		const url = new URL(input instanceof Request ? input.url : String(input));
		// The carrier owns whatever authority the page assembled; retarget it at
		// the throwaway loopback server standing in for the shell's bridge.
		return globalThis.fetch(`${carrierOrigin}${url.pathname}${url.search}`, input instanceof Request ? input : init);
	},
};

const source = readFileSync(join(here, "client.js"), "utf8");
// The bundle injects its panel CSS into the document at factory time, so the
// harness has to provide the two `document` calls it makes.
const injectedStyles = [];
globalThis.document = {
	querySelector(selector) {
		return injectedStyles.find((style) => selector.includes(style.dataset.pluginCss)) ?? null;
	},
	createElement() {
		const style = { dataset: {}, textContent: "" };
		injectedStyles.push(style);
		return style;
	},
	head: {
		appendChild(node) {
			node.appended = true;
		},
	},
};
// eslint-disable-next-line no-new-func -- the bundle is a script, exactly as the page loads it.
new Function("window", "globalThis", source)(globalThis, globalThis);

console.log("loader registered id:", registration?.id);
const bundle = registration.factory((spec) => {
	if (!(spec in seedModules)) throw new Error(`selftest: unexpected require(${JSON.stringify(spec)})`);
	return seedModules[spec];
});
console.log("bundle exports:", Object.keys(bundle).sort().join(", "));
console.log("client inject:", JSON.stringify(bundle.inject));

const ctx = {
	slots: {
		inject(name, factory) {
			slotsInjected.push(name);
			return factory();
		},
		register(options, component) {
			return { options, component };
		},
	},
};
bundle.apply(ctx);
console.log("slot injected:", JSON.stringify(slotsInjected));

// Capture what register() actually received by re-running the registration.
let captured;
ctx.slots.register = (options, component) => {
	captured = { options, component };
	return captured;
};
bundle.apply(ctx);
console.log("registered options:", JSON.stringify({ ...captured.options, inject: "<fn>" }));
console.log(
	"panel CSS injected:",
	injectedStyles.length,
	"| appended:",
	injectedStyles.every((style) => style.appended === true),
	"| caps content height:",
	injectedStyles.some((style) => style.textContent.includes(".dsh-usage-content") && style.textContent.includes("overflow-y:auto")),
	"| caps dialog:",
	injectedStyles.some((style) => style.textContent.includes(".dsh-usage-modal") && style.textContent.includes("max-height")),
);
// A second apply must not inject the stylesheet twice.
bundle.apply(ctx);
console.log("styles after re-apply (expect 1):", injectedStyles.length);

/* ------------------------------------------------------------------ *
 * Real host half behind a loopback server, so callHost is exercised
 * against the true route contract.
 * ------------------------------------------------------------------ */

const hostCtx = {
	connection: {
		fetch: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
	},
	get(service) {
		if (service !== "credentials") return undefined;
		return {
			resolve: async () =>
				process.env.SELFTEST_API_KEY === undefined ? undefined : { value: process.env.SELFTEST_API_KEY, source: "selftest" },
		};
	},
	logger: { info() {} },
};
const routes = [];
applyHost(hostCtx, {});

const server = createServer((request, response) => {
	const route = routes.find((candidate) => request.url.startsWith(candidate.path));
	if (route === undefined) {
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
		return;
	}
	void route.fetch(new Request(new URL(request.url, "http://127.0.0.1"), { method: request.method })).then(async (result) => {
		response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "application/json" });
		response.end(await result.text());
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${String(server.address().port)}`;
carrierOrigin = origin;
// Mimic the desktop surface: a file:// page whose origin is the literal string
// "file://", which is exactly what forces callHost onto the internal authority
// that the carrier above then retargets.
globalThis.location = { href: "file:///index.html", origin: "file://" };

const loadUsage = async (kind) => {
	if (kind === "balance") return bundle.callHost("/api/usage/balance");
	return bundle.callHost("/api/usage/tokens", "scope=all");
};

console.log("\n=== callHost over the real route contract ===");
const balance = await loadUsage("balance");
console.log("balance ok:", balance.ok, "| value:", balance.infos?.[0]?.totalBalance ?? balance.code);
const tokens = await loadUsage("tokens");
console.log("tokens ok:", tokens.ok, "| sessions:", tokens.sessions, "| total:", tokens.metrics.totalTokens);
console.log("buckets match metrics:", tokens.metrics.totalTokens === Object.values(tokens.buckets).reduce((a, b) => a + b, 0));

/** A 404 route proves the non-2xx branch surfaces the HTTP status. */
try {
	await bundle.callHost("/api/usage/does-not-exist");
	console.log("missing route: NO ERROR (unexpected)");
} catch (error) {
	console.log("missing route error:", error.message);
}

/* ------------------------------------------------------------------ *
 * Render the registered component with the live loader.
 * ------------------------------------------------------------------ */

console.log("\n=== component render ===");
const tree = flush(captured.component, { wide: true, loadUsage });
console.log("root is a fragment element:", typeof tree.type === "symbol");
const modal = tree.props.children[1];
console.log("modal open initially:", modal.props.open);
const button = tree.props.children[0].props.children;
console.log("footer button present:", button.type === "button", "| title:", button.props.title);

// Open the panel, let the effect's fetch settle, then pump until stable. Each
// refresh resolves in two ticks (loading, then ready), so the harness drains a
// few times with a yield between passes.
button.props.onClick();
flush(captured.component, { wide: true, loadUsage });
let painted;
for (let round = 0; round < 6; round += 1) {
	await new Promise((resolve) => setTimeout(resolve, 60));
	painted = flush(captured.component, { wide: true, loadUsage });
}
const paintedModal = painted.props.children[1];
const sections = paintedModal.props.children.props.children;
console.log("modal open after click:", paintedModal.props.open);
console.log(
	"modal sizing props:",
	JSON.stringify({ className: paintedModal.props.className, contentClassName: paintedModal.props.contentClassName }),
);
console.log("painted sections:", Array.isArray(sections) ? sections.length : 1);
console.log("nodes walked without throwing:", walk(painted));
const state = hookStates.filter((slot) => slot !== undefined && typeof slot === "object" && "phase" in slot);
console.log("panel state phase:", state.map((slot) => slot.phase).join(","));
console.log(
	"panel state detail:",
	JSON.stringify(
		state.map((slot) => ({
			phase: slot.phase,
			balanceBalance: slot.balance?.infos?.[0]?.totalBalance ?? slot.balance?.code ?? null,
			tokenTotal: slot.tokens?.metrics?.totalTokens ?? null,
			error: slot.error ?? null,
		})),
	),
);

server.close();
// The opened panel keeps its 20s poll interval alive by design, so end the
// process explicitly rather than waiting for an empty event loop.
console.log("\nselftest-client: done");
process.exit(0);

