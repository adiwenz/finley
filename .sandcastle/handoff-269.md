# Handoff — issue 269

**Done so far:** Tasks 1–3 (exploration rule in `AGENTS.md`, the REPL, the implement prompt, all
pinned by `comments.guard.test.ts`), Task 4 (`planFixtures.ts` over `replaceJob`), Task 5 (facade
tests off the six doomed members), Task 6 (ownerId guard through `replaceJob`), Task 7 (deleted the
six facade members), Task 8 (deleted the six authoring-layer delegates), Task 9 (deleted the
orphaned `job.ts` transforms and took `JobPatch` off the surface), Task 10 (facade reachability
guard — `packages/engine/src/projectionFacade.guard.test.ts`), Task 11 (hardened purity script for
nested folders), Task 12 (retirement cluster → `retirement/`), Task 13 (compile cluster →
`compile/`), Task 14 (input cluster → `input/`), Task 15 (deleted `allocations.ts`, re-homed the
`line:<id>` convention), Task 16 (extracted the scenario builders into
`packages/app/src/testing/scenarioBuilders.tsx`), **Task 17 (split `projectionFacade.test.ts` into
seven capability files).**
**Tasks 18–20 remain — issue §Solution.3: grow scenarios in three directions (more households, more
panels, long-arc life timelines). Task 16 was the enabler; the scenario vocabulary lives in
`packages/app/src/testing/scenarioBuilders.tsx`.**

## Live constraints
- **The facade-test split is DONE (task 17).** `projectionFacade.test.ts` is now the ~190-line
  "one root for standing + ledger writes" core, and six siblings carry the rest:
  `.identity` (50 it), `.jobs` (32), `.transactions` (24), `.run` (25), `.budgetGoals` (19),
  `.reads` (13). Sum = 174 across the seven = original 176 minus the two deleted in the facade
  shrink. Describes were moved **verbatim**; no test bodies changed. Tasks 18–20 do not touch these.
- **Shared facade fixtures live in `packages/engine/src/testing/projectionFacadeFixtures.ts`**
  (task 17): `P1`, `freshProjection`, `JOB_END_YEAR`, `plainJob`, `partnerEvent`, `expenseLine`,
  `carGoalInput`. The seven split files import from here rather than each re-declaring them. This is
  the ENGINE test-fixture module; do not confuse it with the APP `scenarioBuilders.tsx` below.
- **The scenario vocabulary lives in `packages/app/src/testing/scenarioBuilders.tsx`** (task 16).
  Exports `monthAt`, `jobAt`, `alexAlone`, `alexAndSam`, `paragraphs`, `headline`, `assumptions`,
  plus `LIFE_EXPECTANCY`. `scenarios.test.tsx` imports these — it is the template for a new scenario
  file: a handful of imports + assertions, NOT a re-implementation. Growing scenarios imports here.
  - **`.tsx`, not `.ts`** — `paragraphs` renders `<RetirementPanel>` via `renderToStaticMarkup`.
  - **`headline` matches by three known prefixes** (`"You could stop working at"`, `"You can retire
    at"`, `"On these numbers"`) on PURPOSE: it finds the answer sentence by prefix so a new paragraph
    above it cannot silently retarget every assertion. Do NOT generalize to positional matching. If a
    new scenario introduces a fourth headline form, add its prefix here.
- **`projectionFacade.guard.test.ts` stayed whole** across the task-17 split (only
  `projectionFacade.test.ts` split). It hardcodes one path (`declarativeCompilerPath` =
  `authoring/fromInput.ts`) and one allowlist (`{toJSON, payOffDebt}` with why-comments) — intact.
- **The `line:<id>` budget-line obligation convention has one named owner:**
  `obligationBudgetLineId(lineId)` in `packages/engine/src/projection/financialObligation.ts`.
  Readers: `projection/simulate.obligations.test.ts` and the split `projectionFacade.reads.test.ts`'s
  `keyOf`. If a new test keys a budget line, use this helper, not a raw `line:${id}`.
- **`allocations.ts` is deleted (task 15).** Do not resurrect it. `compile/compileBudget.ts:65` still
  soft-references the deleted authoring view — left as-is; the true live readers of
  `budgetLinePriority` are `orderBudgetLines` and `compileExpenseBudgetLines`.
- **Cluster folders exist:** `input/` (task 14), `compile/` (task 13), `retirement/` (task 12).
  Their test files stayed in `src/`. Intra-cluster imports stay `./`, sibling-`src/` imports are `../`.

## Traps
- **TRAP — `authoringInputs.guard.test.ts` hardcodes `path === "input/scenarioInput.ts"`** and its
  `finds the authoring types` `it` asserts `PartnerJobEntry` by name. If a later task moves/splits
  `input/scenarioInput.ts`, update this path in the same commit.
- **Test-count baseline: 1803 passing | 45 todo.** Task 17 was a pure re-org (files change, count
  held). Scenario growth (18–20) ADDS tests. Any unexplained drop is a regression.
- **`noUnusedLocals` is on** (root `tsconfig.json`). When splitting/moving tests, every import must be
  used in code — a symbol appearing only in a comment or a describe-title string still trips TS6133.
  This bit task 17 (three imports had to be dropped). `typecheck` catches it.
- **`comments.guard.test.ts` scans only `*.ts(x)` under `packages/`** — keep `AGENTS.md`, root
  `repl.ts`/`playground.ts` and the implement prompt free of issue/PR numbers.
- **`index.guard.test.ts` needs no update on a folder move** — it only checks each specifier starts
  with `./` and resolves to a real file. Two denylists still carry `"withJobPatch"` as a forward-ban
  (`index.guard.test.ts`, `planWrites.guard.test.ts`) — deliberate, leave them.
- **Dangling `{@link}` sweep on any move/deletion.** Grep `import("` and backtick paths across
  `packages` after any move; verify a pure move with `git diff --stat`.

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
