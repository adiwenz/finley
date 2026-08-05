# Handoff — issue 269

**Done so far:** Task 1 (exploration rule in `AGENTS.md`), Task 2 (make the REPL the obvious
place to explore), Task 3 (mirror the exploration rule into the implement prompt + guard both),
Task 4 (reimplement `planFixtures.ts` over `replaceJob` / `replacePartnerJob`), Task 5 (move
`projectionFacade.test.ts` off the six doomed facade members), Task 6 (re-express the ownerId
guard in `authoringInputs.guard.test.ts` through `replaceJob`), Task 7 (delete the six facade
members from `projectionFacade.ts`).
Tasks 8–20 remain — see the issue body.

**Scope correction (was wrong in the prior handoff):** the issue body separates three deletions
into three distinct sections — "Delete the six facade members" (`projectionFacade.ts`, task 7,
now done), "Delete the six authoring-layer delegates" (`authoring/jobs.ts`, a *later* task), and
delete the `with*` transforms (`job.ts`, a later task still). Task 7 was facade-only; it did **not**
touch `authoring/jobs.ts`. Do not fold the delegate deletion back into task 7.

## Live constraints
- **Task 7 left `authoring/jobs.ts` delegates orphaned-from-the-facade but still live.**
  `updateProjectionJob`, `updateProjectionPartnerJob`, `setProjectionJobMonthlyIncome`,
  `setProjectionJobStartingMonthlyIncome`, `setProjectionJobCurrentMonthlyIncome`,
  `setProjectionJobDeferralFraction` are no longer imported by the facade, but remain **exported**
  and are still exercised by `authoring/jobs.test.ts`. The task that deletes them owns that test
  suite in the same commit (issue §"Delete the six authoring-layer delegates"). Keep the readers
  (`jobMonthlyIncomeCentsOf`, `jobStartingMonthlyIncomeCentsOf`, `jobDeferralFractionOf`, and the
  person/household aggregates) — the facade still imports and re-exposes all of them.
- **`with*` transforms in `job.ts` still exist** (`withMonthlyIncome`, `withStartingMonthlyIncome`,
  `withCurrentMonthlyIncome`, `withDeferralFraction`) — deletable only after the `authoring/jobs.ts`
  delegates that call them are gone. `planFixtures.ts` deliberately *inlines* their logic (see
  below) so they end up orphaned; do not re-import them there. Keep the readers `monthlyIncomeCentsOf`
  / `startingMonthlyIncomeCentsOf` (the latter live at `packages/app/src/planPeople.ts`).
- Issue §2 also asks for a **guard test** so a future unreachable facade member is caught the day it
  dies. That is a remaining task — not done yet.
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
  asymmetry and the `RETIREMENT_ID` default). Do not "simplify" by re-importing the transforms.
- **`projectionFacade.test.ts` names none of the six doomed members** (task 5): every job edit reads
  the job back through `p.plan` (or `partnerEvent(p).person.jobs`) and spreads it into
  `replaceJob` / `replacePartnerJob`. Spreading `...job` is safe — `replaceProjectionJob` re-stamps
  `id`/`ownerId` off the prior record via `resolveJobInput`, so the input's copies are ignored.
- **`authoringInputs.guard.test.ts` proves the `ownerId` claim through `replaceJob`** (task 6). The
  `@ts-expect-error` line is `p.replaceJob("job-1", { ...longRunningJob, ownerId: P1 })`; it fires
  because `JobInput = Omit<Job, "id" | "ownerId">` makes `ownerId` an excess property. Dropping
  `ownerId` from that literal leaves the directive unused and `tsc` errors — keep it intact.

## Traps
- **Test-count baseline:** task 5 was the intended drop (the two `setJobDeferralFraction`-asymmetry
  `it`s; suite 176 → 174, full suite 1810 → 1808 passing). Per the issue this and `allocations.test.ts`
  are the *only* intended total-count drops across the whole issue. Task 6 and task 7 did **not**
  change the count — still **1808 passing | 45 todo** (task 7 was a pure deletion; the tests were
  already moved off the members). If a later suite count falls unexpectedly, treat it as a
  regression, not a cleanup.
- Task 7 also fixed two now-dangling `{@link updateJob}` doc references in `projectionFacade.ts`:
  the class-level "editing method addresses a target by id" example now names `replaceJob(jobId, …)`,
  and `replaceJob`'s own doc no longer contrasts against `updateJob`. When you delete the
  `authoring/jobs.ts` delegates, sweep their doc-comments the same way — a dangling `{@link}` is not
  a compile error but is noise the reviewer will flag.

## Dead ends
- (none)

## Deferred
- (none — everything from the delegate deletion on is owned by its declared task)
