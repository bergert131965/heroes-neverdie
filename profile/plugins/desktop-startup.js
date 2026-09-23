/**
 * The Electron app's command-line provider: parses the desktop flag family
 * (`--workspace <dir>`, `--help`) and provides the immutable values as
 * `desktopStartup`. It mirrors `@deepseek-ai/dsh-web-app/startup`, whose
 * row this profile disables.
 * @module dsh-desktop-profile/plugins/desktop-startup
 */
const name = "desktop-startup";
/** Services required before the flags can be resolved. */
const inject = ["cmdlineArgs"];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
const DESKTOP_STARTUP_SERVICE = "desktopStartup";

const HELP = `
DeepSeek Harness (dsh) desktop shell — boot the desktop profile with the same
surface, model access, tools, and safety defaults as \`dsh web\`, over file://
plus the IPC bridge instead of HTTP.

Examples:
  --workspace /path/to/project   use this directory as the session workspace root
  --help                         print this help and exit

Flags after the app executable reach the booted profile unchanged.
`;

function parseDesktopFlags(args) {
  const flags = { workspace: undefined, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--workspace") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`error: --workspace needs a directory, got ${JSON.stringify(value)}`);
      }
      flags.workspace = value;
      i++;
    } else if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length);
      if (value === "") throw new Error("error: --workspace needs a directory");
      flags.workspace = value;
    }
  }
  return flags;
}

/**
 * Parse and provide the Desktop invocation as an ordinary Cordis service.
 * The Electron main process already applied the workspace (process.chdir)
 * before boot; this row only publishes the parsed snapshot for consumers.
 * @param ctx - plugin context carrying the command line.
 */
function apply(ctx) {
  let parsed;
  try {
    parsed = parseDesktopFlags(ctx.cmdlineArgs.get());
  } catch (error) {
    process.stderr.write(`dsh-desktop: ${error instanceof Error ? error.message : String(error)}\n`);
    ctx.appExit(2);
    return;
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    ctx.appExit(0);
    return;
  }
  ctx.provide(DESKTOP_STARTUP_SERVICE, {
    workspace: parsed.workspace,
  });
}

export { DESKTOP_STARTUP_SERVICE, apply, inject, name };
