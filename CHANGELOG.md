# Changelog

## 0.5.9 - 2026-10-15

- Keep the `/color` session color across the handoff clear. Before the clear the newest `agent-color` record is read from the outgoing transcript (streamed through grep/findstr, never loaded whole); after the clear and before HANDOFF RESUME it is re-applied with `/color <name>` through `$.command.run`. If the host lists no `color` command or the run fails, an identical record is appended to the new transcript, which only takes effect at the next resume. No record means nothing is done. A read error is logged and the handoff goes on.

## 0.5.8 - 2026-10-15

- A reduction strictly below `minReductionRatio` now retains history and pins and immediately forces a written HANDOFF NOW. Exactly 25% passes at the default floor. This also covers unscored recovery and late-delivery ratio misses. Missing, changed or unreadable `DISABLE_AUTO_COMPACT` never restores built-in summary fallback. The older release notes below describe their historical behavior, not the 0.5.8 policy.
- Persist the ratio force reason and bounded order budget in session handoff state. Start NOW without waiting for 250k/300k token thresholds, even when usage is unavailable. Orders and markers name the real reason and actual tokens or `null`, not a synthetic count. Callback reload and lost flag/usage reads continue the cycle. Compaction callbacks only request an order; later non-aborted main-loop completions validate and clear. Deduplicate ratio-force notices and avoid a duplicate NOW on the first completion.
- Keep token triggers, target fitting, skip-on-Jev-error behavior and token-threshold handoffs opt-in through `DISABLE_AUTO_COMPACT=1`. Other sessions keep percent triggers and unscored recovery on Jev errors. Neither policy calls the built-in summary. The launcher flag is still needed to disable the harness's independent automatic compaction.
- Require a fresh regular latest.md, the exact session id in its first 10 lines, a final `COMPLETE` line and stable mtime/size across each read. Recheck the file after the detached delay and immediately before clear, including changes during resumed-marker and log writes. Recheck the session id after the final file validation so a session switch during its read/stat cannot clear a new session. Reject a replaced version even if it is complete. Deduplicate concurrent clear capability lookups and fail closed when clear is unavailable. Orders repeat at most 3 times; clear failures stop at 3 attempts. No RESUME without a successful clear. A written `resumed.json` alone is not proof that clear happened.
- Write a disk-only callback `module-loaded` receipt with source build `fast-jev-compaction@0.5.8/forced-handoff-floor`, full session id and classified launcher flag (`1`, `unset`, `other`, `unreadable`). Write once per session per callback registration, not from manifest inspection. Never log raw environment values or error bodies.
- Validation: 238 tests across 16 files, library/hook typechecks, build and diff check passed. The final-session read/stat regressions both failed before the guard and pass with it. Native scanner validation, installation, fresh runtime receipts and live clear/resume acceptance were not run in this worktree; the parent owns those checks.

## 0.5.7 - 2026-10-15

- Recognize Claude Code 2.1.300 `session.append` API text blocks (`type: "text"`) as well as legacy projected text (`kind: "text"`). The live 10:06 cut exposed ordinary text being mislabeled opaque and skipped by the observer ledger. Text blocks now join verbatim and become pinned deliveries, including arrivals during scoring and child scopes. Explicit opaque kinds and missing/non-string text remain excluded.
- Keep routine opaque-block receipts in `~/.claude/fast-jev-compaction.log` only. Cut summaries, applied measurements, errors and fidelity-gap warnings remain visible. These `ui.log` receipts were visible transcript diagnostics, not model context; the 0.5.6 bookkeeping reduction remains intact.
- Validation: 203 tests, library/hook typechecks, build and Claude plugin scanner validation. New registered-hook regressions replay the observed block shape with hidden projected/API deliveries, durable pin writes, a cold restart and a child arrival during scoring. Installation and a fresh native loader receipt remain deployment checks; this release does not rewrite running-session history.

## 0.5.6 - 2026-10-15

