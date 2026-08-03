# Issue #256 — Preview the solved retirement scenario's charts without committing

## Overview

The retirement panel only reported numbers; there was no way to *see* the household's net-worth
and income charts under the "what if everyone stopped working at the solved age" scenario without
destructively pinning that age in the plan and re-running. This branch adds a non-destructive
preview: an engine method that projects at an arbitrary stop-working age, and an app toggle that
swaps the net-worth and income charts to that preview and back.

The series the user wants was already being computed and discarded by the retirement solver (each
candidate age runs a full `projectScenario`). Rather than surface the solver's internal winner, we
added a clean facade door that runs the same non-destructive `StopWorkingBoundary` (from #243) on
demand — so the charts read one preview pass exactly as they read one authored pass.

## Key Decisions & Why

- **A facade method, not a leaked solver series.** `Projection.runAtStopWorkingAge(jurisdiction,
  age)` returns a whole read-only `ProjectionResult` (series + household + report), so both charts
  (and anything else) read a single preview pass. Surfacing the solver's discarded candidate series
  would have coupled the app to a search internal and only ever offered the *solved* age; a facade
  method takes any age, covering the "user-chosen age" the issue anticipates for #254.
- **Reuse the boundary, rewrite nothing.** The preview runs through the same full-mode
  `StopWorkingBoundary` the solver already searches with — it caps compiled job spans, never edits
  a job — so the authored plan is byte-for-byte untouched and the toggle can flip freely. Only
  `mode: "full"` is exposed (`fullStopWorkingBoundaryAt`): "both stopped working" is the
  full-retirement question, never the partial one.
- **Preview is a view, not a state.** The toggle is a pure `useState` flag in `App`; it swaps only
  the *chart* series. Every authoring/editing surface (snapshot, goals, add-event, budget/job edits)
  stays on the authored run, so editing while previewing writes the real plan — and the preview
  recomputes from it, which is the intended composition.
- **No feasible age → no toggle.** When `headlineAge` is null (no age survives), there is nothing
  to preview, so the toggle is hidden and a stale preview flag falls back to the authored series.

## RGR Verification Details

- **Engine (Part 1):** RED — `p.runAtStopWorkingAge` did not exist (`is not a function`). GREEN —
  added the method + optional `stopWorking` on `runProjection` + `fullStopWorkingBoundaryAt`. Tests
  assert (a) capping at 45 zeroes wages by age 50 while the authored run still earns and the state
  object is unchanged, (b) a candidate above the authored stop *extends* the open-ended job, (c) a
  whole frozen result comes back under the run jurisdiction.
- **Panel (Part 2):** RED — the toggle was absent (`checkbox`/`checked` not in markup). GREEN — the
  panel renders a checkbox naming the headline age when feasible, reflects the `previewing` prop,
  and hides entirely when `headlineAge` is null.
- **App (Part 2):** RED — clicking a non-existent toggle threw. GREEN — at age 70 (month 420) the
  authored income (retired at 65) rises when previewing (working to 76) and returns exactly on
  toggle-off, proving the swap is non-destructive.

## Changes Made

- `packages/engine/src/projectionFacade.ts` — `runAtStopWorkingAge(jurisdiction, age)`.
- `packages/engine/src/projectionRun.ts` — optional `stopWorking` boundary on `runProjection`.
- `packages/engine/src/retirementSolver.ts` — `fullStopWorkingBoundaryAt` export + shared
  `stopWorkingBoundaryYear` helper.
- `packages/app/src/main.tsx` — `previewRetirement` state, memoized `previewResult`, `chartSeries`
  swap feeding `NetWorthChart`, the net-worth breakdown, and the income chart (`BaseAdjustmentsPanel`).
- `packages/app/src/components/retirementPanel/retirementPanel.tsx` — `previewing` / `onTogglePreview`
  props and the toggle UI, shown only when a headline age is feasible.
- `packages/app/src/assets/styles/globals.css` — `.preview-toggle` row layout.
- Tests: `projectionFacade.test.ts` (3), `retirementPanel.test.tsx` (3), `mainState.test.tsx` (1).

## Verification & Testing

- `npm run check:purity` — engine purity holds.
- `npm run typecheck` — clean.
- Full `vitest run` — **1606 passed, 45 todo (113 files green)**.
