# Changelog

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
