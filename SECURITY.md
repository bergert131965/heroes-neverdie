# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through either channel:

1. **GitHub private vulnerability reporting** — go to the
   [Security tab](https://github.com/bergert131965/heroes-neverdie/security) → *Report a vulnerability*.
   This keeps the report, discussion and fix private until an advisory is published.
2. **Email** — use the address on the maintainer's GitHub profile
   ([@bergert131965](https://github.com/bergert131965)) if you cannot use GitHub.

Please include: affected version/commit, macOS and Node version, reproduction steps, and what you
observed versus what you expected. If the issue involves the model provider or credentials, do
**not** paste live keys.

This is a single-maintainer hobby project. Expect a best-effort response, not an SLA. There is no
bug bounty.

---

## What is in scope

This repository ships a desktop **shell** and three client plugins. In scope:

| Component | Path |
|---|---|
| Electron main process, IPC bridge, `dsh://` protocol | `main.js`, `preload.js` |
| Desktop profile and surface prompt | `profile/plugins/desktop-runtime.js`, `profile/plugins/desktop-startup.js` |
| The three self-authored plugins | `profile/plugins/{brand,usage-panel,pinned}/` |
| The two upstream bundle patches | `scripts/patch-brand.mjs`, `scripts/patch-process-fold.mjs` |
| Packaging scripts | `scripts/package-macos.mjs`, `scripts/rebuild-node-pty.sh` |

## What is out of scope

- **Upstream DeepSeek Harness** (`@deepseek-ai/dsh` and every `@deepseek-ai/dsh-*` package).
  Those are a separate project — please report to
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- Vulnerabilities that require an already-compromised machine or an attacker who can already
  write to `~/.dsh`.
- The absence of code signing / notarization (a known limitation, see the README).

---

## Security model

Worth understanding before you report something:

- **The app opens no network port.** The frontend is loaded over `file://` and every request
  travels over an Electron IPC bridge — there is no HTTP server, unlike `dsh web`.
- The renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- The preload exposes a narrow bridge namespace (`invoke` / `send` / `on`), not raw `ipcRenderer`.
- Plugin bundles are served over a custom `dsh://` protocol rather than from disk paths.

**But the shell is a thin skin over an agent that has your shell.** Anyone who can drive this
window can run commands as you. Treat it like a terminal: do not run it against untrusted prompts,
skills or workspaces, and do not hand its `DSH_HOME` to someone else.

## Known limitations (not vulnerabilities)

These are documented design consequences, not bugs:

| Limitation | Detail |
|---|---|
| No user system | One process owns one credential. Multiple people sharing a host share one shell. |
| Shared `~/.dsh` | The desktop shell, `dsh web` and the CLI all read the same home. One session has one live writer (`session.lock` is a non-blocking `flock`). |
| Session files are compressed, not encrypted | Session logs are `session.v3.jsonl.zstd` — zstd is **compression**, not encryption. Anyone who can read the file can decompress it. Use FileVault if the content matters. |
| No auto-cleanup | Sessions and attachments are never deleted automatically. |
| Patches are applied to `node_modules` | `npm ci` overwrites `node_modules`, so `npm run patch:brand` must be re-run. `npm run verify` checks this. |
| Unsigned builds | Packaged `.dmg` / `.zip` are ad-hoc signed and not notarized; Gatekeeper will warn. |

---

## Credential handling

- API keys live in `$DSH_HOME/.credentials.yaml` (default `~/.dsh`), file mode `0600`.
- The `usage-panel` plugin resolves credentials on the **host** side through `ctx.credentials` so
  the key never crosses into the renderer.
- This repository contains **no** keys, sessions or credentials. If you find any committed,
  please report it as a vulnerability.
