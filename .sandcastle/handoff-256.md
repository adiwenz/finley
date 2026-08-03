# Handoff — issue 256

Whole-issue mode (no declared tasks). I split it into two parts:

**Done so far:**
- **Part 1 — engine preview method (committed):** `Projection.runAtStopWorkingAge(jurisdiction, age)`
  returns a full read-only `ProjectionResult` with every earner's job ceased at `age`, reusing the
  `StopWorkingBoundary` (full mode) from #243. Non-destructive — the plan is never mutated.

**Remaining:**
- **Part 2 — app preview toggle:** a control (on the retirement panel) to swap the net-worth and
  income charts between the authored plan and the "if everyone stops working at the solved headline
  age" preview.

## Live constraints
- The preview age to use is the solved **full**-retirement headline: `retirementView(...).headlineAge`
  (null when no age is feasible → no preview to offer; hide the toggle). Its month form is
  `headlineMonth` (already fed to `NetWorthChart` as the "Retire" reference line).
- Only `mode: "full"` is exposed to app callers (`fullStopWorkingBoundaryAt`); a "both stopped
  working" preview is the full-retirement question, never partial.
- The preview must stay a *view* over the authored plan: keep authoring/editing panels
  (snapshot, goals, add-event, budget/job editing via `transact`) on the AUTHORED `result`. Only the
  chart-feeding `series` should swap. Editing while previewing still writes the real plan and the
  preview recomputes from it — that composition is intended, don't fight it.
- Capping only ever *shortens or extends the primary's* working life via `retirementTargetAge`
  stand-in (see `packages/engine/src/projectionBase.ts:236` and `householdJob.ts`); a candidate at/above
  the authored stop that equals the natural end is a no-op. Fine — just know preview==authored is
  possible for some plans.

## Wiring notes for Part 2
- `main.tsx` `App()` already holds `projection` (memoized `Projection.fromState`) and `retirement`
  (the `retirementView`). Compute the preview via `projection.runAtStopWorkingAge(usJurisdiction, headlineAge)`
  in a `useMemo` keyed on `[projection, headlineAge]`; guard `headlineAge != null`.
- `NetWorthChart` takes `series`; the income chart lives inside `BaseAdjustmentsPanel` (its `series`
  prop). Swap both to the preview series when previewing.
- App integration tests: `packages/app/src/mainState.test.tsx` (jsdom + testing-library, renders
  `<App/>`). Component render tests use `@vitest-environment node` + `renderToStaticMarkup`
  (see `retirementPanel.test.tsx`).

## Dead ends / deferred
- None yet.
