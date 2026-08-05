# Handoff — issue 269

**Done so far:** Tasks 1–3 (exploration rule in `AGENTS.md`, the REPL, and the implement prompt,
all pinned by `comments.guard.test.ts`), Task 4 (`planFixtures.ts` over `replaceJob`), Task 5
(facade tests off the six doomed members; the only test-count drop so far), Task 6 (ownerId guard
through `replaceJob`), Task 7 (deleted the six facade members), Task 8 (deleted the six
authoring-layer delegates), Task 9 (deleted the orphaned `job.ts` transforms and took `JobPatch`
off the published surface), Task 10 (the facade reachability guard — new file
`packages/engine/src/projectionFacade.guard.test.ts`), Task 11 (hardened the purity script's
app/rules import regex to match any depth of `../`), Task 12 (moved the retirement cluster into
`packages/engine/src/retirement/`), Task 13 (moved the compile cluster into
`packages/engine/src/compile/`), Task 14 (moved the input cluster into
`packages/engine/src/input/`). **Tasks 15–20 remain — see the issue body.**
**15 deletes `allocations.ts` (the one intended count drop); 16–20 reorganize and grow the tests.**

## Live constraints
- **The input cluster now lives in `packages/engine/src/input/` (task 14).** The two source files
  (`scenarioInput.ts`, `scenarioRefs.ts`) moved; intra-cluster imports stay `./` (`scenarioRefs.ts`
  → `./scenarioInput`, and `scenarioInput.ts`'s one `{@link import("./scenarioRefs")}` doc ref),
  imports of `src/` siblings became `../` (including ~20 `{@link import("../…")}` doc refs in
  `scenarioInput.ts`). **Their test files stayed in `src/`** (`scenarioInput.test.ts`,
  `scenarioRefs.test.ts`) and now import `./input/…` — tasks 16–20 own where the tests ultimately
  land. Consumers rewrote `./scenarioInput`/`./scenarioRefs`→`./input/…` (root `src/`:
  `index.ts`, `projectionFacade.ts`, `fromInput.test.ts`, `preExisting.test.ts`,
  `scenarioInput.test.ts`, `scenarioRefs.test.ts`, `authoringInputs.guard.test.ts`) and
  `../scenarioInput`/`../scenarioRefs`→`../input/…` (`authoring/fromInput.ts`, `authoring/revise.ts`
  doc ref, `authoring/state.ts`).
- **`authoring/fromInput.ts` deliberately stayed in `authoring/` (task 14, per the issue).** It
  interprets a `ScenarioInput` but is an authoring op holding the type-only `Projection` import that
  breaks the facade cycle. Because it did NOT move, `declarativeCompilerPath` in
  `projectionFacade.guard.test.ts` (`authoring/fromInput.ts`) is still current — leave it.
- **TRAP — `authoringInputs.guard.test.ts` hardcodes the moved file's path.** Its
  `AUTHORING_MODULES` predicate reads `path === "input/scenarioInput.ts"` (was `"scenarioInput.ts"`,
  updated in task 14) and its doc comment matches. This is what keeps `PartnerJobEntry` and the
  per-verb `*Entry` shapes — declared in `scenarioInput.ts`, NOT published by `index.ts` — inside
  the id-free scan; the `finds the authoring types` `it` asserts `PartnerJobEntry` by name. If a
  later task moves `input/scenarioInput.ts` again or splits its types across files, update this path
  in the same commit or that test fails.
- **The compile cluster lives in `packages/engine/src/compile/` (task 13); the retirement cluster
  in `packages/engine/src/retirement/` (task 12).** Same recipe; their test files also stayed in
  `src/`. `scenarioRefs.ts` imports `../compile/projectionBase` post-move.
- **The purity guard catches nested leaks (task 11).** `scripts/check-engine-purity.mjs`'s
  app/rules rule matches `(?:\.\.\/)+(?:rules|app)`, and its directory walk recurses via
  `readdirSync`, so it picks up new `compile/`/`input/` folders on its own — nothing to wire.
- **The facade reachability guard (task 10) hardcodes one path.** It parses `Projection`'s public
  members out of `projectionFacade.ts` as TEXT and asserts each is named (`.member`) by some
  non-test file under `packages/app/src` or `packages/engine/src`, excluding only
  `declarativeCompilerPath` = `authoring/fromInput.ts`. Allowlist is `{toJSON, payOffDebt}`, each
  with a comment stating why; keep the comments if you touch it.
- **The guard is not a capability test — leave it out of the task-16 split.** `projectionFacade.test.ts`
  is what tasks 16–20 split by capability; `projectionFacade.guard.test.ts` is a standing guard and
  stays whole.
- **The `job.ts` `with*` transforms are gone** (task 9): `withJobPatch` + `JobPatch`,
  `withMonthlyIncome`, `withStartingMonthlyIncome`, `withCurrentMonthlyIncome`,
  `withDeferralFraction`. Readers stay and are live — `monthlyIncomeCentsOf`,
  `startingMonthlyIncomeCentsOf` (`packages/app/src/planPeople.ts`), `deferralFractionOf`, `mapJob`.
  The "0 removes the deferral" write rule now lives only in the app (`packages/app/src/jobEditing.ts`);
  do not reintroduce an engine transform for it.
- **`JobPatch` left the public surface** — dropped from `packages/engine/src/index.ts`. Two guard
  denylists still carry the *string* `"withJobPatch"` as a standing ban (`index.guard.test.ts`
  `MUST_STAY_INTERNAL`, `planWrites.guard.test.ts` `WRITES_THAT_MUST_STAY_INTERNAL`) — **left in
  place deliberately**: they forward-ban that name reaching the surface, not a live reference.
- **`authoring/jobs.ts` keeps all three plane helpers** (`editPlanJob`, `editPartnerJob`,
  `editJobAnywhere`) — still backing surviving writes. Do not delete them.
- **`jobs.test.ts` proves the plane-agnostic finder through `addProjectionJobPayChange`** (task 8),
  a surviving `editJobAnywhere` caller. If a later task deletes the pay-change writes, re-express
  those two tests through the income-override write rather than dropping them.
- **Exploration rule** lives in `AGENTS.md` (`## Testing & exploration`) and
  `.sandcastle/new_flow/implement-prompt.md` (a bullet under `### 🛠️ Required Skills`), pinned by
  `comments.guard.test.ts` asserting both match `/through the REPL/i` and `/pin what you observed/i`.
  Reword either and keep both phrases (or update the guard in the same commit). `comments.guard.test.ts`
  scans only `*.ts(x)` under `packages/`, so keep `AGENTS.md`, root `repl.ts`/`playground.ts` and
  the implement prompt free of issue/PR numbers regardless.
- **`planFixtures.ts` and `projectionFacade.test.ts` name none of the six doomed members** (tasks
  4, 5): job edits route through `replaceJob` / `replacePartnerJob`, reading the job back and
  spreading it. Spreading `...job` is safe — `resolveJobInput` re-stamps `id`/`ownerId`.
- **`authoringInputs.guard.test.ts` proves the `ownerId` claim through `replaceJob`** (task 6):
  the `@ts-expect-error` fires because `JobInput = Omit<Job, "id" | "ownerId">` makes `ownerId` an
  excess property. Keep the directive's literal intact.

## Traps
- **Test-count baseline: 1813 passing | 45 todo** (unchanged by tasks 12–14 — pure moves). The *only*
  remaining intended drop across the whole issue is `allocations.test.ts` (task 15). Any other
  count change is a regression.
- **`index.guard.test.ts` needs no update on a folder move** — it only checks each specifier starts
  with `./` and resolves to a real file, which a folder path satisfies.
- **Dangling `{@link}` sweep on any move/deletion.** When a file moves or a member is deleted,
  sweep every `{@link import("./…")}` and backtick path that named it — broken links are not a
  compile error but are reviewer noise. Grep `import("` across `packages` after any move; verify a
  pure move with `git diff --stat` (insertions == deletions, only specifiers + renames).

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
