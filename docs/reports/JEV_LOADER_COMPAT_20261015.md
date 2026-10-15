# Jev loader compatibility, 2026-10-15

Model: gpt-6.1-sol. Initial estimate: 20 minutes.
Work started 12:34 local. Local checks passed 12:37.
Worktree: `tmp/wt_jev_loader_compat`.
Branch: `fix/jev-loader-compat-20261015`.
Base: `80498e677dee200f53a472e5da2ea2abb8a0089e`.

## Finding and change

The parent reported Claude 2.1.300 refusing compiled `fast-jev.ts` line 428, `await loadedReceipt($)`. The helper was inside `register`. The loader accepts host arguments only at module-local helper declarations or imports. `ratioMiss` had the same local-helper shape. Its rejection was not separately observed.

Moved both helpers to top-level function declarations in `hooks/fast-jev.ts`. `loadedReceipt` takes the registration's session set. `ratioMiss` takes `HookConfig` and explicit state containing the existing maps, sets and handoff roots. All state is still created inside `register`. No host event is aliased or read as a value.

Added three tests to `tests/host-loader-contract.test.ts`. The TypeScript AST and symbol binder check identifier calls with direct `$` arguments, including casts, multiline calls and lexical shadowing. Fixtures reject local helpers and accept top-level functions, const functions and imports. This is bounded coverage, not native scanner parity. Host aliases, property callees and other native grammar are outside this new check.

Added one test to `tests/forced-handoff.test.ts` for receipt and forced-notice dedupe across repeated callbacks, re-registration and session changes. The exact 25% boundary, flag classifications, no-summary behavior, forced lifecycle and final file/session checks stay unchanged.

## Checks

- `npm ci --ignore-scripts --cache F:/temp/npm-cache`: passed with `TEMP` and `TMP` set to `F:/temp`. No lockfile change. npm reported 7 dependency vulnerabilities; dependency changes are outside this fix.
- `npm test`: 242 passed, 16 files. All 238 existing tests retained, four added. Vitest duration 1.17 seconds.
- `npm run typecheck`: passed, including `typecheck:hooks`.
- `npm run build`: passed.
- `git diff --check`: passed.
- Reviewed the helper relocation and explicit state wiring. No handoff implementation or threshold change.

## Stage and handoff

Implementation and local checks are complete. Parent owns native validation after this branch is pushed. No native Claude launch, registry or installed-plugin change, settings edit, hook-rule edit or hooksPath override was run here. The old forced-handoff notebook is untouched.
