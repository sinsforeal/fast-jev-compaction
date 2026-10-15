# Jev 0.5.7 live delivery correction, 2026-10-15

Scope: release implementation and local verification. Deployment receipts belong
to the Meta Orchestrator handover and installation report.

## Evidence and cause

The parent live audit found a 10:06:33 accepted cut of session
`4cd6d273-3a66-412c-9dd1-bd16dacd669d`, from 219,738 to 19,075 engine tokens.
The active parent chain had one consolidated evidence warning, no old per-tool
warnings and no inline pin provenance. The durable store held 70 pins.
The 57 fidelity log lines were system/informational UI rows, outside user and
assistant model content. This confirms the 0.5.6 bookkeeping change for that cut.

The warnings nevertheless exposed a real observer bug: Claude Code 2.1.300
delivers API blocks with `type: "text"`, whereas the supplemental contract and
ledger recognized only `kind: "text"`. Ordinary text was classified as opaque,
then omitted from the observer ledger. Other recovery paths retained the text
in the audited cut, but relying on those paths left hidden deliveries unprotected.

## Change

0.5.7 accepts both text forms with string text, joins text blocks in source order,
and retains the existing delivery, chronology, child-scope and pin policies.
An explicit opaque `kind` remains opaque even when `type` says text. Missing or
non-string text is never coerced into an instruction.

Routine opaque-block receipts now go only to the existing bounded disk log.
Warnings about missing content or chronology, errors, skipped-cut notifications,
cut summaries and applied measurements remain visible. No transcript rewriting,
threshold changes, provider changes or media reconstruction are introduced.

## Checks and trials

- `npm ci --no-audit --no-fund` installed the locked development dependencies.
- First full run found two expectations for missing-content/chronology warnings.
  Refined routing to keep these warnings visible, while expected opaque receipts
  remain disk-only; this preserves useful error reporting.
- `npm test`: 203 tests passed across 15 files, including nine new wire tests.
- `npm run typecheck`: library and hook checks passed.
- `npm run build`: passed.
- `npm run validate:plugin`: Claude scanned all four registered hook events and
  passed; existing managed-policy/gating notices remain unchanged.

The new hook replay intentionally supplies no delivery text in either projected
or API history. Only the observer can save the instruction. It verifies exact
retention and order, handleless rebuilding, durable pin storage, absence of inline
metadata, a cold restart, disk-only opaque receipts without payload leakage, and
a current-format child delivery arriving during the Jev request without leaking
to the parent or sibling. Seven block cases cover current/legacy text, explicit
opaque kinds, non-text types and missing/non-string text.

## Deployment limit

These are deterministic registered-hook tests using the observed native wire
shape and a fake Jev scorer. They exercise returned replacement rows and durable
pin recovery, not the host's transcript installer. Installation and a fresh native
loader receipt are separate deployment checks. Already-running sessions need
plugin reload or restart to adopt updated hook code; cache-file changes alone
have not been verified to replace an in-memory registered hook. The audited
accepted cut ran 0.5.6.
