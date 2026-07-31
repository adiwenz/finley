# Issue #113 — Let users set the employer 401(k) match % in the Jobs form

## Overview

The engine already supported an **employer 401(k) match** end to end
(`JobDeferral.employerMatchFraction`, deposited on top of the employee deferral in
`waterfall.ts`, free of the elective limit), but there was **no way to set it in the app** —
the Jobs form had no control, so a match could only reach a plan via a fixture. This change
adds a first-class authoring control: a user enters the match in the Jobs form's **Advanced**
section, it round-trips through add/edit, feeds the projection, and shows on the job's
summary row. Plans with no match are untouched.

## RGR Verification Details

Two seams, each driven red→green:

1. **The draft ↔ job seam** (`planPeople.ts`, unit-tested in `planPeople.test.ts`).
   - **RED:** eight new specs asserting `employerMatchPct` reads back off a job, sets the
     fraction on the way in only when there's a deferral to match, drops the key at 0%,
     overwrites a prior value on edit, and round-trips — all failing (`undefined`) against
     a `JobDraft` with no match field.
   - **GREEN:** added `employerMatchPct` to `JobDraft`, read it in `jobToDraftFor`, and wrote
     it from the draft in both `applyJobDraft` and `jobInputFromDraft`.

2. **The Jobs form + panel row** (`jobForm.tsx` / `jobsPanel.tsx`, integration-tested in
   `jobsPanel.test.tsx`).
   - **RED:** three new specs — author a match through the form and see it on the plan and
     the row, read it back into the edit form, and show no "match" text when there is none.
     Wiring `applyJobDraft` to the draft in step 1 also (correctly) turned the two existing
     reassignment tests red, because an untouched edit dropped the match until the form
     carried it.
   - **GREEN:** added the "Employer match" `NumInput` to the Advanced section (seeded from,
     and submitted back into, the draft) and extended the row's deferral line to append
     `· NN% match`. The new specs and both reassignment tests went green together.

Full gate green: `npm run check:purity`, `npm run typecheck`, and `npm run test`
(**1300 passed | 45 todo**).

## Key Decisions & Why

- **`employerMatchPct` is a required `number` (0 = none), not the optional field the issue
  sketched.** It mirrors the sibling `deferralPct` exactly, so every draft constructor and
  the form bind a number rather than juggling `undefined`. The engine's
  `employerMatchFraction` stays optional; the app just never emits the key at 0%.
- **The match is now form-authored, not carried through.** `applyJobDraft` previously
  preserved a job's existing `employerMatchFraction` blindly; it now writes the draft's
  value, so a user can raise, lower, or clear it. The round-trip (`jobToDraftFor` reads
  50 ← 0.5, the form carries it, `applyJobDraft` writes 0.5 ← 50) keeps a match intact
  across an edit that never touches it — which is exactly what the reassignment tests pin.
- **The match reads straight off `job.deferral`, not through a projection facade.** Unlike
  pay and deferral (overridable, so read via the facade), the match isn't overridable — so
  it's read directly, the way `realGrowthPct` is.
- **Gated only when there's a deferral to match.** A match with 0% deferral contributes
  nothing (it's a match *of* the contribution), so the key is emitted only when both the
  deferral and the match are positive. Capped at 200% in the form — generous plans rarely
  exceed dollar-for-dollar, and employer money bypasses the elective limit already.

## Changes Made

- `packages/app/src/planPeople.ts` — added `employerMatchPct` to `JobDraft` and
  `blankJobDraftFor`; `jobToDraftFor` reads it off `job.deferral`; `applyJobDraft` and
  `jobInputFromDraft` write `deferral.employerMatchFraction` from the draft (only with a
  deferral and match > 0). Refreshed the `applyJobDraft` doc comment.
- `packages/app/src/components/jobsPanel/jobForm.tsx` — carry `employerMatchPct` through the
  form's internal draft and submit; new "Employer match" control in the Advanced section.
- `packages/app/src/components/jobsPanel/jobsPanel.tsx` — the deferral row now appends
  `· NN% match` when a match is set.
- `packages/app/src/planPeople.test.ts` — new `employer 401(k) match` describe block (8 specs).
- `packages/app/src/components/jobsPanel/jobsPanel.test.tsx` — three new panel specs.

## Verification & Testing

- `npm run check:purity` — passed (engine stays I/O- and app-free).
- `npm run typecheck` — passed.
- `npm run test` — **1300 passed | 45 todo** across 98 files.

## Acceptance Criteria

- [x] A user can enter an employer match % in the Jobs form and it round-trips (add/edit).
- [x] The match increases retirement-account deposits without counting against the elective
  limit (engine-owned in `waterfall.ts`; the authored fraction now reaches it — pinned by
  the reassignment projection test).
- [x] The match is visible on the job's summary row.
- [x] Existing plans with no match are unchanged.
