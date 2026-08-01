# Prototype — authoring a job's pay history

**Throwaway.** Delete this directory and `packages/app/prototype-pay-history.html` once the
decision is made, or fold the winning variant into `jobsPanel/` and delete the rest.

## Run

```
npm run dev
open http://localhost:5173/prototype-pay-history.html
```

Bottom bar switches variants; `?v=a|b|c|d` is linkable. State is in memory, shared across
variants, and never touches the engine — switching mid-edit carries the same job over.

## The question

`handoff-83.md` § Deferred: the engine supports a start salary that differs from current pay,
plus pay changes at negative months, but **no UI can author either**. The scenario the spec
centred on — $60k start, $75k historical raise, $80k current — is API-only.

Two blockers were named. One turned out to be smaller than described:

- The Jobs panel **already has** a pay-change form (`payChangeForm.tsx`), dated in the owner's
  age. Its only obstacle is `min={currentAge}` on the age input plus `Math.max(0, …)` in
  `jobsPanel.tsx:145`. Base + Adjustments is not the only surface, so nothing has to move.
- The single salary field really does set both anchors (`planPeople.ts:134-138, 171-175`) and
  needs a second input. Deriving one anchor from the other was already rejected — see handoff.

So: **what does the second anchor plus pre-now pay changes look like, and where does it live?**

## The variants

| | Idea | What it's testing |
|---|---|---|
| **A** | Two anchors in the job form + one age-ordered pay list spanning the seam | Does folding history in make the month-0 step legible, or the form long? |
| **B** | Start salary in the existing Advanced disclosure; relax the age floor | Is the cheap version usable, or is the anchor too hidden to connect? |
| **C** | A third "Pay history" button owning everything before now | Does mirroring the engine's split help, or force the user to answer "before or after now?" as a navigation question? |
| **D** | One age-0-to-85 lifetime axis; jobs as bars, income drawn across history | **Does drawing pre-now income imply it accumulated into net worth?** |
| **E** | A's editor under D's axis, charting the job's own pay | Does the combination buy anything neither had alone? |

D was added specifically to test the accumulation worry, so it renders the tempting thing on
purpose: a shaded historical income region and an "Earned before now: $828,600" figure. Two
checkboxes overlay net worth — honest (starts at "now", nothing to its left) and the lie
(back-filled from past earnings, dashed).

## Findings

- **The month-0 step is presentable.** A's inline seam row — "History reaches $6,250/mo; you've
  stated $6,667/mo as today's pay. Today's pay wins from here on." — states the discontinuity as
  an authored fact without inviting a fix. This was the main risk going in and it looks fine.
- **Age is sufficient; no month picker is needed anywhere.** Typing age 33 when you're 41
  produces `month: -96` with no vocabulary change. Confirmed live in the state readout.
- **The floor and the default are separate decisions, and getting the default wrong reads as a
  broken floor.** A's age field is floored at the job's *start* age (correct — a change before
  the job existed has nothing to apply to), but it originally opened at `currentAge + 1`, which
  biased every new change forward and made the surface feel clamped to "now". Now opens on the
  seam so the direction is an explicit choice.
- **Base + Adjustments should keep its `[0, lastMonth]` month clamp.** History is not authored
  there: that panel works off a month already selected on a chart that only spans the
  projection, and scrubbing it negative would mean drawing a period with no net worth in it.
- **B's weakness is visible immediately.** Its job row lists "age 36 → $6,250" and "age 47 →
  $7,500" identically, and the $60k start salary appears nowhere on the row at all. Past and
  future are indistinguishable without the user comparing each age against their own.
- **C hides the story it is authoring.** It renders A's unified list at the bottom under "what
  the split surfaces are hiding" — that contrast is the argument against C.
- **D: the accumulation worry is real, and it is the empty space that causes it, not the income
  area.** With `Show net worth` on and back-fill off, the green line begins at age 41 above a
  large shaded income region running back to 22. The gap does not read as "history doesn't
  affect net worth" — it reads as an unfinished chart. Ticking back-fill makes the line
  continuous and instantly more plausible, which is exactly the failure mode: once seen, the
  honest chart looks broken.

  D's income axis on its own (net worth off) is fine — that's a flow chart, and drawing earnings
  you actually had is honest. The danger is strictly co-plotting a stock with it.

- **E is the one to build.** Charting the selected job's own pay as a staircase turns the
  month-0 step from a sentence into a shape: a literal vertical jump at "now", annotated
  `+$417/mo` in place. Set the two anchors equal and the line goes continuous, the annotation
  disappears, and the copy switches to "History lands exactly on today's pay". The chart teaches
  the rule instead of explaining it — which is the one thing A's prose seam row could not do.

  Two details that mattered more than expected: pay must be drawn as a **staircase**, not
  interpolated (a straight line between changes invents raises and smooths the seam into a
  slope, hiding the exact thing the chart exists to show); and clicking the axis to seed a pay
  change works precisely *because* the axis is age — clicking left of "now" is an ordinary act
  requiring no new vocabulary.

  E carries D's income area and deliberately **omits D's net-worth line**, per the finding
  above.