- Collapse exact standalone tool-removal notices into one history-level warning; keep detailed counts in compaction decisions/logs. Repeated passes are idempotent. User text, quoted/fenced examples and tool payloads are untouched.
- Move delivery pin fingerprints and occurrences from model-visible user messages to the host's durable plugin store, keyed by session id and child id. Migrate legacy inline rows on the next accepted cut. Verify writes, preserve input fingerprints if the host rejects a prepared cut, and retain inline pins when storage fails or deliveries arrive during final persistence/diagnostics. Missing or corrupt records conservatively protect user text; tool-only result rows remain eligible.
- Shorten only the exact generated background-notification preamble. Known human prompts stay verbatim, including raw pasted warning examples, across restart. Legacy pins without origin shorten only warning-only fragments after recognized prefixes. Event bodies and ordering remain intact; ambiguous prefixes stay unchanged.
- Measure reduction against the original incoming history, including removed bookkeeping. Session id changes isolate the in-memory delivery ledger as well as durable pins.
- Validation: 194 tests, library/hook typechecks, build, plugin loader validation. Offline keep-all replay of Pick Assist's current parent chain saved an estimated 18,392 visible tokens without changing user payload/order or tools/results beyond the existing host projection. A live accepted compaction is still the runtime acceptance check.

## 0.5.5 - 2026-10-14
- Pending-order marker. A SOON or NOW handoff order writes `<handoffDir>/<sid>/order.json` (`order`, `ts`, `tokens`, `limit`, `attempt`) atomically, rewrites it on each repeated order, and removes it when the cycle ends (after the clear, in the old and new id folders, before the resume submit; also on give-up, blocked clear, third clear failure). Lets the trees' Stop hooks stand down before `latest.md` exists (seen live 20:30: HANDOFF NOW at 300,664 waited behind a Stop-hook refusal). The order log line names the marker path. Rename and delete go through `$.process.run`; without it the marker is written in place and removal leaves `{"order":"none"}`.

## 0.5.4 - 2026-10-14
- The handoff root no longer follows the Bash tool's working directory. A relative `handoffDir` and `handoffSkillPath` resolve once per session id against the cwd seen on that session's first event (the launch cwd) and the root is cached; a later `cd` by the model cannot move `latest.md`, `resumed.json`, `current_session.json`, `prune_skipped.json` or the skill path (seen live 19:32: `var/handoffs/var/handoffs/...`, order re-issued). A changed cwd logs one line per session (`handoff root stays at the captured cwd ...`). A new session id captures again, except after the plugin's own handoff clear: there the new id inherits the old id's root, so a `cd` before the clear cannot move the resume. Absolute values are unchanged.

## 0.5.3 - 2026-10-14
- `handoffDir` resolves against the session working directory when relative (same rule as `handoffSkillPath`), through one helper, `resolveAgainstCwd`; an absolute value is used as given. Default is now `var/handoffs`, so each tree keeps its own store (one writer per store). Applies to the skip marker, the handoff step, `current_session.json` and the resumed/latest files.

## 0.5.2 - 2026-10-14
- Jev unavailable (transport or key failure): a hybrid session no longer cuts blind through the transcript recovery path; it skips, writes `prune_skipped.json` with the reason, counts `jev_unavailable`, and the handoff machine takes over at `handoffAt` and `handoffForceAt` (the User, 18:59). Other sessions keep the 0.4.4 recovery cut.

## 0.5.1 - 2026-10-14
- The session gate also covers the post-cut target loop: `targetVisibleTokens` applies only in a hybrid session (`DISABLE_AUTO_COMPACT=1`); every other session keeps the 0.4.4 cut at `keepThreshold`, so one options block can serve all sessions.

## 0.5.0 - 2026-10-14
- Session gate: the hybrid (token trigger, skip on a ratio miss, handoff orders, clear and resume) runs only where the launcher set `DISABLE_AUTO_COMPACT=1`; any other session keeps the 0.4.4 behaviour (percent trigger, ratio miss falls through to the harness summary, no handoff). One plugin cache serves all sessions; this keeps the test to the one session that opted in.

Source: the User, 17:54 to 18:22 local: the Claude Code auto-compaction is off
entirely (`DISABLE_AUTO_COMPACT=1` on the launcher); the plugin alone manages
context. Jev prunes tool calls from a token trigger, aims at a real post-cut
size, and when the unprunable context reaches two thresholds it orders the
session to write a handoff, forces it, clears the session itself and resumes it
from the handoff file. The built-in summary is never requested.

