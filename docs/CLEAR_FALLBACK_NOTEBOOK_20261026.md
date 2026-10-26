# Clear console fallback notebook, 2026-10-26 (tk-rdrv0, branch feat/clear-console-fallback, 0.5.17)

Model: Sonnet 5.5. Started 14:17, build and live tests done by about 14:30.

## Findings
- Plugin modules are sandboxed (only `$`), so no node imports. Console work needs a child: `$.process.run` with powershell.
- `$.process.run` takes `env` in init. Helper input goes through FJ_SID / FJ_PID / FJ_TEXT, no quoting trouble.
- `~/.claude/sessions/<pid>.json` has `sessionId`, `pid`, `updatedAt`. Matching on sessionId plus a live process finds the claude.exe pid (checked live: sid 275531cb -> pid 10420).
- Real screens (2.1.310): idle = rule row (may end with the session name) / `❯` / rule / status line. Busy shows "esc to interrupt" in the status line and the marker is `>`. Idle with background agents has no "esc to interrupt".
- Add-Type compile is fast here (about 0.2 s per run). Two runs (read, type) cost under a second.
- Old module instance keeps running its detached work after the clear (0.5.16 log shows `session id CHANGED` from the old work), so polling `$.session.id()` after typing is the same path as after `command.run`.
- Logged lines get a `[sid8]` prefix; test assertions must not use exact-element `toContain` on the raw log array in the registered harness.

## Built
- `hooks/console-clear.ts`: `isStoppedRefusal`, `screenVerdict`, `consoleClear`, `CONSOLE_HELPER_PS1`, `onWindows`.
- `hooks/handoff.ts`: `StepContext.consoleClear`, catch branch tries it on the refusal, `waitForNewId` (30 s, 500 ms poll), failure line gets `; console fallback: ...`.
- `hooks/fast-jev.ts`: wires `consoleClear` on Windows in the turn-complete handoffStep call.
- Version 0.5.17: package.json, package-lock.json, plugin.json, marketplace.json, HOOK_ID, README.md, hooks/README.md, forced-handoff test, CHANGELOG.

## Tried, live (scratch F:/temp/cc)
- Hidden child console showing an idle screen: helper typed 14 records, the child read `/clear\n`.
- Same with typed text in the box, "esc to interrupt", a dialog screen: all refused, nothing typed.
- Read against this meta session's real console by session id: found pid 10420, rows returned.
- Not tested live: a real handoff clear on a stopped Claude session. The install step owner should watch the first real refusal for the `handoff clear via console fallback (pid N)` line.

## Failed / fixed
- First helper had non-ASCII in the script (tsx cooked `\u2500` in String.raw); PowerShell read it as cp932 and the C# failed to compile. Fixed by `(char)0x2500` style code points; a test asserts the script is ASCII only.

## Stage
Done, committed and pushed. Not merged, not tagged, not installed (Meta lands it).
