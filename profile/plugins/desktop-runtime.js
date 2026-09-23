/**
 * The Electron desktop surface glue, mirroring the browser-surface parts of
 * `@deepseek-ai/dsh-web-app` (whose `web-runtime` row this profile disables):
 *
 * - provides the `webRuntime` service the `connection` row injects, so that
 *   row and the whole browser roster stay byte-for-byte unchanged;
 * - registers the desktop-surface prompt section plus the `DSH_DESKTOP`
 *   shell variable;
 * - provides `desktopShell`, the shell-owned carrier API the Electron main
 *   process calls: it renders the file:// index (boot injections from
 *   dsh-client-modules, markup rendering from dsh-host-webserver), dispatches
 *   fetch requests to the client-modules bundle route or the Connection
 *   shared Fetch handler, and opens Remote logical streams through the
 *   Gateway's carrier-neutral wireStream adapter.
 * @module dsh-desktop-profile/plugins/desktop-runtime
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { addHarnessSourceSection } from "@deepseek-ai/dsh-app-boot";
import { bootInjections } from "@deepseek-ai/dsh-client-modules";
import { renderIndexInjections } from "@deepseek-ai/dsh-host-webserver";

/** Stable Cordis plugin name. */
const name = "desktop-runtime";
/** Runtime service that satisfies the connection row's webRuntime injection. */
const WEB_RUNTIME_SERVICE = "webRuntime";
/** Shell-facing service the Electron main process consumes. */
const DESKTOP_SHELL_SERVICE = "desktopShell";
/** Environment variable marking shell commands with the desktop surface. */
const DSH_DESKTOP = "DSH_DESKTOP";
/** Host authority of the dsh:// protocol the shell registers for plugin bundles. */
const PLUGIN_HOST = "harness";
const PLUGIN_PREFIX = "/plugins/";
const PLUGIN_URL_PREFIX = `dsh://${PLUGIN_HOST}${PLUGIN_PREFIX}`;
/** Product name for the window title, before the SPA takes over `document.title`. */
const PRODUCT_TITLE = "HeRoes NEVERDIE";

/**
 * Model-visible orientation for sessions created through the desktop app.
 * Mirrors the Web surface text with the Electron facts: file:// UI, IPC
 * bridge, and no implicit DOM context.
 */
function desktopSurfacePrompt() {
  return `You are interacting with the user through the HeRoes NEVERDIE desktop application (an Electron app on the user's machine, built on DeepSeek Harness). The UI is the same Web frontend as "dsh web", loaded over file:// and talking to the in-process host through an Electron IPC bridge, so there is no HTTP server and no URL to open. When the user refers to "this page", "this GUI", "this app", or "this window" without naming another target, they mean this desktop window. The browser provides no implicit DOM, route, or screenshot context. Client-plugin hot reload is not wired in the desktop build; every frontend change requires rebuilding and restarting the app.`;
}

/** Resolve the built frontend dist, exactly like the web bundle's glue plugin. */
function resolveDistIndex() {
  const require = createRequire(import.meta.url);
  try {
    return join(dirname(require.resolve("@deepseek-ai/dsh-web-frontend/package.json")), "dist", "index.html");
  } catch {
    throw new Error("desktop-runtime: @deepseek-ai/dsh-web-frontend is not resolvable from this composition");
  }
}

/**
 * The page preamble installing the shell-owned transport before the
 * bootstrap batches run. It implements the fetch and logical-stream carriers
 * in the page realm (where Response/ReadableStream exist) over the narrow
 * invoke/send/on primitives the preload exposes:
 *
 * - `__DSH_TRANSPORT__ = { ownsHost: true, fetch, openStream }` is the
 *   official shell-owned carrier seam `dsh-client-connection` reads before
 *   Cordis boots;
 * - `__DSH_FILE_UPLOAD__ = { fetch }` is the official page hook
 *   `dsh-client-file-upload` reads once, so Blob and ReadableStream uploads
 *   stream through the same bridge.
 */
