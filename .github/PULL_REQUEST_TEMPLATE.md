## What this changes

<!-- One or two sentences. -->

## Why

<!-- The problem it solves, or the behaviour it fixes. -->

## How I verified it

- [ ] `npm run verify` passes (both patches, idempotency plus 30 behaviour assertions)
- [ ] `npm run selftest` passes
- [ ] If this touched a patch: I ran `npm ci && npm run patch` from a clean `node_modules` and re-ran `verify`
- [ ] If this is a UI change: I attached a before/after screenshot taken with an isolated `DSH_HOME`

## Notes

<!--
Two things that come up often:

- Dependencies come from @deepseek-ai/dsh. If your change depends on a particular upstream
  version, say which one — the compatibility matrix in the README is the place to record it.
- Do not hand-edit anything under node_modules; the patches are the source of truth. If an
  upstream anchor moved, update the patch script's `from` string and say what it is now.
  See CONTRIBUTING.md.
-->
