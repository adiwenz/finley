# Handoff — issue 83

**Done so far:** every task the issue declares is complete (trace in `.sandcastle/summary-83.md`).
Three commits: `4872479` built the covered-earnings record from actual job compensation;
`2e9718c` reworked the month-0 seam after review; `53b5aac` fixed the Jobs-panel label that
followed. PR #227. `npm run check` green at 1306 tests.

**This session added no production code.** It designed the deferred UI half as a throwaway
prototype and settled the open questions. The prototype is committed as reference for the
implementation session — **read `packages/app/src/components/jobsPanel/prototype/NOTES.md`
first**; it holds the findings, the rejected options and the reasoning behind every decision
below. Run it with `npm run dev` → `http://localhost:5173/prototype-pay-history.html`.

## Live constraints

- **`SalaryTrajectory` has two required anchors and neither derives from the other.**
  `startingSalaryCents` feeds the historical reconstruction only; `currentSalaryCents` is the
  month-0 anchor and is authoritative for everything forward. A step between the reconstructed
  month −1 salary and the current salary is the authored truth — **do not reconcile it.** Full
  rationale in the `SalaryTrajectory` doc, `packages/engine/src/job.ts`.
- **The sign of `JobPayChange.month` alone decides which side owns it.** `< 0` →
  `reconstructHistoricalCompensation`; `>= 0` → `compileJobIncome`. There is no scope flag, and
  one was explicitly rejected (see Dead ends).
- **Keep `salaryGrowthMode` / `applyPayChanges` / `applyIncomeOverrides` shared** between the two
  halves in `compilePerson.ts`. Composition rules for raises and bonuses must not fork; the only
  thing the halves deliberately do not share is a baseline.
- **The forward series' `anchorMonth` stays `naturalStart`.** It is the growth *clock*, separate
  from the salary *amount* the anchor sets. Setting it to 0 would restart every job's raise
  anniversary. Pinned by the month-11/month-12 assertions in `job.test.ts`.
- **Wage-base caps and benefit rules stay in `@finley/rules`.** The engine records uncapped
  combined per-year earnings; capping is one downstream per-person-per-year step.
- `monthlyIncomeCentsOf` reads *current* pay and `withMonthlyIncome` sets *both* anchors. Two
  derived-gross consumers were re-based to match and must stay that way:
  `personDeferralFractionOf` (`packages/engine/src/authoring/jobs.ts`) and the forward scan in
  `packages/app/src/deferralLimit.ts`.
- **For a job that ended before month 0, `currentSalaryCents` is never read.**
  `compileJobIncome` returns null at `compilePerson.ts:209`, before the only read at `:221`;
  `reconstructHistoricalCompensation` touches `startingSalaryCents` only. The value is inert, so
  the UI must not ask for it — pin it to the job's last historical pay (not zero, which silently
  pays $0/mo if the end age is later moved past "now").

## Decisions for the implementation session

Build **variant E**: two salary anchors labelled by *when*, one age-ordered pay list running
through the "now" seam, under a lifetime age axis charting **pay only**.

- **Age is the only vocabulary needed.** No month picker, and no change to Base + Adjustments —
  its `[0, lastMonth]` month clamp is correct and history is not authored there.
- **Never co-plot net worth over the historical span.** The empty region left of "now" reads as
  a missing feature rather than as the rule, and back-filling it looks more plausible and is
  wrong. Income is a flow and drawing it across the past is fine; a balance is a stock.
- **Style the month-0 step neutral**, never as a warning — warning styling invites users to fix
  the one thing the engine deliberately does not reconcile.
- **Start salary keeps its VALUE when the start age changes**, not its meaning: the start age
  *is* its date. Moving start 30 → 28 leaves the number alone; it now means "at 28".
- **Moving the start age forward drops stranded pay changes, with a note** naming which went.
  Clamping stacks two changes onto one month; silent deletion loses an authored fact. **Nothing
  in the prototype implements this** — it is the one decision with no worked example behind it,
  and the likeliest to get half-built.
- **Chart pay as a staircase, not interpolated.** Straight interpolation invents raises between
  changes and smooths the month-0 jump into a slope, hiding the exact thing the chart exists to
  show.
- **Clamp the age field on the way into state, not just on blur.** A default outside the job's
  span submits unchanged if the user never touches it (found via a job that ended at 26 opening
  at age 41).

## Dead ends

- **Do not "fix" the month-0 discontinuity by carrying the historical series across the
  boundary.** The authored current salary already reflects historical raises, so continuing the
  series reapplies them. Tried in the first pass, reviewed, replaced by the anchor design. A
  future agent seeing a salary step at month 0 will be tempted to close it — it is intentional.
- **An `untilNow` / `fromHereForward` scope field on `JobPayChange` was specified, then dropped.**
  Redundant: a historical change later undone is already two dated changes. Month sign carries it.
- **Deriving one salary anchor from the other** (de-growing `currentSalaryCents`, or growing
  `startingSalaryCents`) was rejected twice — for the one-field Jobs form, and again this session
  for the start-age-change case. It couples two independent authored facts and breaks as soon as
  a job has historical pay changes.
- **A separate "Pay history" surface for pre-now changes was prototyped (variant C) and rejected.**
  It mirrors the engine's month-sign split, which forces the user to answer "before or after
  now?" as a *navigation* question before they can find the right form.
- **Putting the start salary in the job form's Advanced disclosure was prototyped (variant B) and
  rejected.** The start salary and the pay-change list end up in different disclosures, so the two
  facts that combine to make history are never on screen together.

## Deferred

- **The historical-authoring UI itself is designed but not built.** The original blocker
  description was partly wrong and should not be trusted: the Jobs panel **already has** an
  age-dated pay-change form (`components/jobsPanel/payChangeForm.tsx`). Only two things block
  history there — `min={currentAge}` on its age input, and `Math.max(0, …)` in
  `jobsPanel.tsx:145`. The genuinely new work is the second salary anchor
  (`planPeople.ts:134-138, 171-175` set both from one field) and the chart.
- **#231 — job aggregate readers ignore job spans.** `personMonthlyIncomeCentsOf`,
  `householdMonthlyIncomeCentsOf` and `personDeferralFractionOf` count finished jobs; the 50/30/20
  quickstart writes budget lines off the inflated figure. Pre-existing, unrelated to #83, filed
  with tasks. Do not fold it into this work.
- **#34 — the partial-first-year calendar discrepancy** is unchanged and still documented at
  `compilePersonPriorEarnings` in `packages/engine/src/compilePerson.ts`.

## Traps

- **Run vitest from the repo root** (`npx vitest run packages/engine/src/foo.test.ts`). The
  workspace config resolves its root to `packages/engine` while the `include` glob is written from
  the repo root, so running inside the package reports "No test files found" rather than failing
  loudly.
- `projectionFacade.test.ts` (~line 545) asserts `toEqual` on the **whole** `salary` object, so any
  new `SalaryTrajectory` field fails there and nowhere else. ~45 other fixtures build `salary`
  literals; typecheck catches those, but a literal split across a comment line will slip a
  mechanical regex — that one did.
- **The prototype is throwaway and must not be imported by production code or tests.** It is a
  separate Vite HTML entry (`packages/app/prototype-pay-history.html`) with its own in-memory
  model that does **not** use the engine — its numbers are illustrative, not authoritative.
  Delete it and the `prototype/` directory once E is folded into `jobsPanel/`.