const TRANSPORT_SCRIPT = `(() => {
  const bridge = globalThis.__DSH_DESKTOP__;
  if (bridge === undefined || typeof bridge.invoke !== "function") {
    throw new Error("dsh-desktop: preload bridge is missing");
  }
  const bytesToBase64 = (bytes) => {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  };
  const base64ToBytes = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  // Normalize a chunk value after it crossed the contextBridge: the preload
  // forwards whatever structured clone produced (typed array, plain object,
  // or base64 string) without assuming a shape.
  const bytesOf = (value) => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === "string") return base64ToBytes(value);
    if (value !== null && typeof value === "object" && typeof value.byteLength === "number") {
      const out = new Uint8Array(value.byteLength);
      for (let i = 0; i < out.length; i++) out[i] = value[i] ?? 0;
      return out;
    }
    throw new Error("dsh-desktop: unhandled bridge chunk shape");
  };
  async function readBodyBytes(body) {
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return new Uint8Array(await body.arrayBuffer());
  }
  async function bridgeFetch(input, init) {
    const requestId = crypto.randomUUID();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = {};
    if (init?.headers !== undefined && init.headers !== null) {
      new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    }
    const sourceBody = init?.body;
    const bodyIsStream = sourceBody instanceof ReadableStream;
    const body = bodyIsStream ? undefined : sourceBody == null ? undefined : bytesToBase64(await readBodyBytes(sourceBody));
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : String(input.url);
    const entry = { head: null, chunks: [], waiters: [], ended: false, error: null };
    const dbg = globalThis.__DSH_DESKTOP_TRACE__ ? (...parts) => console.error("[bridgeFetch]", requestId, ...parts) : () => {};
    const off = bridge.on("dsh-bridge:fetch-event", (msg) => {
      if (msg === undefined || msg.requestId !== requestId) return;
      dbg("event", msg.kind);
      if (msg.kind === "head") entry.head = { status: msg.status, headers: msg.headers };
      else if (msg.kind === "chunk") entry.chunks.push(msg.bytes);
      else if (msg.kind === "end") entry.ended = true;
      else if (msg.kind === "error") entry.error = msg.message;
      for (const waiter of entry.waiters.splice(0)) waiter();
    });
    const abort = init?.signal;
    const onAbort = () => void bridge.send("dsh-bridge:fetch-abort", { requestId });
    abort?.addEventListener("abort", onAbort, { once: true });
    try {
      await bridge.invoke("dsh-bridge:fetch", { requestId, url, method, headers, bodyIsStream, body });
      dbg("invoke ack");
      if (bodyIsStream) {
        const reader = sourceBody.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bridge.send("dsh-bridge:fetch-body", { requestId, kind: "chunk", bytes: bytesToBase64(value) });
          }
        } catch (error) {
          bridge.send("dsh-bridge:fetch-body", { requestId, kind: "error", message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
        bridge.send("dsh-bridge:fetch-body", { requestId, kind: "end" });
      }
      const head = await new Promise((resolve, reject) => {
        const poll = () => {
          if (entry.head !== null) { dbg("head resolved", entry.head.status); return resolve(entry.head); }
          if (entry.error !== null) return reject(new Error(entry.error));
          if (abort?.aborted === true) return reject(new DOMException("aborted", "AbortError"));
          entry.waiters.push(poll);
        };
        poll();
      });
      // Buffered completion: collect every chunk until the end/error event,
      // then materialize one byte body. Simple, race-free across the
      // contextBridge/IPC event delivery, and equivalent for the small JSON
      // responses this carrier normally moves; large downloads are the only
      // memory-bound case (documented).
      const done = await new Promise((resolve, reject) => {
        const poll = () => {
          if (entry.ended) return resolve(true);
          if (entry.error !== null) return reject(new Error(entry.error));
          if (abort?.aborted === true) return reject(new DOMException("aborted", "AbortError"));
          entry.waiters.push(poll);
        };
        poll();
      });
      if (!done) return new Response(null, { status: head.status, headers: head.headers });
      const parts = entry.chunks.map((chunk) => bytesOf(chunk));
      let size = 0;
      for (const part of parts) size += part.byteLength;
      const bodyBytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bodyBytes.set(part, offset);
        offset += part.byteLength;
      }
      off();
      dbg("response materialized", size, "bytes");
      return new Response(bodyBytes.buffer, { status: head.status, headers: head.headers });
    } finally {
      abort?.removeEventListener("abort", onAbort);
      off();
    }
  }
  function bridgeOpenStream(endpoint, payload, signal) {
    return {
      async *[Symbol.asyncIterator]() {
        const streamId = await bridge.invoke("dsh-bridge:stream-open", { endpoint, payload });
        const queue = [];
        const waiters = [];
        let finished = false;
        const off = bridge.on("dsh-bridge:stream-event", (msg) => {
          if (msg === undefined || msg.streamId !== streamId) return;
          queue.push(msg);
          for (const waiter of waiters.splice(0)) waiter();
        });
        const cancel = () => void bridge.send("dsh-bridge:stream-cancel", { streamId });
        const onAbort = () => cancel();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          for (;;) {
            const msg = await new Promise((resolve) => {
              if (queue.length > 0) return resolve(queue.shift());
              if (finished) return resolve({ kind: "end" });
              if (signal?.aborted === true) return resolve({ kind: "aborted" });
              waiters.push(() => {
                if (queue.length > 0) resolve(queue.shift());
                else if (finished) resolve({ kind: "end" });
                else if (signal?.aborted === true) resolve({ kind: "aborted" });
              });
            });
            if (msg.kind === "item") yield msg.value;
            else if (msg.kind === "end" || msg.kind === "aborted") return;
            else if (msg.kind === "error") {
              const error = new Error(msg.error?.message ?? "remote stream failed");
              error.dshRemoteStreamFailure = { kind: "remote", code: msg.error?.code, details: msg.error?.details ?? {} };
              throw error;
            }
          }
        } finally {
          finished = true;
          signal?.removeEventListener("abort", onAbort);
          off();
          cancel();
        }
      }
    };
  }
  globalThis.__DSH_TRANSPORT__ = { ownsHost: true, fetch: bridgeFetch, openStream: bridgeOpenStream };
  globalThis.__DSH_FILE_UPLOAD__ = { fetch: bridgeFetch };
})();`;