- `compactAtTokens` (default 160000): the `turn.complete` trigger compares
  `context.tokens` against it. `compactAtPercent` still applies when it is unset.
- `targetVisibleTokens` (default 64000): after the first pass the cut is re-decided
  from the cached Jev probabilities with a rising `keepThreshold` (0.05 steps,
  then 1.0001) until the visible estimate is at or under the target; at the
  floor, `replyMinChars` and `injectedMinChars` are halved once (floors 1100 and
  200). No new Jev request. The estimate counts visible messages only; the real
  context after a prune is the target plus the system and tool prefix.
- A reduction-ratio miss returns `{ skip }` and writes
  `<handoffDir>/<sessionId>/prune_skipped.json`. The `fallback(next)` path is
  removed; `compactTranscript` stays as the offline recovery on transport failure.
- A 32000-token hysteresis after any prune or skip stops a re-fire every turn.
- Handoff orders (`hooks/handoff.ts`), state per session in `$.store`:
  at `handoffAt` (default 250000) of unprunable context, once per 50000 of further
  growth, `$.prompt.submit` of a HANDOFF SOON order; at `handoffForceAt` (default
  300000) a HANDOFF NOW order, repeated at most three more times. When
  `<handoffDir>/<sessionId>/latest.md` exists, names this session in its header,
  ends with `COMPLETE` and is newer than the order: `resumed.json` is written,
  `$.command.run({ command: "clear" })` runs (gated on `$.command.list()`
  containing `clear`), and a HANDOFF RESUME order is submitted. After the clear
  the session id is read again; a changed id gets copies of `latest.md` and
  `resumed.json`, and `current_session.json` records `{ id, previous_id, at }`
  in both cases. Never a clear without a complete file.
- `handoffDir` (absolute) and `handoffSkillPath` (default `docs/HANDOFF_SKILL.md`
  against the session cwd) are quoted in the orders.
- Every log and notify line carries the session id's first 8 characters.
- Six `userConfig` entries in `.claude-plugin/plugin.json`; the harness side
  (`tools/hybrid_enable.py` in the Meta_Orchestrator repo) writes the first five.
- Live checks owed before the User starts it: `$.command.run` with `clear` and
  `$.prompt.submit` from a detached call after `turn.complete`, and whether the
  session id survives the clear.

## 0.4.4 - 2026-10-14

Source: the User, 15:23 local: "I need jev to actually work everytime. The only
time it should not work is if the reduction ratio is not met." Ryan's 15:19
cut hit repeated projected prompts without an intervening text/tool anchor.
This order supersedes the 0.4.1 fallback exceptions below.

- API chronology no longer throws FidelityError. Repeated prompts consume
  projected occurrences in order. Missing anchors use transcript order, with
  a log note. Conflicting text order preserves visible prompts and recovers
  only uncovered spans. Snapshot anchors select occurrences, not first text.
- Missing observer content/anchors retain observable transcript text and log
  the gap. Unknown media is still not representable by handleless rows.
- Request/key/result/preparation failures produce unscored transcript recovery:
  all text and calls stay, eligible old results use the existing truncation and
  evidence notes. Late deliveries stay pinned. The actual replacement,
  including provenance, passes the reduction gate. Only a missed ratio invokes
  the built-in summary. Depth continues to warn only.
- Notifications write disk first; UI failures cannot lose a prepared cut.
  Every recovery reason goes to ~/.claude/fast-jev-compaction.log.
- A host without session.compact never receives a plugin request to core.
  It logs incompatibility. The public host contract has no alternate transcript
  installer; compatible-runtime installation stays with Ryan's existing release
  queue 0f83ff731638. No fabricated setter or direct JSONL write is introduced.
- All 17 new gates fail on pinned 38b2b03 and pass here. The full suite passes
  122/122, with library/hook typechecks, build and actual Claude manifest/hook
  scanner validation. Reproduction:
  `python tools/jev_044_gates.py`. Existing fidelity gates explicitly isolate
  retention/order from the newly restored reduction policy.

## 0.4.3 - 2026-10-14

Source: the User, 2026-10-14 11:58, on Ryan v2's 11:57 compaction (351,458 to 8,330 tokens, 69 s,
built-in summary, no toast, no log line): "It seems like it triggered the normal compact. Check why
jev didn't trigger."

