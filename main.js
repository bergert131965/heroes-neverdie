/**
 * dsh-desktop — Electron main process.
 *
 * The officially reserved desktop architecture, end to end:
 *
 * 1. desktop profile — the `desktop` name is reserved for Electron ownership,
 *    so instead of the CLI this app loads its application-owned profile
 *    directory through `loadProfileDirectory` and boots it in-process;
 * 2. file:// loading — the built Web shell dist (same frontend as `dsh web`)
 *    is copied to userData and loaded over file://, with the boot graph
 *    (`window.__DSH_BOOT__`) and plugin bundles injected by the shell;
 * 3. IPC bridge — the renderer's fetch and logical-stream carriers run over
 *    narrow Electron IPC channels and dispatch to the host through the
 *    Connection shared Fetch handler, the client-modules bundle route, and
 *    the Gateway wireStream adapter. No HTTP server exists.
 */
import { app, BrowserWindow, ipcMain, protocol, shell } from "electron";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { chdir } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  boot,
  composeEntries,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfileDirectory,
} from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { installProxyFromEnvironment } from "@deepseek-ai/dsh-http-proxy";
import { DSH_LAUNCH_ENVIRONMENT_KEY } from "@deepseek-ai/dsh-launch-environment";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";

const NAME = "dsh-desktop";
const PLUGIN_HOST = "harness";
const TELEMETRY_ROW_ID = "session-telemetry-otel";
const PROFILE_ROOT_FILENAME = "cordis.yml";
/** The empty root entry list every profile tree patches over (mirrors the CLI). */
const PROFILE_ROOT_CONFIG = `# dsh desktop profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then the
# home-level layer and flag overlays. The Electron main process rewrites this file on
# every boot, exactly like the CLI profile boot does. Edit cordis.patch.yml, not this file.
[]
`;

const HELP = `HeRoes NEVERDIE desktop (Electron)

Boot the reserved desktop profile — the same surface, model access, tools,
and safety defaults as \`dsh web\` — with the frontend loaded over file:// and
every request carried over the IPC bridge instead of HTTP.

Options:
  --workspace <dir>   use this directory as the session workspace root
                      (default: the invoking directory, or your home when
                      launched from Finder)
  --help              print this help and exit

Environment:
  DSH_HOME            Harness home (shared with the CLI; default ~/.dsh)
  DSH_SOURCE_ROOT     optional checkout path announced to the agent
`;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "dsh",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

if (process.versions.electron === undefined) {
  process.stderr.write(
    "dsh-desktop: this entry must run inside Electron; the environment sets ELECTRON_RUN_AS_NODE.\n" +
    "Unset it first: env -u ELECTRON_RUN_AS_NODE electron .\n",
  );
  process.exit(1);
}

