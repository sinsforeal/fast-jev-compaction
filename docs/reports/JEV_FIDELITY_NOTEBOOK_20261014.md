# Jev 0.4.1 fidelity notebook, 2026-10-14

Branch `fidelity/jev-041-20261014`, worktree `tmp/wt_jev_041_20261014`.
Publication: push HEAD to `origin/fix/our-use-20261014` after each commit.
Started 09:35 local (America/Indianapolis), estimate 90 to 120 minutes.
Model Codex GPT-6, sol requested. Task-specific npm validation supersedes trading
pytest routing. All edits stay in this fresh fork worktree or the named trading
docs worktree; installed copies/settings, main, services and venues untouched.
Write connector tested offline; content uses patch editor, no shell heredoc.

## Current stage

Implementation and 95 tests green; typecheck green. Version/docs updated to 0.4.1.
Before evidence: initial nine new tests fail by assertion on clean 4cc723a.
Full pinned-before receipt, final build/scanner and independent re-review follow.

## Findings, attempts and failures

0.4.0 sets a startup coreRequired flag, then summary on mid-turn delivery,
subagent, depth and reduction. Removed all five blanket routes; depth/reduction
warn only. New observer ledger pins full rendered instructions/context and queued
text, with stable identities/order across cuts and in-flight arrivals. Old 70
tests kept; eight changed policy assertions have inline brief reasons.
First whole suite exposed stale 0.4.0 assertions and fixture snapshot omissions;
adapted them. Missing-observer fixture initially had all rows recent/pinned and
made zero requests; changed its recent window to exercise the intended path.

Independent read-only reviewer found equal-text rebasing, provisional/canonical
delivery duplication, context sharing and in-flight supersession defects. Fixed
them with serial pin identities, exact occurrence counting, stable order fractions,
queued-command provenance checks and grouped projection claims; adversarial gates
cover each. The requested haiku helper model is unavailable; helper inherited Codex.

Reviewer found actual 2.1.299 supports `session.messages({agentId, as:'api'})`,
unlike generated 2.1.274 declarations. W2o/IXt supply a bounded normalized tail;
kpe/bpe omit queued attachments and vjt builds only text/tools. Added supplemental
contract and anchor-aligned recovery of historical user text, retaining the older
prefix. Generated declarations unchanged. Opaque user blocks cannot be carried by
that handleless schema: explicit per-cut fallback logs this demonstrated reason,
then clears only rows covered by a successful core cut; skipped/failed core cuts
retain them and newer arrivals survive the checkpoint. This is the brief 2
exception, not a standing startup/resume/subagent flag.

## Scratch and stop plan

Keep ignored tmp/ host-inspection sources/receipts, gate logs, node_modules and
dist for coordinator review/release. No API request, raw transcript copy, watcher
or background job. If interrupted: explicit-path commit finished changes, push
HEAD to origin/fix/our-use-20261014, update this notebook and trading notebook;
coordinator resumes final gates and the existing release queue 0f83ff731638.
Never promote the default branch or install from this agent session.
