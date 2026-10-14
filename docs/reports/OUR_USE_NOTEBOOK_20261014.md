READY: code 7e41d5bf65a2e9a732669ca8a945c31ce1c4ae43 (local)

# Fork ownership notebook, 2026-10-14

Branch `fix/our-use-20261014`, worktree `tmp/wt_our_use_20261014`.

Estimate 180 to 240 minutes; Codex (sol requested by coordinator). Started about
06:51 local, America/Indianapolis. No engine change, no live service or venue
access, no installed plugin edits, no settings edits or threshold change.

## Current stage

Implementation complete and independently reviewed; 70/70 Vitest cases, library
and hook typechecks, build and whitespace gates pass. Seven regression twins fail
7/7 on base b442e6c. Actual manifest/hook scanner validates 2.1.299 registrations.
Code commit 7e41d5b; the final independent checks passed07:34 local. The supplied root Git metadata rejected worktree
creation, so this is an independent local clone inside the requested tmp/ root.
The trading docs worktree cannot acquire its common-directory index lock either;
its reports remain on disk for coordinator publication.

## Findings and attempts

Fork base b442e6c contains the user's Cloudflare/retry fixes. Manifest is 0.3.0,
package is 0.2.0. Upstream #129 traces assistant duplication to reused handles;
#145 traces resume loss to reused rows outside the new parent chain; #137 traces
pair repair to mixing rebuilt and original siblings. #133 concerns invisible
queued attachments. Runtime inspection is read-only on the installed executable.

gh cannot read the user's config; public issues and PR patches retrieved using
unauthenticated Node fetch, without reading or printing credentials. PRs 141 and
146 were reviewed: text/state/types/test portions of PR 141 adapted with previews,
stricter recognition and Unicode cuts; opt-in logging concept from PR 146 adapted.
Current runtime independently verified by a read-only helper. Every retained handle
can preserve stale parents and assistant IDs; every replacement now rebuilds all
visible rows and groups adjacent parallel siblings. Speculative precompute is
vetoed before any network/UI side effect. Queued deliveries are observed using a
supplemental 2.1.299 contract; original full input goes to core on those cuts.

Trading initial notebook commit failed acquiring the common index lock. External
initial commit 666f5ef succeeded; its push failed because GitHub credentials are
unavailable. GitHub connector confirms fork access but rejected branch creation:
approval is required and this session's approval policy is never. No bypass tried.

The first raw-transcript probe retained full rows and was stopped with Ctrl-C;
no result from that attempt counts. The helper instead streamed count-only
identity records. Broader current-transcript counts are distinct from the held
study cutoff. Named debug files are absent, so historical triggers are not proven.
The final raw-source read found20,103/19,966 globally unique recurring assistant
IDs. The helper's153,422/115,832 count is identity/segment occurrences, corrected
in CHANGELOG and the trading report. Current raw row counts732,588/721,689 are a
later cutoff than the cache study and are not mixed into its totals.

Independent review caught state previews being lost while questions still scored
the blocks and Vitest discovering the nested before-worktree. Fixed both; also
guarded strict indexed access and normalized files to LF. Support is2.1.299;
wrapper recognition/media projection/historical trigger limitations are documented.

Isolated marketplace source-switch QA proved update alone can fail not_configured
after replacing the source. Explicit marketplace add for the fork then update
succeeds. The report includes that exact sequence. No real install changed.

## Scratch

tmp/evidence holds upstream issue JSON, PR patches and code-only runtime slices.
tmp/npm-cache holds npm downloads; node_modules and dist are generated. Keep until
publication/acceptance to reproduce gates offline. tmp/wt_before pins b442e6c;
tmp/baseline-gates.json records7/7 failures; tmp/claude-qa isolates CLI catalog
tests; tmp/our-use-20261014.bundle is the publication fallback. No raw user transcript text will be
committed; regression fixtures must contain only sanitized shapes and counts.

## Stop plan

Finish a piece, commit with explicit paths and push this branch to the fork.
If stopped, terminate only this task's processes, update this document and the
trading notebook, preserve tests and evidence and report publication failures.
Ryan v2 owns release promotion, settings switch and next-day checks under the
existing brief; trading queue0f83ff731638 now owns the whole release sequence.
No detached task, helper or watch remains running. Coordinator can push this
branch from its clone (or fetch the preserved bundle), then commit/land the
trading documents from their worktree or exported patch. Settings/install/three
pinned resumes and2026-10-15 acceptance follow the report; failed acceptance uses
its exact0.3.0 rollback under the same owned item.
