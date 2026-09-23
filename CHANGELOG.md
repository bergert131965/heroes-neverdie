# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Note that this project wraps `@deepseek-ai/dsh`, which ships release candidates and makes no
versioning promise for its frontend plugin protocol. A minor bump here can therefore require a
matching upstream bump — see the compatibility matrix in the README.

## [Unreleased]

## [1.0.1] — 2026-09-23

First public release.

### Added

- **Desktop shell** — composes the reserved `desktop` profile with a `file://` frontend and an IPC
  bridge instead of an HTTP server, so it stays structurally aligned with `dsh web` rather than
  reimplementing it. No network port is opened.
- **`brand` plugin** — occupies three upstream brand slots: the sidebar mark and wordmark, and the
  home-screen hero mark. The official brand row is disabled so the slots are free.
- **`usage-panel` plugin** — account balance beside a token ledger recomputed locally from the
  session projection cache. Credentials resolve on the host side, so the key never reaches the
  renderer.
- **`pinned` plugin** — pin and hold marks on conversation content, stored per session in browser
  `localStorage` with an in-memory fallback.
- **Two deterministic upstream bundle patches** — `scripts/patch-brand.mjs` (window title, home
  headline, first-run copy) and `scripts/patch-process-fold.mjs` (folds a finished turn's process
  rows into a drawer). Both are anchored literal replacements with idempotency checks; a changed
  upstream anchor fails loudly instead of half-patching.
- **macOS packaging** — `npm run dist` (electron-builder) and `npm run package` (hand-rolled
  packager for hosts that deny unlink/rename). Produces `.app`, `.dmg` and `.zip`.
- **Self-tests** — `npm run verify` (patch idempotency plus 30 behaviour assertions) and
  `npm run selftest` (headless boot: client plugins, transport, upload hook, event stream).
- **CI** — GitHub Actions on macOS runners. The patch check gates; the headless boot self-test is
  non-blocking.
- **Docs** — `docs/brand.md` (which brand positions were replaced, which are deliberately left as
  descriptive references to upstream), `docs/process-fold-progressive.md`,
  `docs/ipc-bridge-hardening.md`, plus `SECURITY.md` and `CONTRIBUTING.md`.

### Known limitations

- **macOS only.** The window code is cross-platform but the packaging config only targets mac.
- **Unsigned.** Builds are ad-hoc signed and not notarized; Gatekeeper will warn on first launch.
- **No user system.** One process owns one credential. Multiple people sharing a host share one
  shell.
- **Session logs are compressed, not encrypted.** `session.v3.jsonl.zstd` is zstd, which is
  compression — anyone who can read the file can decompress it.
- **Pinned state is per-machine.** It lives in browser `localStorage`, under the app's user-data
  directory, not in `~/.dsh`.

### Notes

- This is an **unofficial** project. It is not affiliated with, sponsored by, or endorsed by
  DeepSeek. "DeepSeek" and "DeepSeek Harness" are trademarks of their respective owners and are
  used here descriptively only.

[Unreleased]: https://github.com/bergert131965/heroes-neverdie/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/bergert131965/heroes-neverdie/releases/tag/v1.0.1