- 0.4.2 never loaded. Claude Code 2.1.299's hooks loader refused the module at the new
  `$.ui.toast?.(text, ...)` call: "$.ui.toast is used as a value (an event of $ bound, passed or
  read) instead of called; $ is always spelled $.noun.event(...) at the call site". A refused module
  is no plugin: every compaction in both sessions since the 11:52 restarts went to the built-in
  summarizer with nothing on screen and nothing on disk. Found with `claude -p ... --debug-file`.
- `notify` calls `$.ui.toast(...)` plainly again; `appendLog` no longer reads `$.fs` or `$.env` as
  values (a missing noun throws inside its own try and is swallowed, as before).
- `tests/host-loader-contract.test.ts`: the hook sources may never optional-chain a call on an
  event of `$` or read one as a value outside the 0.4.1 cast-then-call; fails before an install can.
- Install receipt for any version from here on: a headless `claude -p` run with `--debug-file` must
  show `hooks module fast-jev-compaction@fast-jev-compaction loaded`, never `failed to load`.

## 0.4.2 - 2026-10-14

Source: the User, 2026-10-14 11:40, on Ryan v2's 11:08 compaction, which fell to the built-in summary
with the toast "fallback to built-in summary (delivery contains opaque blocks unsupported by
handleless SessionMessage)": "fix this now", and 11:38 "I also need the jev toast to be put on disk
correctly so the next restart catches it."

- An opaque block inside a delivery (an image or any non-text attachment block) or inside a legacy
  API history user row is no longer an unreconstructable delivery. The host's own projection carries
  such a row as its text blocks joined; Jev now carries exactly that, pins it as before, and writes a
  fidelity note naming the dropped block kinds. A delivery with no text at all pins nothing. The cut
  proceeds; no built-in summary is spent on it. `unreconstructable_delivery` remains for an observer
  that omitted the content blocks and for unprovable chronology.
- Every toast and `$.ui.log` line (fallback reasons, fidelity notes, warnings, the kept-cut line,
  applied-compaction measurements, decision logs) is also appended to
  `~/.claude/fast-jev-compaction.log` (USERPROFILE, then HOME), ISO timestamp first, through the
  host's `fs` (read, trim to the newest 256k characters once over 512k, write). A log that cannot be
  written never changes a cut.
- Tests: the two 0.4.1 opaque-row tests are replaced by their 0.4.2 counterparts (noted and kept, no
  fallback), one test for the log file and one for a failing log write; the core-required contract test
  uses an omitted-content delivery, the row class that still requires core.

## 0.4.1 - 2026-10-14

Source for every change below: Ryan v2's **Jev fork 0.4.1 fidelity brief**, written
2026-10-14 08:05, and the User's 06:43 ruling, "You are not turning off Jev."

