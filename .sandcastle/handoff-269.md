# Handoff — issue 269

**Done so far:** Task 1 (exploration rule in `AGENTS.md`), Task 2 (make the REPL the obvious
place to explore), Task 3 (mirror the exploration rule into the implement prompt + guard both),
Task 4 (reimplement `planFixtures.ts` over `replaceJob` / `replacePartnerJob`), Task 5 (move
`projectionFacade.test.ts` off the six doomed facade members), Task 6 (re-express the ownerId
guard in `authoringInputs.guard.test.ts` through `replaceJob`), Task 7 (delete the six facade
members from `projectionFacade.ts`), Task 8 (delete the six authoring-layer delegates from
`authoring/jobs.ts` + re-express `jobs.test.ts` off them).
Tasks 9–20 remain — see the issue body.

**Scope note:** the issue separates three deletions into three sections — "Delete the six facade
members" (`projectionFacade.ts`, task 7, done), "Delete the six authoring-layer delegates"
(`authoring/jobs.ts`, task 8, done), and delete the `with*` transforms (`job.ts`, a later task,
NOT yet done).

## Live constraints
- **`with*` transforms in `job.ts` are now fully orphaned and deletable.**
  `withMonthlyIncome`, `withStartingMonthlyIncome`, `withCurrentMonthlyIncome`,
  `withDeferralFraction` and `withJobPatch` no longer have any *production* caller — task 8 deleted
  the `authoring/jobs.ts` delegates that used them and dropped those imports. They remain referenced
  only by `job.test.ts` and by a `{@link import("../job").withDeferralFraction}` doc in
  `authoring/jobs.ts` (the `jobDeferralFractionOf` read). The task that deletes them owns
  `job.test.ts` in the same commit, and must sweep that `{@link}`. Keep the readers
  `monthlyIncomeCentsOf` / `startingMonthlyIncomeCentsOf` (the latter lives at
  `packages/app/src/planPeople.ts`), `deferralFractionOf`, and `mapJob` — all still used.
- **`authoring/jobs.ts` kept all three plane helpers** (`editPlanJob`, `editPartnerJob`,
  `editJobAnywhere`). They survived the delegate deletion: `editPlanJob` still backs
  `replaceProjectionJob`, `editPartnerJob` still backs `editJobAnywhere`, and `editJobAnywhere`
  still backs the pay-change and income-override writes. Do not delete them.
- **`jobs.test.ts` now proves the plane-agnostic finder through `addProjectionJobPayChange`**
  (task 8). The two tests under "the module owns which plane a job lives on" that used to call
  `setProjectionJobMonthlyIncome` now route an edit through `addProjectionJobPayChange` — a
  surviving `editJobAnywhere` caller — and assert the pay change landed on the right job / the
  refusal names the id. If a later task deletes the pay-change writes, re-express these two tests
  through another surviving `editJobAnywhere` caller (income override) rather than dropping them.
- Issue §2 also asks for a **guard test** so a future unreachable facade member is caught the day it
  dies. Still a remaining task — not done yet.
- **Exploration rule** lives in two docs and is pinned by
  `packages/engine/src/comments.guard.test.ts`:
  - `AGENTS.md`, `## Testing & exploration` section.
  - `.sandcastle/new_flow/implement-prompt.md`, a bullet under `### 🛠️ Required Skills`.
  The guard asserts **both** docs match `/through the REPL/i` and `/pin what you observed/i`. If a
  later task rewords either place, keep those two phrases (or update the guard's patterns in the
  same commit) — otherwise the guard fails.
- `repl.ts` carries three read-only formatters over a `ProjectionResult` — `dumpMonths`,
  `waterfall`, `balances`. **Invariant:** they read a run, never call `run()`.
- `comments.guard.test.ts` only scans `*.ts(x)` under `packages/`, so it does not police
  `AGENTS.md`, root `repl.ts`/`playground.ts`, or the implement prompt for issue/PR numbers. Keep
  those files free of issue/PR numbers regardless.
- `npm run repl` and `npm run playground` exist in the root `package.json`.
- **`planFixtures.ts` names none of the six doomed facade members** (task 4). Its salary/deferral
  builders route through `replaceJob` / `replacePartnerJob` via a private `replacingJob(id, edit)`
  helper and deliberately **inline** the `with*` transforms (the `deferral <= 0 → drop the key`
  asymmetry and the `RETIREMENT_ID` default). Do not "simplify" by re-importing the transforms —
  that would resurrect the very callers the `job.ts` deletion task needs gone.
- **`projectionFacade.test.ts` names none of the six doomed members** (task 5): every job edit reads
  the job back through `p.plan` (or `partnerEvent(p).person.jobs`) and spreads it into
  `replaceJob` / `replacePartnerJob`. Spreading `...job` is safe — `replaceProjectionJob` re-stamps
  `id`/`ownerId` off the prior record via `resolveJobInput`, so the input's copies are ignored.
- **`authoringInputs.guard.test.ts` proves the `ownerId` claim through `replaceJob`** (task 6). The
  `@ts-expect-error` line is `p.replaceJob("job-1", { ...longRunningJob, ownerId: P1 })`; it fires
  because `JobInput = Omit<Job, "id" | "ownerId">` makes `ownerId` an excess property. Dropping
  `ownerId` from that literal leaves the directive unused and `tsc` errors — keep it intact.

## Traps
- **Test-count baseline:** task 5 was the only intended suite drop so far (the two
  `setJobDeferralFraction`-asymmetry `it`s; full suite 1810 → 1808 passing). Per the issue this and
  `allocations.test.ts` are the *only* intended total-count drops across the whole issue. Tasks 6, 7
  and 8 did **not** change the count — still **1808 passing | 45 todo** (task 8 re-expressed rather
  than deleted its two tests, so `jobs.test.ts` stays at 9). If a later suite count falls
  unexpectedly, treat it as a regression, not a cleanup.
- **Dangling `{@link}` sweep on deletion.** When you delete a member, sweep every `{@link}` that
  named it — not a compile error, but noise a reviewer flags. Task 8 reworded `replaceProjectionJob`'s
  doc (no longer contrasts against the deleted `updateProjectionJob`) and repointed the
  `jobDeferralFractionOf` read doc at `withDeferralFraction`. The `job.ts` transform-deletion task
  inherits the same sweep for `job.ts`'s own cross-links.

## Dead ends
- (none)

## Deferred
- (none — everything remaining is owned by its declared task)
