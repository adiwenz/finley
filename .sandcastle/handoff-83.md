# Handoff — issue 83

**Done:** every task the issue declares, plus the deferred UI half. Trace in
`.sandcastle/summary-83.md`. Commits: `4872479` built the covered-earnings record from actual job
compensation; `2e9718c` reworked the month-0 seam after review; `53b5aac` fixed the Jobs-panel
label; `e24d060` prototyped the authoring UI and settled on variant E. This session **built E**
in the app and the engine and deleted the prototype. PR #227. `npm run check` green at 1331 tests.

## What landed this session

**Engine** (`packages/engine/src/job.ts`)

- `withStartingMonthlyIncome` / `withCurrentMonthlyIncome` + `startingMonthlyIncomeCentsOf` —
  each anchor writable on its own. `withMonthlyIncome` still sets both, for a job stated in one
  number; that is the right rule there and it did not change.
- `jobPayPath(job, span)` → `JobPayPath`: the job's authored pay at any month, the figure the
  history reaches, and `monthZeroStepCents`. Exported from the engine index as a value. It reads
  the anchors exactly as `compilePerson` does but without a simulation, so an authoring surface
  can draw a job's pay without reprojecting on every keystroke. **Authored dollars, not nominal
  paychecks** — CPI never enters, because none of the figures that go in carry it.
- Facade: `setJobStartingMonthlyIncome`, `setJobCurrentMonthlyIncome`,
  `jobStartingMonthlyIncomeCents`.

**App**

- `JobDraft` gained `startingMonthlyCents`; `applyJobDraft` now returns `AppliedJobDraft`
  (`{ job, strandedPayChanges }`) and `editJob`'s ok-result carries `strandedPayChanges` through.
- `payChart.tsx` (new) — the lifetime age axis, pay staircase, seam annotated in place, clickable
  to seed a change. `payTimeline.tsx` (new) — one age-ordered list with "now" as a row in it.
- `payChangeForm.tsx` — floored at the job's **start** age (not "now"), capped at its last paid
  age, clamped on the way into state, opening on the seam.
- `jobsPanel.tsx` — `Math.max(0, …)` gone from `addPayChange`; the flat pay-change list replaced
  by the chart + timeline; a stranded-change notice; an ended job headlines "ended at age N".

## Live constraints (unchanged, and now depended on by the UI)

- **`SalaryTrajectory` has two required anchors and neither derives from the other.** A step
  between the reconstructed month −1 salary and the current salary is the authored truth —
  **do not reconcile it.** The chart now *draws* that step; closing it in the engine would make
  the annotation a lie.
- **The sign of `JobPayChange.month` alone decides which side owns it.** No scope flag; one was
  explicitly rejected (see Dead ends).
- **Keep `salaryGrowthMode` / `applyPayChanges` / `applyIncomeOverrides` shared** between the two
  halves in `compilePerson.ts`. The only thing the halves deliberately do not share is a baseline.
  `jobPayPath` mirrors these rules in real terms; if they change, it changes.
- **The forward series' `anchorMonth` stays `naturalStart`** — the growth *clock*, separate from
  the salary *amount* the anchor sets. Pinned by the month-11/month-12 assertions in `job.test.ts`.
- **Wage-base caps and benefit rules stay in `@finley/rules`.**
- `monthlyIncomeCentsOf` reads *current* pay and `withMonthlyIncome` sets *both* anchors. Two
  derived-gross consumers are re-based to match and must stay that way: `personDeferralFractionOf`
  (`packages/engine/src/authoring/jobs.ts`) and the forward scan in `packages/app/src/deferralLimit.ts`.
- **For a job that ended before month 0, `currentSalaryCents` is never read** (`compileJobIncome`
  returns null at `compilePerson.ts:209`, before the only read at `:221`). The UI does not ask for
  it; `applyJobDraft` / `jobInputFromDraft` pin it to the job's last historical pay — **not zero**,
  which would silently pay $0/mo if the end age were later moved past "now".
- **Base + Adjustments keeps its `[0, lastMonth]` month clamp.** History is not authored there:
  that panel works off a month already selected on a chart spanning only the projection.

## Dead ends

- **Do not "fix" the month-0 discontinuity by carrying the historical series across the
  boundary.** The authored current salary already reflects historical raises, so continuing the
  series reapplies them. A future agent seeing a salary step at month 0 will be tempted to close
  it — it is intentional, and both the seam row and the chart annotation exist to say so.
- **An `untilNow` / `fromHereForward` scope field on `JobPayChange`** was specified, then dropped.
  Redundant: a historical change later undone is already two dated changes.
- **Deriving one salary anchor from the other** (de-growing `currentSalaryCents`, or growing
  `startingSalaryCents`) was rejected three times — for the one-field Jobs form, for the
  start-age-change case, and again when the two fields were built.
- **A separate "Pay history" surface for pre-now changes** (prototype variant C) was rejected: it
  mirrors the engine's month-sign split, forcing the user to answer "before or after now?" as a
  *navigation* question.
- **The start salary in an Advanced disclosure** (variant B) was rejected: the two facts that
  combine to make history end up in different disclosures and are never on screen together.
- **Co-plotting net worth over the historical span** (variant D) was rejected: the empty region
  left of "now" reads as a missing feature rather than as the rule, and back-filling it looks more
  plausible and is wrong. Income is a flow; a balance is a stock.

## Deferred

- **#231 — job aggregate readers ignore job spans.** `personMonthlyIncomeCentsOf`,
  `householdMonthlyIncomeCentsOf` and `personDeferralFractionOf` count finished jobs; the 50/30/20
  quickstart writes budget lines off the inflated figure. Pre-existing, unrelated to #83, filed
  with tasks. Pinning the dead anchor does not fix it — it is a filtering bug at the read sites.
- **#34 — the partial-first-year calendar discrepancy** is unchanged and still documented at
  `compilePersonPriorEarnings` in `packages/engine/src/compilePerson.ts`.
- **Adding a job for a partner seeds its start age from the primary person's current age**
  (`blankJobDraftFor(owners[0]…)`), so switching the owner picker can make a brand-new job read as
  already having a past. Pre-existing; now more visible, because the second salary field appears.

## Traps

- **Run vitest from the repo root** (`npx vitest run packages/engine/src/foo.test.ts`). The
  workspace config resolves its root to `packages/engine` while the `include` glob is written from
  the repo root, so running inside the package reports "No test files found" rather than failing
  loudly.
- `projectionFacade.test.ts` (~line 545) asserts `toEqual` on the **whole** `salary` object, so any
  new `SalaryTrajectory` field fails there and nowhere else.
- **A job row now quotes the same figure several times** — headline, chart scale, timeline rows.
  `getByText("$5,000/mo")` inside a row is ambiguous; the tests address the headline by its
  `title` (`getByTitle(/Current pay/)`) and the list via `getByLabelText("Pay history for …")`.
- **`/Monthly salary/i` matches two spinbuttons** on a job with a past. Use `/Monthly salary now/i`
  for the month-0 anchor and `/Monthly salary at age N/i` for the start anchor.
