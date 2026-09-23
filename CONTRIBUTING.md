# Contributing

Thanks for taking a look. This is a small project, so the fastest way to get a change merged is to
keep it focused and tell me what you verified.

## Read this first

This repository is a **desktop shell**, not the agent runtime. It owns:

- the Electron main process and the IPC bridge (`main.js`, `preload.js`)
- the reserved `desktop` profile and its surface prompt (`profile/plugins/desktop-runtime.js`, `profile/plugins/desktop-startup.js`)
- three client plugins (`profile/plugins/{brand,usage-panel,pinned}/`)
- two deterministic patches applied to upstream bundles (`scripts/patch-*.mjs`)

Everything else — sessions, settings, credentials, the agent loop, the web frontend — comes from
`@deepseek-ai/dsh` and its `dsh-*` packages. **Bugs in those belong upstream, at
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**, not here.

> Also note the project is **unofficial**. Please do not add anything that could read as official
> DeepSeek branding or endorsement — see [`docs/brand.md`](docs/brand.md).

## Development setup

Requires **macOS** and **Node.js ≥ 22** (the packaging config only targets macOS, and `node-pty` is
a native module rebuilt against the Electron ABI).

```sh
npm ci          # install dependencies
npm run patch   # apply both upstream-bundle patches  ← required, see below
npm start       # run the app
```

`npm run rebuild` recompiles `node-pty` against the Electron ABI if you switch Electron versions.

## The patch mechanism (the one thing that trips people up)

Two behaviours in this app are implemented by **rewriting upstream bundles inside `node_modules`**,
because upstream hardcodes them in places no plugin slot or locale API can reach:

| Script | What it changes |
|---|---|
| `scripts/patch-brand.mjs` | window title, `document.title`, home-hero headline, first-run copy |
| `scripts/patch-process-fold.mjs` | folds a finished turn's process rows into a drawer |

**Never hand-edit `node_modules`.** Two reasons:

1. `npm ci` / `npm install` wipes it — your change silently disappears.
2. There would be no record of it in the repository.

Change the patch script instead. Both follow the same contract:

- every edit is **one anchored literal replacement**, applied exactly once
- a missing or duplicated anchor **fails loudly** rather than half-patching
- re-running is idempotent: an already-patched file is reported, not rewritten
- `--check` verifies without writing, and exits non-zero if anything is unpatched

`scripts/patch-process-fold.mjs` works from a pristine vendored baseline
(`scripts/vendor/dsh-client-ui-chat-0.1.5-rc.2.client.js`) so the output is reproducible.
`scripts/patch-brand.mjs` edits in place and detects already-applied changes by looking for the
replacement text.

### Verify your change

```sh
npm run verify      # both patches: idempotency + 30 behaviour assertions
npm run selftest    # headless boot: 53 client plugins, transport, upload hook, event stream
```

`npm run selftest` boots a real host and occupies `DSH_HOME`. If another host is running on the same
machine (the desktop app or `dsh web`), the self-test can stall at the event-stream handshake — both
fight over `~/.dsh`. Give it its own home:

```sh
DSH_HOME=$(mktemp -d) npm run selftest
```

## Upgrading `@deepseek-ai/dsh`

Upstream ships release candidates and makes **no versioning promise** for the frontend plugin
protocol. One version at a time, and expect to do some of this:

1. bump the pin in `package.json`
2. `npm ci`
3. `npm run patch` — a changed anchor shows up as `ANCHOR MISSING`
4. regenerate `scripts/vendor/` if the process-fold baseline moved
5. `npm run verify && npm run selftest`

## Pull requests

- Keep one concern per PR.
- Say **what you ran**, not just what you changed — a `verify` / `selftest` paste is worth more than
  prose.
- If you touched a patch, mention what the upstream anchor looks like now.
- UI changes: a before/after screenshot helps a lot. Use an isolated `DSH_HOME` so you are not
  photographing real session titles.

## Reporting things

- **Security issues: do not open a public issue.** See [`SECURITY.md`](SECURITY.md).
- **Upstream bugs**: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).
- **Everything else**: open an issue. Include macOS version, Node version, the commit you are on,
  and what you expected versus what happened.