// Chromium's OS-level sandbox cannot initialize on some hosts (the same
// denial that breaks sandbox-exec for dsh itself): its child processes then
// die with SIGTRAP and the window never appears. Probe the OS sandbox once at
// startup and degrade to --no-sandbox automatically, so a Finder double-click
// works everywhere. DSH_DESKTOP_DISABLE_SANDBOX=1 forces the opt-out, =0
// forces the sandbox.
function osSandboxAvailable() {
  try {
    execFileSync("sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
// Deterministic layers, strongest last:
//   DSH_DESKTOP_DISABLE_SANDBOX=1            force off
//   DSH_DESKTOP_NO_SANDBOX_RETRY=1           the self-heal relaunch marker
//   probe (sandbox-exec)                    fast path on hosts where it fails
//   render-process-gone crash               deterministic self-heal below
const relaunchedNoSandbox = process.env.DSH_DESKTOP_NO_SANDBOX_RETRY === "1";
if (relaunchedNoSandbox) app.commandLine.appendSwitch("no-sandbox");
if (process.env.DSH_DESKTOP_DISABLE_SANDBOX === "1" ||
    (!relaunchedNoSandbox && process.env.DSH_DESKTOP_DISABLE_SANDBOX !== "0" && !osSandboxAvailable())) {
  app.commandLine.appendSwitch("no-sandbox");
}
const noSandboxActive = app.commandLine.hasSwitch("no-sandbox");
if (noSandboxActive) {
  process.stdout.write(`dsh-desktop: OS sandbox off (probe=${relaunchedNoSandbox ? "relaunch" : "auto"})\n`);
}

// Persist main-process output to userData/desktop.log: LaunchServices
// (Finder double-click) detaches stdout/stderr, so the log file is the only
// way to see why a GUI-launched instance fails. One truncate per boot.
let logPath;
try {
  logPath = join(app.getPath("userData"), "desktop.log");
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(logPath, "");
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const record = (chunk, original) => {
    try {
      appendFileSync(logPath, chunk);
    } catch {}
    return original(chunk);
  };
  process.stdout.write = (chunk) => record(chunk, originalOut);
  process.stderr.write = (chunk) => record(chunk, originalErr);
} catch {}

const appDir = dirname(fileURLToPath(import.meta.url));
const profileDir = join(appDir, "profile");
const installAnchor = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh/package.json"));
const bareModuleBaseUrl = `${pathToFileURL(join(appDir, "node_modules")).href}/`;

/** Resolve the desktop flags this app owns before boot (workspace + help). */
function parseWorkspace(argv) {
  let workspace;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace") {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("-")) {
        throw new Error(`error: --workspace needs a directory, got ${JSON.stringify(argv[i + 1])}`);
      }
      workspace = argv[i + 1];
      i++;
    } else if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length);
      if (value === "") throw new Error("error: --workspace needs a directory");
      workspace = value;
    }
  }
  return workspace;
}

/** The session-telemetry opt-out switch, mirroring the CLI boot patch. */
function telemetryPatch(hasRow) {
  if ((process.env.DSH_TELEMETRY_DISABLED ?? "") === "" || !hasRow) return undefined;
  return { id: TELEMETRY_ROW_ID, disabled: true };
}

