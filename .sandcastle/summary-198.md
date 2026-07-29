# Issue 198 — Don't name an engine-internal class in app prose (monthEdit doc)

## Overview

The `applyLineOverride` JSDoc in `packages/app/src/components/baseAdjustments/monthEdit.ts`
explained the "from-here-forward supersedes later edits" semantics by naming
`SimCashFlowSeries.addOverride`. That class is **engine-internal** — it is not barrel-exported
from `@finley/engine`, so an app-side comment reaching for it invents a dependency on
something the app can never import. The doc was reworded to describe the same behavior in
app/public terms (the budget compiler erases the schedule at and after the edited month),
without naming the internal class.

## RGR Verification Details

- **RED:** Added `explains supersession without naming any engine-internal class` to
  `monthEdit.test.ts`. It reads `monthEdit.ts` off disk and asserts the source does not
  contain `SimCashFlowSeries`. With the original prose in place the test failed exactly on
  that assertion (1 failed | 16 passed).
- **GREEN:** Reworded the JSDoc — replaced `compileBudget` / `SimCashFlowSeries.addOverride`
  with "the budget compiler replays overrides in array order and each one erases the schedule
  at and after the month it lands on." The guard test then passed (17 passed).
- The runtime behavior the doc describes was already pinned by the existing
  `lets a 'from here forward' edit supersede every later override on that line` test, so no
  behavioral change was needed — only the prose.

## Key Decisions & Why

- **A source-string guard rather than a behavioral test.** The acceptance criterion is a
  documentation constraint (no engine-internal class named in app prose), so the seam under
  test is the file's text. The guard pins the architectural boundary: a future reword sliding
  back to the internal name will fail CI. It reuses the node test environment (the default for
  `monthEdit.test.ts`) and resolves the file via `import.meta.url`, so it needs no config.
- **Kept the description in public terms.** "The budget compiler … erases the schedule at and
  after the month it lands on" states the observable effect without leaning on any private
  symbol, matching the wording the issue asked for.

## Changes Made

- `packages/app/src/components/baseAdjustments/monthEdit.ts` — reworded the `applyLineOverride`
  JSDoc to drop the `SimCashFlowSeries` / `compileBudget` references; behavior unchanged.
- `packages/app/src/components/baseAdjustments/monthEdit.test.ts` — added a regression guard
  asserting the doc names no engine-internal class; imported `node:fs` / `node:url` to read
  the source.

## Verification & Testing

- `npm run check` (purity guard + `tsc --noEmit` + `vitest run`): **1073 tests passed**,
  45 todo, 85 test files — all green.
- Focused file: `monthEdit.test.ts` — 17 passed.
