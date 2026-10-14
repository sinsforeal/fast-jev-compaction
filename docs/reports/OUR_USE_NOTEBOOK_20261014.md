# Fork ownership notebook, 2026-10-14

Branch `fix/our-use-20261014`, worktree `tmp/wt_our_use_20261014`.

Estimate 180 to 240 minutes; Codex (sol requested by coordinator). Started about
06:51 local, America/Indianapolis. No engine change, no live service or venue
access, no installed plugin edits, no settings edits or threshold change.

## Current stage

Implementation built; 62 Vitest cases, library and hook typechecks, and build pass.
Pinned before-revision gates and independent review are next. The supplied root Git metadata rejected worktree
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

## Scratch

tmp/evidence holds upstream issue JSON, PR patches and code-only runtime slices.
tmp/npm-cache holds npm downloads; node_modules and dist are generated. Keep until
release review, then coordinator may prune. No raw user transcript text will be
committed; regression fixtures must contain only sanitized shapes and counts.

## Stop plan

Finish a piece, commit with explicit paths and push this branch to the fork.
If stopped, terminate only this task's processes, update this document and the
trading notebook, preserve tests and evidence and report publication failures.
Ryan v2 owns release promotion, settings switch and next-day checks under the
existing brief. No detached task or watch currently runs.
