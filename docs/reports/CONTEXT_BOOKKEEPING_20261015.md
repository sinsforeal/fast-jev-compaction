# Context bookkeeping reduction, 2026-10-15

Release: 0.5.6. User request: reduce the repeated Jev removal notices, model-visible pin-provenance JSON, and automated-event warning text seen in Pick Assist. The source is based on installed 0.5.5 (24516c3), not the older fork checkout.

## Result

The library consolidates exact standalone assistant removal notices into one history-level supporting-evidence warning. Detailed tool decisions remain available in diagnostics. Quoted, fenced, pinned or otherwise ambiguous examples are preserved.

The hook migrates pin fingerprints and occurrence numbers to the host's persistent plugin store under a session-and-child-specific key. Pin records carry notification-text policy but no message contents. Writes are verified before returning replacement history. Previous fingerprints remain available if the host rejects a prepared replacement. Inline provenance remains a safe fallback when storage is unavailable, corrupt, full, or fails verification. Missing records protect user text conservatively, while tool-only result rows remain eligible for normal compaction.

Only the exact generated background-event preamble is shortened. Human submissions are recorded verbatim, including raw pasted warning reproductions, and this policy persists across restart. Legacy records have no origin: only warning-only fragments after recognized prefixes are eligible. Event payloads, independent instructions, their occurrences and their order remain intact. Unknown wrappers remain unchanged.

The acceptance ratio includes bookkeeping removed from the original incoming history. Session changes isolate the in-memory observer ledger. Events accepted during scoring, mode lookup, persistence or final diagnostics are restored; events arriving after the external write receive inline pins synchronously, avoiding another asynchronous persistence race.

## Verification

- Full suite: 194 tests across 14 files. TypeScript library and hook checks, library build, manifest/hook loader validation and whitespace check passed.
- New regressions cover repeated compaction, migration, four cold restarts, identical instructions at separate occurrences, main/child/session isolation, missing and corrupt storage, rejected and unacknowledged writes, rejected prepared replacements, original-size reduction accounting, human pasted examples and late arrivals during persistence and mode lookup.
- Two implementation agents handled notice aggregation and notification matching. Two independent review agents checked integration. Review findings were fixed: missing-store pin loss, human-example rewriting, bookkeeping savings excluded from the ratio, and a delivery-loss race during the hybrid-mode lookup. The race reproduction changed from `delivered:true, retained:false` to `delivered:true, retained:true` after the fix and has a regression test.

## Pick Assist replay

Read-only source: `C:/Users/zenzen/.claude/projects/F--REPS2-Pick-Assist/0d88f1f6-b8da-424f-bd53-32e3376838c8.jsonl`. Followed the latest saved parentUuid chain rather than counting old transcript branches. Projected visible message rows numbered 416 before and 358 after the host rebuild. All 147 legacy pin fingerprints matched.

The replay used a local keep-everything scorer and disabled the target loop to isolate bookkeeping changes. It made no network request and did not write the transcript or production plugin store. Estimated visible tokens fell from 150,448 to 132,056, a reduction of 18,392. These are the plugin's estimates, not Claude's exact tokenizer or total prompt context.

Text scanning counted 354 removal-notice strings before and 8 after; the remaining strings include preserved ambiguous/quoted cases and the one new global warning. The provenance row fell from one to zero. Full warning copies fell from 17 to 4; the four untouched cases have unrecognized preceding wrapper combinations. This intentionally preserves uncertain text rather than stripping it broadly.

Assertions verified user-text order and contents against the expected exact warning-only substitutions. Tool calls and results were identical to the existing host projection (which already normalizes missing error flags and empty results). Scratch replay and race reproductions are under `F:/temp/jev-bookkeeping-replay.ts` and `F:/temp/jev-review-target-race.mts`.

## Runtime acceptance and rollback

The installer archives a committed release, verifies plugin source bytes, and saves the previous installed-plugin record in Meta_Orchestrator's `var/`. Existing sessions take the new package on their next restart or plugin reload; cleanup occurs on their next accepted Jev compaction. Do not edit or prune a running session's JSONL file. An installed-package loader smoke check and the next accepted Pick Assist compaction provide separate runtime receipts; offline replay alone does not prove a live cut occurred.

Retain the 0.5.5 cache and previous installer record for rollback. No thresholds, API keys, or handoff settings change with this release. The native plugin store has a documented total 4 MiB limit; reaching it retains inline pin records instead of losing protection. Old session records are not automatically deleted because those sessions may be resumed.
