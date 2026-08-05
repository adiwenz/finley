# Handoff — issue 269

**Done so far:** Tasks 1–3 (exploration rule in `AGENTS.md`, the REPL, and the implement prompt,
all pinned by `comments.guard.test.ts`), Task 4 (`planFixtures.ts` over `replaceJob`), Task 5
(facade tests off the six doomed members; the only test-count drop so far), Task 6 (ownerId guard
through `replaceJob`), Task 7 (deleted the six facade members), Task 8 (deleted the six
authoring-layer delegates), Task 9 (deleted the orphaned `job.ts` transforms and took `JobPatch`
off the published surface), Task 10 (the facade reachability guard — new file
`packages/engine/src/projectionFacade.guard.test.ts`). Tasks 11–20 remain — see the issue body.
**11–15 move files into `retirement/`, `compile/`, `input/`; 16–20 reorganize and grow the tests.**

## Live constraints
- **The facade reachability guard (task 10) hardcodes one path.** It parses `Projection`'s public
  members out of `projectionFacade.ts` as TEXT and asserts each is named (`.member`) by some
  non-test file under `packages/app/src` or `packages/engine/src`. It excludes exactly one file
  from the corpus — the declarative compiler `packages/engine/src/authoring/fromInput.ts`, held in
  `declarativeCompilerPath` — because that file dispatches to every input-mappable member
  mechanically. **If tasks 11–15 relocate `fromInput.ts` (e.g. into `compile/` or `input/`), update
  `declarativeCompilerPath` in the guard in the same commit** — otherwise `fromInput.ts` re-enters
  the corpus, `payOffDebt` reads reachable, and the guard's "carries no allowlist entry that a
  caller has since started naming" `it` fails. The allowlist is `{toJSON, payOffDebt}`, each with a
  comment stating why; keep the comments if you touch it (an uncommented entry is a rubber stamp).
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
- **Test-count baseline: 1813 passing | 45 todo** (task 10 added 5 passing guard tests; task 5 was
  the only intended drop so far). The *only* remaining intended drop across the whole issue is
  `allocations.test.ts` (task 15). Any other count change is a regression.
- **Dangling `{@link}` sweep on deletion.** When you delete a member, sweep every `{@link}` naming
  it — not a compile error, but reviewer noise.

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
