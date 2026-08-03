# Summary — issue #244: Remove estimate-history and job reassignment

## Overview

Two deletions called for by PRD #242's Out of Scope section, both independent of the
compensation-model change and done first to shrink its surface. Both remove capabilities the
new dated-salary model makes redundant or incoherent:

1. **Estimate-my-history** — the bulk action that filled a job's unstated past pay with
   inflation-tracking figures, the `estimated` "this was filled in" marker it stamped, its
   button + explain-panel, and the distinct row styling. Salary segments keeping pace with
   inflation now cover what it was for.
2. **Job reassignment** — a job can no longer change owner. The named `reassignJob` operation is
   gone from the facade and the authoring layer, and the general edit patch (`JobPatch`) no
   longer carries `ownerId`, so no edit path can restate an owner. Moving a job between household
   members is delete-and-re-add.

Delivered in two commits (whole-issue mode, split into two independent parts):
`RALPH: Remove estimate-my-history …` and `RALPH: Remove job reassignment …`.

## RGR Verification Details

This is deletion work, so verification is inverted: the guarantee is that removing each
capability changes no behaviour that remains, held by the surviving suites going green.

- **Estimate-history.** The `estimated` flag was display-only — the engine already treated a
  filled-in change identically to a stated one — so its removal is behaviour-preserving for the
  projection. The engine tests proving historical pay is *flat* (RED would be a past year that
  grows on its own) are kept, retargeted onto authored dated changes; only the tests exercising
  the deleted estimator itself were dropped.
- **Reassignment.** Removing `reassignProjectionJob`/`Projection.reassignJob` left the
  `jobOwnership.guard.test.ts` scans (app must name no reassignment path) green, and they now
  also assert the engine no longer keeps the operation. Tightening `JobPatch` to drop `ownerId`
  is guarded at compile time by a new `@ts-expect-error` in `authoringInputs.guard.test.ts` (if
  `ownerId` ever returns to the patch, the directive goes unused and the build fails) and at
  runtime by a rewritten facade test asserting an edit preserves the owner.

Final: `npm run check` green — 110 test files, 1559 passed (45 todo).

## Key Decisions & Why

- **The `estimated` flag was purely presentational, so deleting it needs no compiler change.**
  `compilePersonPriorEarnings` never read it; it existed only so a surface could label a figure.
  Removing it from `JobPayChange` and every surface leaves the projection identical.
- **`JobPatch` drops `ownerId` as well as the named `reassignJob` op.** The issue's governing
  invariant is "a job cannot change owner," and `updateJob({ ownerId })` was a second, latent
  reassignment path — one that produced an *inconsistent* state (owner set to a partner while the
  job stayed on the plan plane, never moving to their event). It was reachable by no shipping code
  (the app's `jobInputOf` already strips `ownerId` on every edit), so removing it from the patch
  type makes the engine agree with what the app already enforces, with no behaviour change to any
  real edit. This is slightly broader than the literal "remove the operation" wording but is what
  the stated invariant requires; leaving it would keep a test literally named "reassigns a job to
  another owner" passing on a branch whose thesis is that jobs cannot be reassigned.
- **Kept the app-side reassignment guard, corrected its premise.** `jobOwnership.guard.test.ts`
  still bans any reassignment path from re-entering the app; only its header comment changed
  (the engine no longer keeps `reassignProjectionJob`).

## Changes Made

**Engine**
- `job.ts` — dropped `JobPayChange.estimated` and the `estimateHistoryPayChanges` function;
  narrowed `JobPatch` to `Omit<Job, "id" | "ownerId">` and simplified `withJobPatch`.
- `index.ts` — dropped the `estimateHistoryPayChanges` re-export.
- `authoring/jobs.ts` — removed `reassignProjectionJob` and the now-unused `isPartner` helper and
  `PRIMARY_PERSON_ID` import; reworded the module/`JobInput`/`addProjectionJob` docs.
- `projectionFacade.ts` — removed `Projection.reassignJob` and its import; reworded the class and
  `write`-primitive doc-comments.
- `compilePerson.ts` — reworded the historical-flatness doc-comments.
- Tests: `job.test.ts`, `authoring/jobs.test.ts`, `projectionFacade.test.ts`,
  `authoringInputs.guard.test.ts`, `index.guard.test.ts` — dropped tests for the removed
  features, kept and retargeted the flatness/ownership coverage, added the `ownerId`-rejection
  compile guard.

**App**
- `components/jobsPanel/jobsPanel.tsx` — removed the "Estimate missing pay history" button,
  explain-panel, `estimate` authoring variant and handler, and unused imports.
- `components/jobsPanel/payTimeline.tsx` — removed the `estimated` row field and its tag.
- `components/jobsPanel/jobsPanel.module.css` — removed `.entryEstimated` and `.estimatedTag`.
- `components/jobsPanel/jobForm.tsx`, `planDefaults.ts` — reworded hint/doc text.
- Tests: `components/jobsPanel/jobsPanel.test.tsx` (dropped the estimate test),
  `jobOwnership.guard.test.ts` (corrected header), `planWrites.guard.test.ts` (dropped the
  `reassignProjectionJob` internal-name entry).

## Verification & Testing

`npm run check` (purity + typecheck + full suite): **110 test files, 1559 passed, 45 todo.**