/** Launcher-owned readiness signal, mirroring profile-boot's createAppReady. */
function createAppReady() {
  let ready = false;
  const listeners = new Set();
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener();
          return () => {};
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    commit() {
      if (ready) return;
      ready = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

let appCtx; // settled boot context (disposed on quit)
let desktopShell; // the shell-owned carrier service
let disposeProxy; // HTTP proxy install disposer
let mainWindow = null;
let disposed = false;
let exitCode = 0;

async function disposeTree() {
  if (disposed) return;
  disposed = true;
  try {
    await appCtx?.fiber.dispose();
  } catch (error) {
    process.stderr.write(`${NAME}: tree disposal failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  try {
    await disposeProxy?.();
  } catch {}
}

function requestQuit(code) {
  exitCode = code;
  app.quit();
}

/** One cleanup hook per WebContents instead of one listener per request. */
const senderCleanups = new Map(); // webContents.id -> Set<fn>
function ensureSenderCleanup(sender) {
  if (!senderCleanups.has(sender.id)) {
    const cleanups = new Set();
    senderCleanups.set(sender.id, cleanups);
    sender.once("destroyed", () => {
      for (const cleanup of cleanups) {
        try {
          cleanup();
        } catch {}
      }
      cleanups.clear();
      senderCleanups.delete(sender.id);
    });
  }
  return senderCleanups.get(sender.id);
}

/** Wire the fetch bridge: buffered invoke + streaming body/response events. */
const pendingFetchEntries = new Map(); // requestId -> AbortController (diagnostics)
function installFetchBridge() {
  const pendingFetches = pendingFetchEntries; // requestId -> AbortController
  const pendingBodies = new Map(); // requestId -> streaming-body collector

  const streamResponse = async (webContents, requestId, response) => {
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (!webContents.isDestroyed()) {
      webContents.send("dsh-bridge:fetch-event", { requestId, kind: "head", status: response.status, headers });
    }
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || webContents.isDestroyed()) break;
        webContents.send("dsh-bridge:fetch-event", { requestId, kind: "chunk", bytes: value });
      }
    }
    if (!webContents.isDestroyed()) webContents.send("dsh-bridge:fetch-event", { requestId, kind: "end" });
  };

  const processFetch = async (webContents, msg, body) => {
    const controller = new AbortController();
    pendingFetches.set(msg.requestId, controller);
    const cleanup = () => controller.abort();
    ensureSenderCleanup(webContents).add(cleanup);
    try {
      const url = new URL(msg.url, "http://dsh.internal");
      const request = new Request(url, {
        method: msg.method,
        headers: msg.headers ?? {},
        ...(body !== undefined ? { body } : {}),
        ...(body !== undefined ? { duplex: "half" } : {}),
        signal: controller.signal,
      });
      const response = await desktopShell.fetch(request);
      if (process.env.DSH_DESKTOP_TRACE === "1") {
        process.stdout.write(`[bridge] fetch ${msg.method} ${url.pathname} -> ${response.status}\n`);
      }
      await streamResponse(webContents, msg.requestId, response);
    } catch (error) {
      if (!webContents.isDestroyed()) {
        webContents.send("dsh-bridge:fetch-event", {
          requestId: msg.requestId,
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      pendingFetches.delete(msg.requestId);
      ensureSenderCleanup(webContents)?.delete(cleanup);
    }
  };

  ipcMain.handle("dsh-bridge:fetch", (event, msg) => {
    if (msg.bodyIsStream === true) {
      pendingBodies.set(msg.requestId, { event, msg, chunks: [], errored: null, ended: false });
      return { ack: true };
    }
    const body = msg.body === undefined ? undefined : Buffer.from(msg.body, "base64");
    // Non-blocking ack: the response itself streams back over fetch-event,
    // so buffered and streaming requests share one path and large downloads
    // start flowing before the body completes.
    void processFetch(event.sender, msg, body);
    return { ack: true };
  });

  ipcMain.on("dsh-bridge:fetch-body", (event, msg) => {
    const entry = pendingBodies.get(msg.requestId);
    if (entry === undefined || entry.event.sender !== event.sender) return;
    if (msg.kind === "chunk") entry.chunks.push(Buffer.from(msg.bytes, "base64"));
    else if (msg.kind === "error") entry.errored = msg.message;
    else if (msg.kind === "end") {
      entry.ended = true;
      pendingBodies.delete(msg.requestId);
      const body = new ReadableStream({
        start(controller) {
          if (entry.errored !== null) controller.error(new Error(entry.errored));
          else {
            for (const chunk of entry.chunks) controller.enqueue(chunk);
            controller.close();
          }
        },
      });
      void processFetch(event.sender, entry.msg, body);
    }
  });

  ipcMain.on("dsh-bridge:fetch-abort", (event, msg) => {
    pendingFetches.get(msg.requestId)?.abort();
    const bodyEntry = pendingBodies.get(msg.requestId);
    if (bodyEntry !== undefined && bodyEntry.event.sender === event.sender) {
      pendingBodies.delete(msg.requestId);
    }
  });
}

/** Wire the logical-stream bridge over the Gateway wireStream adapter. */
function installStreamBridge() {
  const openStreams = new Map(); // streamId -> AbortController

  ipcMain.handle("dsh-bridge:stream-open", async (event, msg) => {
    const streamId = randomUUID();
    const controller = new AbortController();
    openStreams.set(streamId, controller);
    const cleanup = () => {
      controller.abort();
      openStreams.delete(streamId);
    };
    ensureSenderCleanup(event.sender).add(cleanup);
    void (async () => {
      try {
        const iterable = await desktopShell.openStream(msg.endpoint, msg.payload, controller.signal);
        for await (const value of iterable) {
          if (event.sender.isDestroyed()) break;
          event.sender.send("dsh-bridge:stream-event", { streamId, kind: "item", value });
        }
        if (!event.sender.isDestroyed()) {
          event.sender.send("dsh-bridge:stream-event", { streamId, kind: "end" });
        }
      } catch (error) {
        const failure = appCtx.get("typertGateway").wireStream.failure(error);
        if (!event.sender.isDestroyed()) {
          event.sender.send("dsh-bridge:stream-event", { streamId, kind: "error", error: failure });
        }
      } finally {
        openStreams.delete(streamId);
        ensureSenderCleanup(event.sender)?.delete(cleanup);
      }
    })();
    return streamId;
  });

  ipcMain.on("dsh-bridge:stream-cancel", (_event, msg) => {
    openStreams.get(msg.streamId)?.abort();
    openStreams.delete(msg.streamId);
  });
}

/**
 * Show the product icon in the Dock for unpackaged runs.
 *
 * `npm start` and `npm run selftest` execute the stock Electron binary from
 * `node_modules`, so without this the Dock tile shows the Electron logo.
 * Packaged builds do not need it — `build/` is not shipped inside the asar, and
 * the real icon is already baked into the bundle by electron-builder /
 * `scripts/package-macos.mjs`. Hence the `existsSync` guard.
 */
function applyDevelopmentDockIcon() {
  if (process.platform !== "darwin" || app.dock === undefined) return;
  const icon = join(appDir, "build", "icon.png");
  if (!existsSync(icon)) return;
  app.dock.setIcon(icon);
  console.log(`${NAME}: Dock icon set for this unpackaged run (${icon})`);
}

/** Stage the dist copy with the rendered index and open the window. */
function createWindow() {
  const distRoot = join(app.getPath("userData"), "desktop-dist");
  const distSrc = dirname(desktopShell.distIndex);
  // Merge-copy instead of delete+copy: this host denies bulk unlinks, and a
  // merge keeps the dist fresh without ever needing one. Stale asset files
  // from older versions are inert.
  cpSync(distSrc, distRoot, { recursive: true, force: true });
  writeFileSync(join(distRoot, "index.html"), desktopShell.renderIndex());

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "HeRoes NEVERDIE",
    show: false,
    backgroundColor: "#101014",
    webPreferences: {
      preload: join(appDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    process.stdout.write(`[diag] window closed at ${new Date().toISOString()}\n`);
  });
  win.webContents.on("close", () => {
    process.stdout.write(`[diag] webContents close at ${new Date().toISOString()}\n`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stderr.write(`dsh-desktop: page load failed (${code} ${desc} ${url})\n`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    process.stderr.write(`dsh-desktop: renderer process gone: ${JSON.stringify(details)}\n`);
    // The OS sandbox cannot initialize on this host (renderer dies with a
    // SIGTRAP/SIGABRT CHECK); relaunch once with --no-sandbox, exactly like
    // the CLI launcher hands a relaunch back to the user.
    if (!noSandboxActive && !relaunchedNoSandbox && details.reason === "crashed") {
      process.stderr.write("dsh-desktop: renderer crashed under the OS sandbox; relaunching with --no-sandbox\n");
      try {
        // The relaunched instance must run as Electron: this host's shell
        // sessions export ELECTRON_RUN_AS_NODE, which would turn the child
        // into a plain Node process that exits immediately.
        const childEnv = { ...process.env, DSH_DESKTOP_NO_SANDBOX_RETRY: "1" };
        delete childEnv.ELECTRON_RUN_AS_NODE;
        const child = spawn(process.execPath, [...process.argv.slice(1), "--no-sandbox"], {
          detached: true,
          stdio: "ignore",
          env: childEnv,
        });
        child.unref();
      } catch {}
      app.exit(0);
    }
  });


  if (process.env.DSH_DESKTOP_SELFTEST === "1") {
    // TEMPORARY (feasibility probe): the driver body is read from disk so main.js
    // carries no probe logic of its own. Delete with probe/ when the answer lands.
    let probeDriver = "async () => ({ error: 'probe driver is not packaged' })";
    try {
      const source = readFileSync(join(appDir, "probe", "boot-probe.js"), "utf8");
      // The driver is inlined as a single expression for executeJavaScript, so it
      // must be self-contained (an IIFE) and free of module syntax.
      const body = source.replace(/export\s+(async\s+function\s+runBootProbe)/, "$1");
      probeDriver = `(() => (async () => {\n${body}\nreturn runBootProbe();\n})())`;
    } catch (error) {
      process.stderr.write(`dsh-desktop: probe driver unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    win.webContents.on("console-message", (_event, level, message) => {
      process.stdout.write(`[renderer:${level}] ${message}\n`);
    });
    win.webContents.on("did-finish-load", async () => {
      process.stdout.write("[diag] did-finish-load\n");
      try {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        process.stdout.write("[diag] running probes\n");
        // TEMPORARY (feasibility probe): index-level and shell-carrier evidence,
        // observed in the main process so it does not depend on renderer globals.
        try {
          const distRoot = join(app.getPath("userData"), "desktop-dist");
          const indexText = readFileSync(join(distRoot, "index.html"), "utf8");
          const probeId = "@dsh-probe/client-ui-autoapprove-probe";
          // Use the URL the shell actually advertised in the rendered index: the
          // bundle route is revision-addressed, so a hand-built URL is expected to
          // 404 and would prove nothing either way.
          const advertised = indexText.match(/dsh:\\?\/\\?\/[^"'\s]*plugins[^"'\s]*/g) ?? [];
          const rawProbeUrl = advertised.find((url) => url.includes(probeId)) ?? advertised[0] ?? "";
          // The index is HTML: the shell escapes `&` in the injected boot graph, so
          // the advertised URL must be unescaped before it addresses the bundle map.
          const probeUrl = rawProbeUrl
            .replace(/\\\//g, "/")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
          const bundleResponse = await desktopShell.fetch(new Request(probeUrl));
          const bundleBody = await bundleResponse.text();
          process.stdout.write(`[probe:index] ${JSON.stringify({
            probeIdInIndex: indexText.includes(probeId),
            bootEntryCount: (indexText.match(/"id":/g) ?? []).length,
            probeUrl,
            bundle: {
              status: bundleResponse.status,
              contentType: bundleResponse.headers.get("content-type"),
              bytes: bundleBody.length,
              carriesMarker: bundleBody.includes("[probe-plugin]"),
            },
          })}\n`);
        } catch (error) {
          process.stdout.write(`[probe:index] failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        const probe = await win.webContents.executeJavaScript(`(async () => {
          console.error("[probe] begin");
          const bootGraph = (globalThis.__DSH_BOOT__?.entries ?? []).length;
          const transport = typeof globalThis.__DSH_TRANSPORT__?.fetch === "function";
          const uploadHook = typeof globalThis.__DSH_FILE_UPLOAD__?.fetch === "function";
          let streamProbe = null;
          console.error("[probe] opening $events stream");
          try {
            const iter = globalThis.__DSH_TRANSPORT__.openStream("$events", { args: {} }, new AbortController().signal);
            const first = await iter[Symbol.asyncIterator]().next();
            console.error("[probe] $events first item", first.done, first.value?.type);
            streamProbe = { done: first.done, itemType: first.value?.type ?? null, host: first.value?.host?.home ?? null };
          } catch (error) {
            streamProbe = { error: String(error) };
          }
          let rpcProbe = null;
          console.error("[probe] posting bogus rpc");
          try {
            const response = await globalThis.__DSH_TRANSPORT__.fetch(
              new URL("http://dsh.internal/api/__desktop_probe_not_real__"),
              { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ type: "client-request", rpcId: "probe", method: "__desktop_probe_not_real__", payload: {} }) },
            );
            rpcProbe = { status: response.status, body: (await response.text()).slice(0, 120) };
          } catch (error) {
            rpcProbe = { error: String(error) };
          }
          console.error("[probe] done");
          let bootProbe = null;
          try {
            bootProbe = await (${probeDriver})();
          } catch (error) {
            bootProbe = { driverError: String(error) };
          }
          return {
            bootGraph, transport, uploadHook, streamProbe, rpcProbe, bootProbe,
            title: document.title,
            rootChildren: document.getElementById("root")?.children.length ?? -1,
            bodyText: document.body.innerText.slice(0, 300),
          };
        })()`);
        process.stdout.write(`[selftest] ${JSON.stringify(probe, null, 2)}\n`);
        const { writeFileSync: w2 } = await import("node:fs");
        w2(join(app.getPath("userData"), "selftest-result.json"), JSON.stringify(probe, null, 2));
        const image = await win.webContents.capturePage();
        const { writeFileSync } = await import("node:fs");
        const shotPath = join(app.getPath("userData"), "selftest.png");
        writeFileSync(shotPath, image.toPNG());
        process.stdout.write(`[selftest] screenshot: ${shotPath}\n`);
        app.exit(0);
      } catch (error) {
        process.stdout.write(`[selftest] failed: ${error instanceof Error ? error.stack : String(error)}\n`);
        app.exit(1);
      }
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadFile(join(distRoot, "index.html"));
  return win;
}

/** Inner arguments regardless of how the process was launched: dev (`electron .`),
 * direct binary with flags, or Finder. The leading app-path token, when
 * present and not a flag, is dropped. */
function splitAppArgs(argv) {
  const args = [...argv];
  const first = args[0];
  if (first === undefined) return [];
  if (first === "." || first.endsWith("main.js") || first.endsWith(".app") || (first.includes("/") && !first.startsWith("-"))) {
    return args.slice(1);
  }
  return args;
}

async function main() {
  const desktopArgs = splitAppArgs(process.argv.slice(1));
  if (desktopArgs.includes("--help") || desktopArgs.includes("-h")) {
    process.stdout.write(HELP);
    app.exit(0);
    return;
  }

  let workspace;
  try {
    workspace = parseWorkspace(desktopArgs) ?? process.env.DSH_WORKSPACE ?? (process.cwd() === "/" ? homedir() : process.cwd());
    workspace = resolve(workspace);
    if (!existsSync(workspace)) throw new Error(`workspace directory ${JSON.stringify(workspace)} does not exist`);
    chdir(workspace);
  } catch (error) {
    process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(2);
    return;
  }

  const environment = loadLayeredEnv(NAME, workspace);
  disposeProxy = await installProxyFromEnvironment(environment, (message) => {
    process.stderr.write(`${NAME}: ${message}\n`);
  });
  installFailLoud(NAME, process, async () => {
    await disposeTree();
  });

  // ── desktop profile: application-owned, loaded outside CLI profile lookup ──
  const profile = loadProfileDirectory(NAME, profileDir, installAnchor, { userLayer: true });
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG);
  const homePatches = loadOptionalPatches(NAME, join(resolveDshHome(), "cordis.patch.yml")) ?? [];
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
  const rows = new Map();
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches])) {
    if (typeof row.id === "string") rows.set(row.id, row);
  }
  const overlays = [];
  const telemetry = telemetryPatch(rows.has(TELEMETRY_ROW_ID));
  if (telemetry !== undefined) overlays.push(telemetry);

  const appReady = createAppReady();
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME);
  appCtx = await boot(
    NAME,
    rootConfig,
    [...bundlePatches, ...profile.patches, ...homePatches, ...overlays],
    (hostCtx) => {
      appCtx = hostCtx;
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
      provideCmdline(hostCtx, {
        args: desktopArgs,
        exit: (code) => requestQuit(code),
        ready: appReady.service,
      });
    },
    bareModuleBaseUrl,
  );
  appReady.commit();

  desktopShell = appCtx.get("desktopShell");
  if (desktopShell === undefined) {
    throw new Error(`${NAME}: desktop-runtime did not provide the desktopShell service`);
  }
  const graph = desktopShell.graph();
  console.log(`${NAME}: booted ${String(graph.entries.length)} client plugins (graph ${graph.rev})`);

  // ── dsh:// protocol: plugin bundles for the file:// page ──
  protocol.handle("dsh", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== PLUGIN_HOST) return new Response("not found", { status: 404 });
      return await desktopShell.fetch(request);
    } catch (error) {
      return new Response(`bridge failure: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
    }
  });

  installFetchBridge();
  installStreamBridge();

  applyDevelopmentDockIcon();

  mainWindow = createWindow();
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  console.log(`${NAME}: ready (workspace ${process.cwd()})`);
}

app.whenReady().then(
    () =>
      main().catch((error) => {
        process.stderr.write(`${NAME}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        app.exit(1);
      }),
    (error) => {
      process.stderr.write(`${NAME}: app failed to become ready: ${error instanceof Error ? error.message : String(error)}\n`);
      app.exit(1);
    },
  );

  app.on("activate", () => {
    if (desktopShell !== undefined && mainWindow === null) {
      mainWindow = createWindow();
      mainWindow.on("closed", () => {
        mainWindow = null;
      });
    }
  });

  app.on("window-all-closed", () => {
    process.stdout.write("[diag] window-all-closed -> quit\n");
    app.quit();
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    process.stdout.write(`[diag] before-quit (quitting=${quitting})\n`);
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void (async () => {
      await disposeTree();
      app.exit(exitCode);
    })();
  });
