# Handoff — issue 269

**Done so far:** Tasks 1–3 (exploration rule in `AGENTS.md`, the REPL, and the implement prompt,
all pinned by `comments.guard.test.ts`), Task 4 (`planFixtures.ts` over `replaceJob`), Task 5
(facade tests off the six doomed members), Task 6 (ownerId guard through `replaceJob`), Task 7
(deleted the six facade members), Task 8 (deleted the six authoring-layer delegates), Task 9
(deleted the orphaned `job.ts` transforms and took `JobPatch` off the published surface), Task 10
(the facade reachability guard — `packages/engine/src/projectionFacade.guard.test.ts`), Task 11
(hardened the purity script for nested folders), Task 12 (retirement cluster → `retirement/`),
Task 13 (compile cluster → `compile/`), Task 14 (input cluster → `input/`), **Task 15 (deleted
`allocations.ts`/`allocations.test.ts`; gave the `line:<id>` convention a real owner).**
**Tasks 16–20 remain — see the issue body. They reorganize and grow the tests.**

## Live constraints
- **The `line:<id>` budget-line obligation convention now has one named owner:**
  `obligationBudgetLineId(lineId)` in `packages/engine/src/projection/financialObligation.ts`
  (next to `obligationLiabilityId`). `buildObligations` mints production keys through it. Readers:
  `projection/simulate.obligations.test.ts` and `projectionFacade.test.ts`'s `keyOf` helper both
  call it. The old anonymous inline template literal and the deleted `allocations.ts`'s duplicate
  `budgetLineAllocationId` are gone. If a later task keys a budget line, use this helper, not a
  raw `line:${id}`.
- **`allocations.ts` is deleted (task 15).** It was already dead — no source importer, not in the
  barrel. Every role had moved (normalization/priority → `projection/financialObligation.ts`,
  attribution → `projection/resolvedFunding.ts`, rendering → `resolveExpenseRows`/the facade,
  write routing → the facade). Comments that cited `allocations()` were re-pointed at the new
  owner (`planDefaults.ts`, `baseAdjustments/budgetTemplate.ts`, `budgetLine.ts`,
  `projection/simulate.types.ts`, `projectionFacade.test.ts`). Do not resurrect it or reintroduce
  a "fourth record".
  - **Note:** `compile/compileBudget.ts:65` still says "the same ordering source of truth the
    authoring view reads" — a soft reference to the deleted view, left as-is (it doesn't cite
    `allocations()` by name and was outside task 15's grep-defined scope). If a later task touches
    it, the true live readers of `budgetLinePriority` are `orderBudgetLines` and
    `compileExpenseBudgetLines` — see the rewritten `budgetLine.ts:179` doc.
- **The input cluster lives in `packages/engine/src/input/` (task 14).** `scenarioInput.ts`,
  `scenarioRefs.ts` moved; intra-cluster imports stay `./`, sibling-`src/` imports became `../`.
  Their test files stayed in `src/` (`scenarioInput.test.ts`, `scenarioRefs.test.ts`) — tasks
  16–20 own where tests ultimately land.
- **`authoring/fromInput.ts` deliberately stayed in `authoring/` (task 14).** So
  `declarativeCompilerPath` in `projectionFacade.guard.test.ts` (`authoring/fromInput.ts`) is
  still current — leave it.
- **TRAP — `authoringInputs.guard.test.ts` hardcodes the moved file's path.** Its
  `AUTHORING_MODULES` predicate reads `path === "input/scenarioInput.ts"` and its doc matches.
  This keeps `PartnerJobEntry` and the per-verb `*Entry` shapes inside the id-free scan; the
  `finds the authoring types` `it` asserts `PartnerJobEntry` by name. If a later task moves
  `input/scenarioInput.ts` again or splits its types, update this path in the same commit.
- **The compile cluster lives in `compile/` (task 13); retirement in `retirement/` (task 12).**
  Same recipe; their test files also stayed in `src/`. `scenarioRefs.ts` imports
  `../compile/projectionBase` post-move.
- **The purity guard catches nested leaks (task 11).** `scripts/check-engine-purity.mjs`'s
  app/rules rule matches `(?:\.\.\/)+(?:rules|app)` and recurses via `readdirSync`, so it picks up
  new folders on its own.
- **The facade reachability guard (task 10) hardcodes one path.** It parses `Projection`'s public
  members out of `projectionFacade.ts` as TEXT and asserts each is named by some non-test file
  under `packages/app/src` or `packages/engine/src`, excluding only `declarativeCompilerPath` =
  `authoring/fromInput.ts`. Allowlist `{toJSON, payOffDebt}`, each with a why-comment — keep them.
  It is a standing guard, not a capability test — leave it out of the task-16 split.
- **Tasks 16–20 split `projectionFacade.test.ts` by capability; `projectionFacade.guard.test.ts`
  stays whole.**
- **The `job.ts` `with*` transforms are gone (task 9).** Readers stay and are live
  (`monthlyIncomeCentsOf`, `startingMonthlyIncomeCentsOf`, `deferralFractionOf`, `mapJob`). The
  "0 removes the deferral" write rule now lives only in `packages/app/src/jobEditing.ts`; do not
  reintroduce an engine transform for it.
- **`JobPatch` left the public surface.** Two guard denylists still carry the *string*
  `"withJobPatch"` as a forward-ban (`index.guard.test.ts` `MUST_STAY_INTERNAL`,
  `planWrites.guard.test.ts` `WRITES_THAT_MUST_STAY_INTERNAL`) — left in place deliberately.
- **`authoring/jobs.ts` keeps all three plane helpers** (`editPlanJob`, `editPartnerJob`,
  `editJobAnywhere`). Do not delete them. `jobs.test.ts` proves the plane-agnostic finder through
  `addProjectionJobPayChange`; if a later task deletes the pay-change writes, re-express those two
  tests through the income-override write rather than dropping them.
- **Exploration rule** lives in `AGENTS.md` (`## Testing & exploration`) and
  `.sandcastle/new_flow/implement-prompt.md`, pinned by `comments.guard.test.ts` (both must match
  `/through the REPL/i` and `/pin what you observed/i`). `comments.guard.test.ts` scans only
  `*.ts(x)` under `packages/`, so keep `AGENTS.md`, root `repl.ts`/`playground.ts` and the
  implement prompt free of issue/PR numbers.
- **`planFixtures.ts` and `projectionFacade.test.ts` name none of the six doomed members** — job
  edits route through `replaceJob`/`replacePartnerJob`. Spreading `...job` is safe —
  `resolveJobInput` re-stamps `id`/`ownerId`.

## Traps
- **Test-count baseline: 1803 passing | 45 todo** (was 1813 before task 15; the `-10` is the
  deleted `allocations.test.ts` cases — the last intended drop across the whole issue besides the
  task-16 facade-test rewrite). Any other count change is a regression.
- **`index.guard.test.ts` needs no update on a folder move** — it only checks each specifier
  starts with `./` and resolves to a real file.
- **Dangling `{@link}` sweep on any move/deletion.** Grep `import("` and backtick paths across
  `packages` after any move; verify a pure move with `git diff --stat`.

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