- Brief 1: `maxPostCompactTokens` defaults to 0 and only warns. The kept toast
  reports estimated visible post-cut tokens against the target at any value;
  size never triggers summary. Low reduction also warns instead of summarizing
  (brief 5's exhaustive fallback policy).
- Brief 2: pin accepted mid-turn prompts/context and rendered `session.append`
  deliveries verbatim. Observe all append UUIDs for chronology, correlate queued
  deliveries with provisional submissions, and restore arrivals during scoring.
  Track pinned identities across cuts; repeated equal instructions remain distinct.
  One separate fingerprint/occurrence provenance row survives plugin reload and
  resume while each original instruction row remains verbatim.
- Brief 3: first startup/resume cut uses Jev's handleless rebuild. Recover known
  historical hidden text through 2.1.299's bounded API-tail view, aligned to visible
  text/tool anchors. Never substitute the bounded tail for the older history.
- Brief 4: subagent compactions use Jev; select child API history and isolate its
  observer ledger. Queued rendered attachments are passed verbatim and unscored.
  Main-session usage requests remain protected from child completions.
- Brief 5: one retry for transport failures as well as the existing retryable
  HTTP statuses. Classify request failures and invalid/missing/out-of-range engine
  results separately; report a missing compaction event. Every controlled fallback
  toasts its reason; opt-in decision logs count reasons cumulatively. Local budget
  failures veto the cut rather than summarizing. Brief 2's explicit one-cut
  exception covers known opaque/unobservable deliveries or unprovable chronology;
  2.1.299's handleless schema cannot carry opaque media blocks.
- Brief 6: retain precompute veto, handleless fresh IDs/parents, sibling/result
  merging, Unicode pair safety, evidence markers, opt-in kept/dropped probability
  logging and usage guard. All 70 existing tests remain; adapted fallback tests
  state the brief's reason inline. Add pinned-before 4cc723a fidelity regressions.

No engine/model change or keepThreshold 0.7 settings-trial change. Plugin,
marketplace, npm package and lockfile root versions are 0.4.1.

## 0.4.0 - 2026-10-14

- Veto speculative `precompute` Jev calls without a toast. Actual cuts say
  `kept ...; replacement prepared`; plugin-triggered applied cuts log the engine's token measurement.
  Evidence: the held cache study reports 265 trading / 441 Pick no-drop toasts;
  our same-input recount finds 261 / 440, with only one compact boundary among
  701 windows. Current 2.1.299 runtime keeps precompute results for later and may
  discard them. Historical triggers were not recorded, so this does not attribute
  every historical event to precompute.
- Rebuild every retained row without its opaque handle. This prevents reused
  assistant IDs multiplying across resumes (#129) and stale parents bypassing
  the compact boundary (#145). Evidence: current runtime restores both through
  handles; our full raw-transcript read finds 20,103 / 19,966 globally unique
  assistant IDs reused across boundary segments (153,422 / 115,832 repeated
  identity/segment occurrences). First cut after startup uses the built-in
  summary to establish a baseline for legacy resumed histories.
- Combine consecutive assistant rows and adjacent pure result rows when rebuilding.
  Evidence: #137's partial parallel-call edit split one response and triggered
  the host's missing-result repair. Tests retain both adjacent results after
  changing only one sibling, and replay four compact/resume rounds.
- Protect queued prompts and hidden deliveries with the built-in path. Observe
  successful mid-turn prompt submissions and 2.1.299 `session.append` deliveries,
  including internal task notifications, passing the original event to core.
  Evidence: #133 and the runtime's compaction projection omit queued attachments.
  Unsupported observer hosts stay on built-in summary. No shared plugin store
  or guessed instruction chronology is introduced.
- Score recognized injected blocks and old long assistant replies; retain removal
  markers, typed user text and skill arguments. Supply bounded text previews to
  Jev and preserve fenced examples. Evidence: #140 and our study's 98 percent
  reductions with a 168k post-cut median. Adapted from danexplore's upstream
  [PR 141](https://github.com/tamaratran/fast-jev-compaction/pull/141), with stricter
  classification, Unicode safety and the fork's bounded request concurrency.
  A candidate whose bounded preview disappears during state fitting is kept
  unscored (`unrepresented`), rather than asking Jev about invisible evidence.
- Report estimated visible post-cut tokens and fall back above the new 80k target
  (`maxPostCompactTokens`, 0 disables it). Count tool output once, excluding mirrored
  assistant summaries, and rebuild hidden blocks out of accepted replacements.
  Evidence: the study found character reductions did not predict post-cut size.
  This is a conversation estimate, excluding the system/tool prefix.
- Preserve surrogate pairs when slicing and repair malformed source strings before
  JSON serialization. Evidence: #128 identifies split emoji in state and result
  cuts, rejected by Jev as invalid Unicode. Reject out-of-range probabilities too.
- Add a short supporting-evidence marker for fully removed tool calls. Evidence:
  #123 reports an earlier grounded answer being mistaken for fabrication after
  its supporting calls disappeared.
- Make decision logging opt-in (`logDecisions`, false). Include kept calls' two
  probabilities and text scores when enabled; never log arbitrary tool output or
  transport error details. Evidence: PR 146's repeated multi-line diagnostic
  output and the study's inability to size the keepThreshold trial. Adapted from
  [chen-QaQ's PR 146](https://github.com/tamaratran/fast-jev-compaction/pull/146).
- Guard overlapping main-turn completions after their asynchronous usage reads;
  subagent completions cannot compact the main session. Evidence: code review
  found the previous global flag was checked only before the usage await.

The user's 0.7 keepThreshold trial remains a settings choice and is unchanged.
All release metadata (plugin, marketplace, npm package and lockfile root) is 0.4.0.
