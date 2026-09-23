# Third-Party Notices

HeRoes NEVERDIE is an **unofficial** Electron desktop surface for DeepSeek
Harness. It is not affiliated with, sponsored by, or endorsed by DeepSeek.

This file collects the licenses and attributions required by the third-party
software this project depends on or redistributes.

---

## 1. DeepSeek Harness runtime — `@deepseek-ai/dsh`

This application's entire host surface, its web frontend, and every
`@deepseek-ai/dsh-*` plugin it composes are provided by the upstream
DeepSeek Harness project, which is licensed under the MIT License.

- Package: `@deepseek-ai/dsh` (pinned to `0.1.5-rc.2` in `package.json`)
- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- License: MIT

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. Vendored upstream client bundle

`scripts/vendor/dsh-client-ui-chat-0.1.5-rc.2.client.js` is an unmodified copy
of the built client bundle shipped in `@deepseek-ai/dsh-client-ui-chat@0.1.5-rc.2`.
It is vendored so that `scripts/patch-process-fold.mjs` can deterministically
rebuild the process-fold patch against a known baseline.

It is redistributed under the same MIT License, Copyright (c) 2026 DeepSeek,
reproduced in full in section 1.

## 3. Trademarks

"DeepSeek" and "DeepSeek Harness" are trademarks of DeepSeek. They are used in
this repository only descriptively, to state truthfully what this project is
built on and compatible with. No official DeepSeek logo, wordmark, or other
brand asset is included in, or displayed by, this project.

If you redistribute a packaged build of this application, do not present it in
any way that suggests official endorsement, partnership, or authorization.

## 4. Bundled npm dependencies

Direct dependencies:

| Package | Version | License |
| --- | --- | --- |
| `@deepseek-ai/dsh` | `0.1.5-rc.2` | MIT |
| `node-pty` | `1.2.0-beta.15` | MIT |
| `electron` (dev) | `^44.3.0` | MIT |
| `electron-builder` (dev) | `^26.0.12` | MIT |
| `@electron/rebuild` (dev) | `^4.0.1` | MIT |

The transitive dependency tree contains additional packages under MIT,
BSD-3-Clause, ISC, Apache-2.0 and other permissive licenses. Because this
project does not commit `node_modules/`, the authoritative set is whatever
`npm ci` resolves from `package-lock.json`.

> **Before publishing a packaged build** (`.dmg` / `.zip`, which embed the full
> dependency tree and the Electron runtime), generate and ship the complete
> notice list, for example with `license-checker`:
>
> ```sh
> npx license-checker --production --json > third-party-licenses.json
> npx license-checker --production --csv  > third-party-licenses.csv
> ```
