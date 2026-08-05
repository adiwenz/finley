# Handoff — issue 269

**Done so far:** Tasks 1–3 (exploration rule in `AGENTS.md`, the REPL, and the implement
prompt, all pinned by `comments.guard.test.ts`), Task 4 (`planFixtures.ts` over `replaceJob`),
Task 5 (facade tests off the six doomed members; the only test-count drop so far), Task 6
(ownerId guard through `replaceJob`), Task 7 (deleted the six facade members), Task 8 (deleted
the six authoring-layer delegates), Task 9 (deleted the orphaned `job.ts` transforms and took
`JobPatch` off the published surface). Tasks 10–20 remain — see the issue body.

## Live constraints
- **The `job.ts` `with*` transforms are now gone** (task 9): `withJobPatch` + the `JobPatch`
  type, `withMonthlyIncome`, `withStartingMonthlyIncome`, `withCurrentMonthlyIncome`,
  `withDeferralFraction`. The readers stay and are all still live — `monthlyIncomeCentsOf`,
  `startingMonthlyIncomeCentsOf` (used at `packages/app/src/planPeople.ts`), `deferralFractionOf`,
  `mapJob`. The "0 removes the deferral" write rule now lives only in the app
  (`packages/app/src/jobEditing.ts`); do not reintroduce an engine transform for it.
- **`JobPatch` left the public surface** — dropped from `packages/engine/src/index.ts`. Nothing
  under `packages/app` named the type. Two guard denylists still carry the *string* `"withJobPatch"`
  as a standing ban (`index.guard.test.ts` `MUST_STAY_INTERNAL`, `planWrites.guard.test.ts`
  `WRITES_THAT_MUST_STAY_INTERNAL`) — **left in place deliberately**: they forward-ban that name
  ever reaching the surface, not a live reference. Do not treat them as leftovers.
- **Task 10 (next) is the facade reachability guard** the issue §2 calls for — parse `Projection`'s
  members out of `projectionFacade.ts` as text, assert each is named by a non-test file, with a
  commented allowlist (`toJSON`, `payOffDebt`) and a self-check `it`. Prior art:
  `index.guard.test.ts`, `comments.guard.test.ts`.
- **`authoring/jobs.ts` keeps all three plane helpers** (`editPlanJob`, `editPartnerJob`,
  `editJobAnywhere`) — still backing surviving writes. Do not delete them.
- **`jobs.test.ts` proves the plane-agnostic finder through `addProjectionJobPayChange`** (task 8),
  a surviving `editJobAnywhere` caller. If a later task deletes the pay-change writes, re-express
  those two tests through the income-override write rather than dropping them.
- **Exploration rule** lives in `AGENTS.md` (`## Testing & exploration`) and
  `.sandcastle/new_flow/implement-prompt.md` (a bullet under `### 🛠️ Required Skills`), pinned by
  `comments.guard.test.ts` asserting both match `/through the REPL/i` and `/pin what you observed/i`.
  Reword either and keep both phrases (or update the guard in the same commit).
- `repl.ts`'s three formatters (`dumpMonths`, `waterfall`, `balances`) read a `ProjectionResult`,
  never call `run()`. `comments.guard.test.ts` only scans `*.ts(x)` under `packages/`, so keep
  `AGENTS.md`, root `repl.ts`/`playground.ts` and the implement prompt free of issue/PR numbers
  regardless. `npm run repl` / `npm run playground` exist in the root `package.json`.
- **`planFixtures.ts` and `projectionFacade.test.ts` name none of the six doomed members** (tasks
  4, 5): job edits route through `replaceJob` / `replacePartnerJob`, reading the job back and
  spreading it. Spreading `...job` is safe — `resolveJobInput` re-stamps `id`/`ownerId`. The
  deleted transforms no longer exist to re-import; keep the inlined logic.
- **`authoringInputs.guard.test.ts` proves the `ownerId` claim through `replaceJob`** (task 6):
  the `@ts-expect-error` fires because `JobInput = Omit<Job, "id" | "ownerId">` makes `ownerId` an
  excess property. Keep the directive's literal intact.

## Traps
- **Test-count baseline: 1808 passing | 45 todo.** Task 5 was the only intended drop so far, and
  the *only* remaining intended drop across the whole issue is `allocations.test.ts` (task 15).
  Task 9 re-expressed its five affected `it`s onto the readers rather than deleting them, so
  `job.test.ts` stays at 88. Any other count change is a regression, not a cleanup.
- **Dangling `{@link}` sweep on deletion.** When you delete a member, sweep every `{@link}` naming
  it — not a compile error, but reviewer noise. Task 9 swept `job.ts`'s reader docs, `ids.ts`'s
  `RETIREMENT_ID` rationale, and `authoring/jobs.ts`'s `jobDeferralFractionOf` doc.

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
