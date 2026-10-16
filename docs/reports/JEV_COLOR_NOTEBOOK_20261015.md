# Jev 0.5.9: session color survives the handoff clear (2026-10-15)

Brief: `var/agents/_briefs/jev_color_20261015.md`. Model: Sonnet 5.5. Branch `fix/color-carry-20261015`.

## Finding

`/color` lives only as `{"type":"agent-color","agentColor":"<name>","sessionId":"<id>"}` in the session transcript. A real record (Pick-Assist transcript) has exactly those three fields, no uuid or timestamp. The clear opens a new transcript without it.

The handoff already issues its clear through `host.command.run({ command: 'clear' })` (`hooks/handoff.ts`, detached work in `handoffStep`), then `followSessionId`, then `host.prompt.submit(resumeOrder)`.

## Built

- `hooks/color-carry.ts` (new): `transcriptPath`, `newestColor`, `readSessionColor`, `carryColor`.
- `hooks/handoff.ts`: after the final file check and before `command.run('clear')`, read the color from the old transcript. After `followSessionId` and before the RESUME submit, call `carryColor`. New optional `StepContext.transcriptPathFor`.
- `hooks/fast-jev.ts`: supplies `transcriptPathFor` (`~/.claude/projects/<cwd, non-alphanumerics to '-'>/<sid>.jsonl`), `HOOK_ID` bumped.
- Version 0.5.9 in package.json, package-lock.json, both `.claude-plugin` manifests, README.md, hooks/README.md, `tests/forced-handoff.test.ts` receipt check. CHANGELOG entry. `docs/INDEX.md` still points at the 0.5.8 report on purpose.
- `tests/color-carry.test.ts`: 9 tests.

## Decisions

- Route: `$.command.run({ command: 'color', args })`, the same route as the clear, used only when `$.command.list()` has `color`. I did not use `prompt.submit('/color x')`; its slash handling is undocumented.
- Read: `$.fs` has no ranged read and no append, so the transcript is streamed through `grep -a` (posix) or `findstr` (Windows) via `$.process.run`. The plugin holds only matching lines (a few records), never the file. This is a streaming scan of the whole file, not a literal tail read; the newest record is the last matching line. Deviation from the brief's "scan from the end", chosen because a tail window can miss a color set early in a long session.
- Fallback (no `color` command, or `/color` threw): read the new transcript if present, append an identical record with the new session id (uuid and timestamp refreshed only if the original had them), write it back. Takes effect only at the next resume. Risk: `$.fs.write` replaces the file, so a host write between our read and write could be lost; the new transcript is tiny right after a clear, so I accepted it.
- Every color path catches its own errors and logs; a failure never stops the resume order.

## Not done / not verified

- Live check: that `command.run('color')` actually repaints the bar after a real clear, and that the transcript slug rule matches the host's for every cwd. Parent owns the install and the live run.
- `docs/AGENT_RULES.md` does not exist in this worktree; I followed the brief's rules only.
- A cwd that drifted from the launch cwd would point at the wrong project folder; the scan then finds nothing and the handoff goes on without color (logged only when the read itself fails).

## Checks

`npm test`: see the commit report for the verbatim summary line. `npm run typecheck`: clean.
