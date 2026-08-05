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
`packages/engine/src/compile/`). Tasks 14–20 remain — see the issue body.
**14–15 move the input cluster into `input/`; 16–20 reorganize and grow the tests.**

## Live constraints
- **The compile cluster now lives in `packages/engine/src/compile/` (task 13).** The three source
  files (`compilePerson.ts`, `compileBudget.ts`, `projectionBase.ts`) moved; intra-cluster imports
  stay `./` (`projectionBase.ts` → `./compilePerson`, `./compileBudget`), imports of `src/` siblings
  became `../`. **Their test files stayed in `src/`** (`compileBudget.test.ts`,
  `projectionBase.test.ts`; `compilePerson` is covered by `job.test.ts`) and now import
  `./compile/…` — tasks 16–20 own where the tests ultimately land. Root-`src/` consumers rewrote
  `./X`→`./compile/X`; subfolder consumers (`authoring/`, `ledger/`, `retirement/`, `projection/`)
  rewrote `../X`→`../compile/X`. Seven `{@link import("…")}` doc refs in non-moved files were
  repointed in the same commit (`job.ts`, `person.ts`, `budgetLine.ts`, `retirement/retirementTypes.ts`,
  `ledger/household.ts` ×2, `projection/simulate.types.ts`). The input move (tasks 14–15) follows the
  same recipe.
- **The retirement cluster lives in `packages/engine/src/retirement/` (task 12).** Same recipe as
  above; its three test files also stayed in `src/`.
- **The purity guard catches nested leaks (task 11).** `scripts/check-engine-purity.mjs`'s
  app/rules rule matches `(?:\.\.\/)+(?:rules|app)`, so an engine file living one-or-more folders
  deep can no longer reach `../../rules`/`../../app` unnoticed. Its directory walk recurses via
  `readdirSync`, so it picks up new `compile/`/`input/` folders on its own — nothing to wire.
- **The facade reachability guard (task 10) hardcodes one path.** It parses `Projection`'s public
  members out of `projectionFacade.ts` as TEXT and asserts each is named (`.member`) by some
  non-test file under `packages/app/src` or `packages/engine/src`. It excludes exactly one file —
  the declarative compiler `packages/engine/src/authoring/fromInput.ts`, held in
  `declarativeCompilerPath`. **Task 13 did NOT move `fromInput.ts` — it stays in `authoring/`, so
  the path is still current.** If tasks 14–15 relocate `fromInput.ts` (e.g. into `input/`), update
  `declarativeCompilerPath` in the guard in the same commit — otherwise `fromInput.ts` re-enters the
  corpus, `payOffDebt` reads reachable, and the guard's "carries no allowlist entry that a caller has
  since started naming" `it` fails. The allowlist is `{toJSON, payOffDebt}`, each with a comment
  stating why; keep the comments if you touch it.
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
  the implement prompt free of issue/PR numbers regardless. `npm run repl` / `npm run playground`
  exist in the root `package.json`; `repl.ts`'s formatters read a `ProjectionResult`, never `run()`.
- **`planFixtures.ts` and `projectionFacade.test.ts` name none of the six doomed members** (tasks
  4, 5): job edits route through `replaceJob` / `replacePartnerJob`, reading the job back and
  spreading it. Spreading `...job` is safe — `resolveJobInput` re-stamps `id`/`ownerId`.
- **`authoringInputs.guard.test.ts` proves the `ownerId` claim through `replaceJob`** (task 6):
  the `@ts-expect-error` fires because `JobInput = Omit<Job, "id" | "ownerId">` makes `ownerId` an
  excess property. Keep the directive's literal intact.

## Traps
- **Test-count baseline: 1813 passing | 45 todo** (unchanged by tasks 12–13 — pure moves). The *only*
  remaining intended drop across the whole issue is `allocations.test.ts` (task 15). Any other
  count change is a regression.
- **Folder-move recipe (tasks 14–15).** `git mv` the source files, then in the moved files: keep
  intra-cluster `./` imports, rewrite every `./`-to-a-`src/`-sibling import (and every
  `{@link import("./…")}` / backtick path ref) to `../`; in the outside consumers rewrite `./X` to
  `./<folder>/X` (root `src/`) or `../X` to `../<folder>/X` (subfolders). Don't forget the
  `{@link import("…")}` doc refs in *non-moved* files that name a moved file — sweep them too.
  `index.guard.test.ts` needs no update — it only checks each specifier starts with `./` and resolves
  to a real file, which a folder path satisfies. Verify with `git diff --stat` (only import specifiers
  + renames) and confirm insertions == deletions.
- **Dangling `{@link}` sweep on any move/deletion.** When a file moves or a member is deleted,
  sweep every `{@link import("./…")}` and backtick path that named it — broken links are not a
  compile error but are reviewer noise. Grep `import("` across `packages` after any move.

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
