# Changelog

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
  handles; our full raw-transcript read finds 153,422 / 115,832 assistant IDs
  reused across boundary segments. First cut after startup uses the built-in
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