/** Diagnostic: log page-initiated window.close (the desktop shell owns the window). */
const CLOSE_GUARD = `(() => {
  const original = window.close;
  window.close = function (...args) {
    console.error("dsh-desktop: page called window.close()", new Error().stack);
    return Reflect.apply(original, window, args);
  };
})();`;

/** Row that injects the transport preamble ahead of the boot injections. */
function transportRow() {
  return { kind: "script", placement: "head", text: TRANSPORT_SCRIPT };
}

/**
 * Mount the Desktop runtime: webRuntime, surface context, and the
 * shell-owned carrier.
 * @param ctx - plugin context carrying the settled host services.
 */
function apply(ctx) {
  ctx.provide(WEB_RUNTIME_SERVICE, { lanAddresses: [], trustedHosts: [] });
  ctx.provide("desktopRuntime", {});

  ctx.inject(["systemPrompt"], (promptCtx) => {
    const sourceRoot = process.env.DSH_SOURCE_ROOT;
    if (sourceRoot !== undefined && sourceRoot !== "") addHarnessSourceSection(promptCtx, sourceRoot);
    promptCtx.systemPrompt.section({
      name: "app:desktop-surface",
      order: promptCtx.systemPrompt.getSectionOrder("WEB_SURFACE"),
      text: () => desktopSurfacePrompt(),
    });
  });
  ctx.inject(["shellEnv"], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: "desktop-runtime",
      variables: { [DSH_DESKTOP]: { description: "Set to 1 while a shell command runs inside the HeRoes NEVERDIE desktop application." } },
      resolve: () => ({ [DSH_DESKTOP]: "1" }),
    });
  });

  ctx.provide(DESKTOP_SHELL_SERVICE, {
    /** Absolute path of the built frontend index.html (assembly fact, never config). */
    distIndex: resolveDistIndex(),

    /**
     * Compose the current entry graph served as window.__DSH_BOOT__.
     * @returns the graph object (stable between recompositions).
     */
    graph() {
      return ctx.get("clientModules").graph();
    },

    /**
     * Render the file:// index: transport preamble, module-system queue,
     * bootstrap/application batches, and the boot graph, with every /plugins/
     * URL rewritten onto the dsh:// protocol the shell owns.
     * @returns the complete index.html text.
     */
    renderIndex() {
      const html = readFileSync(resolveDistIndex(), "utf8");
      const rows = [{ kind: "script", placement: "head", text: CLOSE_GUARD }, transportRow(), ...bootInjections(ctx.get("clientModules").graph())];
      const rendered = renderIndexInjections(html, rows);
      return rendered
        .replace(/<title>[^<]*<\/title>/, `<title>${PRODUCT_TITLE}</title>`)
        .replaceAll(PLUGIN_PREFIX, PLUGIN_URL_PREFIX);
    },

    /**
     * Dispatch one already-trusted renderer request to its host owner:
     * /plugins/… bundles go to the client-modules registry, everything below
     * /api to the Connection shared Fetch handler. The Electron shell is the
     * trust boundary (the window runs the app's own code), matching the
     * official "shell-owned carrier dispatches the shared Fetch handler
     * directly" contract.
     * @param request - WHATWG Request from the shell.
     * @returns the owner's Response (404 when unclaimed).
     */
    async fetch(request) {
      const url = new URL(request.url);
      if (url.hostname === PLUGIN_HOST && url.pathname.startsWith(PLUGIN_PREFIX)) {
        return ctx.get("clientModules").fetchBundle(request);
      }
      if (url.hostname === PLUGIN_HOST) return new Response("not found", { status: 404 });
      const shared = ctx.get("connection").createSharedFetchHandler("/api");
      return shared.fetch(request);
    },

    /**
     * Open one Gateway logical stream (forwarded events or a stream Remote)
     * through the carrier-neutral adapter.
     * @param endpoint - canonical Remote endpoint or "$events".
     * @param payload - decoded carrier payload ({ args: {...} }).
     * @param signal - logical-stream cancellation.
     * @returns the validated value iterable.
     */
    openStream(endpoint, payload, signal) {
      return ctx.get("typertGateway").wireStream.open(endpoint, payload, signal);
    },
  });
}

export { DESKTOP_SHELL_SERVICE, WEB_RUNTIME_SERVICE, apply, name };
