# Summary — Issue #232: New jobs should choose their owner before initializing age-based fields

## Overview

The Add Job form's `startAge` defaulted to the initially-selected owner's current age, but never
re-read when the user changed **Whose job?** to a different household member. Because every age
in the form is relative to the selected owner, the stale `startAge` silently reinterpreted the
job as historical or future employment for the new owner. Fixed by resetting `startAge` to the
newly selected owner's current age at the point the owner picker changes.

## RGR Verification Details

- **RED:** Added `jobForm.test.tsx`, a component-level test isolating `JobForm` with two owners
  of different ages (35 and 40). Four cases — switch to an older owner, switch to a younger
  owner, switch after a manual edit, and the submitted draft — all failed against the
  pre-fix component: `startAge` stayed pinned to whichever owner the form opened on.
- **GREEN:** Added a `startAge` reset inside the owner `<select>`'s `onChange` handler in
  `jobForm.tsx`, driven off the newly selected `JobFormOwner.currentAge`. All four new tests
  passed.
- One existing integration test in `jobsPanel.test.tsx` ("adds a job for the partner…") had been
  asserting against the *buggy* behavior: it entered a value into "Monthly salary now", a field
  that only appears when the job has history — which the bug incidentally created by leaving the
  primary person's start age in place after switching to the (older) partner. With the fix, the
  new owner's start age matches their current age, so the job legitimately opens with no history,
  and the field becomes plain "Monthly salary". Updated that test's field lookup and added an
  explicit `startYear` assertion so it now pins the *correct* owner-relative month.

## Key Decisions & Why

- **Reset inline in the `onChange` handler, not a `useEffect`.** The owner change is a discrete
  user interaction with a single, well-defined consequence (per Vercel React best practices:
  interaction logic belongs in the event handler that causes it, not in an effect watching
  derived state). No effect, no extra render.
- **Only `startAge` is reset, not `endAge`.** `endAge` is seeded from a fixed conventional
  default (`DEFAULT_JOB_END_AGE = 65`), not the owner's age, so it carries no owner-relative
  meaning to invalidate. It is already clamped to the new owner's `lifeExpectancy` on submit.
  Every other owner-relative quantity on the form (`hasHistory`, `endedBeforeNow`, `maxStartAge`,
  `ownerAge`, `ownerLifeExpectancy`) is derived at render time from `draft.startAge` and the
  selected owner, so once `startAge` is correct, those recompute automatically — no separate
  reset needed for them.
- **Scope stayed local to `JobForm`,** per the issue's implementation notes — no changes to the
  job/event model, which still treats a submitted `startAge` as intentional input.

## Changes Made

- `packages/app/src/components/jobsPanel/jobForm.tsx`: the owner `<select>`'s `onChange` now
  looks up the newly picked `JobFormOwner` and patches `draft.startAge` to that owner's
  `currentAge`, in addition to updating `ownerId`.
- `packages/app/src/components/jobsPanel/jobForm.test.tsx` (new): isolated coverage for the
  owner-picker reset — older→younger, younger→older, reset overriding a manual edit, and the
  submitted draft carrying the new owner's age.
- `packages/app/src/components/jobsPanel/jobsPanel.test.tsx`: updated the partner-add test's
  field lookup to match the post-fix "no history yet" state, and added a `startYear` assertion
  confirming the job starts at the correct owner-relative month.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — clean.
- `npx vitest run` — 1847 passed, 45 todo; the only 2 failures are in
  `packages/engine/src/testing/comments.guard.test.ts`, confirmed pre-existing on `main` (unrelated
  doc-guard assertions), not touched by this change.
- `packages/app/src/components/jobsPanel/` suite (jobForm, jobCard, jobsPanel): 45/45 passing.
