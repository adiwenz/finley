# Handoff — issue 269

**Done so far:** Tasks 1–3 (exploration rule in `AGENTS.md`, the REPL, the implement prompt, all
pinned by `comments.guard.test.ts`), Task 4 (`planFixtures.ts` over `replaceJob`), Task 5 (facade
tests off the six doomed members), Task 6 (ownerId guard through `replaceJob`), Task 7 (deleted the
six facade members), Task 8 (deleted the six authoring-layer delegates), Task 9 (deleted the
orphaned `job.ts` transforms and took `JobPatch` off the surface), Task 10 (facade reachability
guard — `packages/engine/src/projectionFacade.guard.test.ts`), Task 11 (hardened purity script for
nested folders), Task 12 (retirement cluster → `retirement/`), Task 13 (compile cluster →
`compile/`), Task 14 (input cluster → `input/`), Task 15 (deleted `allocations.ts`, re-homed the
`line:<id>` convention), **Task 16 (extracted the scenario builders into
`packages/app/src/testing/scenarioBuilders.tsx`).**
**Tasks 17–20 remain — issue §Solution.3: split `projectionFacade.test.ts` into seven files by
capability, and grow scenarios in three directions (more households, more panels, long-arc life
timelines). Task 16 was the enabler for those.**

## Live constraints
- **The scenario vocabulary now lives in `packages/app/src/testing/scenarioBuilders.tsx`** (task
  16). Exports `monthAt`, `jobAt`, `alexAlone`, `alexAndSam`, `paragraphs`, `headline`,
  `assumptions`, plus `LIFE_EXPECTANCY` (the constant the portfolio-lasts assertions quote).
  `scenarios.test.tsx` now imports these — it is the template for a new scenario file, which should
  be a handful of imports + assertions, NOT a re-implementation. When you add scenario files
  (growing scenarios in three directions), import from here.
  - **`.tsx`, not `.ts`** — `paragraphs` renders `<RetirementPanel>` via `renderToStaticMarkup`.
  - **`headline` matches by three known prefixes** (`"You could stop working at"`, `"You can retire
    at"`, `"On these numbers"`) on PURPOSE: it finds the answer sentence by prefix so a new
    paragraph appearing above it cannot silently retarget every assertion. Do NOT generalize this to
    "first paragraph" / positional matching — that is the regression the helper exists to prevent.
    If a new scenario introduces a fourth headline form, add its prefix here.
- **`projectionFacade.guard.test.ts` stays whole** across the task-17–20 facade-test split; only
  `projectionFacade.test.ts` splits by capability. The guard hardcodes one path
  (`declarativeCompilerPath` = `authoring/fromInput.ts`) and one allowlist (`{toJSON, payOffDebt}`
  with why-comments) — leave those intact.
- **The `line:<id>` budget-line obligation convention has one named owner:**
  `obligationBudgetLineId(lineId)` in `packages/engine/src/projection/financialObligation.ts`.
  Readers: `projection/simulate.obligations.test.ts` and `projectionFacade.test.ts`'s `keyOf`. If a
  split facade-test file keys a budget line, use this helper, not a raw `line:${id}`.
- **`allocations.ts` is deleted (task 15).** Do not resurrect it or reintroduce a "fourth record".
  `compile/compileBudget.ts:65` still soft-references the deleted authoring view — left as-is; the
  true live readers of `budgetLinePriority` are `orderBudgetLines` and `compileExpenseBudgetLines`.
- **Cluster folders exist:** `input/` (task 14), `compile/` (task 13), `retirement/` (task 12).
  Their test files stayed in `src/` — **tasks 16–20 own where tests ultimately land.** Intra-cluster
  imports stay `./`, sibling-`src/` imports are `../`.
- **`authoring/fromInput.ts` deliberately stayed in `authoring/`** (task 14) — leave the guard's
  `declarativeCompilerPath` pointing there.
- **The `job.ts` `with*` transforms are gone (task 9).** The "0 removes the deferral" write rule
  lives only in `packages/app/src/jobEditing.ts`. Readers (`monthlyIncomeCentsOf`,
  `startingMonthlyIncomeCentsOf`, `deferralFractionOf`, `mapJob`) stay and are live.
- **`authoring/jobs.ts` keeps all three plane helpers** (`editPlanJob`, `editPartnerJob`,
  `editJobAnywhere`). Do not delete them.

## Traps
- **TRAP — `authoringInputs.guard.test.ts` hardcodes `path === "input/scenarioInput.ts"`.** Its
  `finds the authoring types` `it` asserts `PartnerJobEntry` by name. If a later task moves/splits
  `input/scenarioInput.ts`, update this path in the same commit.
- **Test-count baseline: 1803 passing | 45 todo.** Task 16 was a pure move — no count change. The
  task-17–20 facade-test split is a re-org (files change, count should hold) and scenario growth
  ADDS tests. Any unexplained drop is a regression.
- **`index.guard.test.ts` needs no update on a folder move** — it only checks each specifier starts
  with `./` and resolves to a real file. Two denylists still carry the string `"withJobPatch"` as a
  forward-ban (`index.guard.test.ts`, `planWrites.guard.test.ts`) — deliberate, leave them.
- **`comments.guard.test.ts` scans only `*.ts(x)` under `packages/`** — keep `AGENTS.md`, root
  `repl.ts`/`playground.ts` and the implement prompt free of issue/PR numbers.
- **Dangling `{@link}` sweep on any move/deletion.** Grep `import("` and backtick paths across
  `packages` after any move; verify a pure move with `git diff --stat`.

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