- **A job that ended before now has no month-0 anchor, and the UI must not ask for one.** Found
  by trying to add a pay change to the Barista (ran 22–26) while 41: the form opened at age 41,
  the editor asked for that job's pay "Now (age 41)", and the chart drew a −$700/mo seam step at
  41 for a job that stopped fifteen years earlier. All three are nonsense.

  Two distinct fixes came out of it, and the second is the one that matters beyond the
  prototype:

  1. The age field needs an upper bound (`endAge - 1`), **clamped on the way into state** — not
     just on blur. A default outside the job's span submits unchanged if the user never touches
     the field.
  2. `currentSalaryCents` is **dead weight for an ended job**. The engine requires both anchors
     on every `SalaryTrajectory`, but for a job that finished before month 0 only
     `startingSalaryCents` plus its historical pay changes carry meaning. E now hides the "Now"
     input, the seam row, and the step annotation for such jobs, and says so plainly: *"This job
     ended at age 26, so it has no pay 'now'."* The app should fill the anchor in rather than
     interrogate the user about it.

  **Checked against the engine — answered.** `compileJobIncome` returns `null` on line 209
  (`if (endMonthExclusive <= 0) return null; // wholly in the past`), and the anchor is not read
  until line 221. `reconstructHistoricalCompensation` only ever touches `startingSalaryCents`.
  So for a wholly-past job `currentSalaryCents` is **never read**. A zeroed anchor would not
  "mean no income from now on" — the income is already zero from the span check.

  **Pin it to the last historical pay, not to zero.** The value being inert makes the choice
  free, which makes it purely about which latent state fails better. Zero has a delayed cost:
  push the end age past "now" (went back to the employer, or the age was a typo) and the job
  silently pays $0/mo forward. Mirroring continues it at its last known pay, keeps both anchors
  written together (no new case in `withMonthlyIncome`), and keeps the span-blind
  `monthlyIncomeCentsOf` returning something meaningful. E does this in `patch()`.

## Adjacent pre-existing bug — filed as #231, out of scope here

`currentSalaryCents` has readers that ignore the job's span, and they disagree with each other:

- `authoring/jobs.ts:485` `personDeferralFractionOf` — `jobs.reduce((sum, j) => sum + j.salary.currentSalaryCents, 0)`, no start/end filter.
- `authoring/jobs.ts:465-474` `personMonthlyIncomeCentsOf` / `householdMonthlyIncomeCentsOf` — same, via `monthlyIncomeCentsOf`.
- `app/deferralLimit.ts:79` — **does** filter (`if (year < j.startYear || year >= endYearExclusive) continue`).

Today's one-salary-field form writes a nonzero `currentSalaryCents` onto every job including
ones with a past end age, so those totals are already inflated by finished jobs. Pinning the
anchor to last historical pay (above) does not fix this — it is a filtering bug at the read
sites, not a value bug.

## Verdict

**Build E** — A's editor (two anchors labelled by *when*, one age-ordered pay list running
through the seam) under D's age axis, charting **pay only**.

Explicitly *not*: co-plotting net worth over the historical span, in any variant. D established
why — the empty region left of "now" reads as a missing feature rather than as the rule, and
back-filling it is instantly more plausible and completely wrong.

Everything else the prototype settled is in "Decided" below. Once E is folded into
`jobsPanel/`, delete this directory and `packages/app/prototype-pay-history.html`.

### Decided

**Month-0 step is styled neutral**, not as a warning. A pay cut, a job change, a stated current
salary that simply doesn't match the reconstruction — all legitimate. The step is an authored
fact, and warning styling would invite users to "fix" the one thing the engine deliberately does
not reconcile.

**Start salary keeps its VALUE when the start age changes**, not its meaning.
`startingSalaryCents` is defined as "pay at the job's start" — the start age *is* its date, it is
not dated independently. So editing the age from 30 to 28 leaves $5,000 alone and it now means
"at 28"; the reconstruction runs two more years at that rate. Rejected alternatives: converting
the old meaning into a pay change at 30 (invents an editing step, and isn't reversible — fiddling
with the start age leaves a trail of stray pay changes), and de-growing by `realGrowthPct` to
guess age-28 pay (already rejected in handoff-83 for coupling two independent authored facts).
Keeping the value is the only reading that neither invents data nor loses reversibility.

**Moving the start age forward drops stranded pay changes, with a note.** Start 30 → 33 orphans a
change at 31: it now predates the job and has no baseline to apply to. Clamping to the new start
age was rejected (it stacks two changes onto one month); silent deletion was rejected (it loses
an authored fact without saying so). So: drop them, and tell the user which ones went. The age
field is already floored at `startAge`, so this only arises from editing the start age of a job
that already has history — not from authoring. **Not built in the prototype.**
