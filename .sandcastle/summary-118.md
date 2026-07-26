# Issue #118 — Let a partner have their own jobs (authorable partner income)

## Overview

A married partner could join the household (a `RelationshipEvent`) but joined with
`jobs: []` — no earned income, no 401(k) deferral, no Social-Security-covered earnings of
their own. This change lets the user author a partner's job(s) at the moment they join,
using the **same** `Job` model and job form the primary earner uses, scoped to the
partner. The partner's jobs now drive their earned income, deferral, and covered-earnings
/ benefit basis in the projection **and** the snapshot cross-section.

The issue framed this as "a UI follow-up, not an engine change," on the premise that the
engine already compiled every member's jobs. That premise held only for the pre-"now"
covered-earnings record (computed for all memberships by `compilePerson`); the
**forward income series** for a partner's jobs was compiled *nowhere*. A partner with a
$2,000/mo job produced $0 of projected income. So this change is both engine (compile the
partner's forward job income) and UI (author the jobs).

## RGR Verification Details

**RED (engine).** Added `RelationshipEvent — partner jobs` tests to
`packages/engine/src/events.test.ts`: a partner joining with an open-ended $2,000/mo job
should reach $24,000 net worth over 12 months, and its income should stop at a separation
($10,000 through month 5). Both **failed at $0** — proving the engine never compiled the
partner's forward income. A third test (partner with no jobs → $0) passed from the start,
pinning "single-earner plans unchanged."

**GREEN (engine).** Taught `compilePersonIncomeSeries` / `compileJobIncome` to accept an
optional `MembershipWindow` that clips a job's *paid* span to `[joinMonth, separationMonth)`
without moving the growth anchor, then compiled each event-added membership's jobs in
`interpretLedger` (`toHousehold`) into `household.series`. Both tests went green.

**RED (app).** Added `relationshipForm.test.tsx`: authoring a job via the form and adding
the partner should emit a `RelationshipEvent` whose `person.jobs` carries the salary,
owned by the partner. Failed — there was no "Add a job" affordance.

**GREEN (app).** Extended `RelationshipForm` to disclose the shared `JobForm`, collect a
list of partner jobs (add/remove), and build them via a new owner-scoped
`buildJobFromDraft`. All three form tests green.

**Consistency guard.** Added a snapshot test proving the partner's job income appears in
the `buildSnapshot` cross-section (the app's real snapshot path) exactly as it drives the
projection — the two consumers read the same `Household`.

## Key Decisions & Why

- **Compile partner income in `interpret.ts`, not at the sim boundary.** My first cut
  compiled partner jobs in `buildHouseholdInput` (the projection path only). That would
  have let the chart show partner income while the **snapshot** (which reads
  `household.series` directly) missed it — violating the codebase's core invariant that
  projection and snapshot read one identical `Household`. Moving the compilation into
  `toHousehold` puts the series in `household.series`, so **both** consumers see it.
- **A `MembershipWindow` that clips the paid span but not the growth anchor.** A partner
  joining at month 60 must not earn before month 60, and must stop at separation. The
  window narrows *where the series pays* while `anchorMonth` keeps salary growth anchored
  at the job's own start, so the today's-dollars salary is correct at every paid month.
  When the window is omitted (the primary earner, always present) the series compiles
  **byte-for-byte as before** — `paidStart == naturalStart == startMonth` — so no existing
  plan changes.
- **`endMonthExclusive = membership.endMonth`.** The separation handler sets
  `membership.endMonth = separationMonth` and ends a partner's other income streams at
  `separationMonth - 1`. Clipping the job's exclusive end to `membership.endMonth`
  reproduces that exact convention (last paid month = separation month − 1).
- **Derived series, `causedByEventId: null`.** Partner job income is *derived* from the
  membership on every interpretation (like the primary's base income), so removing the
  `RelationshipEvent` drops the membership and its income automatically — no explicit
  dependency wiring needed.
- **Author jobs from the partner's own affordance (the join form), reusing `JobForm`.**
  The issue offered two UI homes; the partner lives in the ledger (an event) while the
  primary's jobs live in the `Plan`, and the Jobs panel edits the `Plan`. Wiring the Jobs
  panel to mutate ledger events would need a new "edit event" capability. Authoring the
  partner's jobs where the partner is authored is the minimal, self-contained surface that
  meets every AC and reuses the identical job form.
- **Owner-scoped `buildJobFromDraft`.** Generalized the private `jobFromDraft` to take an
  `ownerId`, so one builder serves the primary person and a partner; the primary path just
  calls it with `PRIMARY_PERSON_ID`.

## Changes Made

- **`packages/engine/src/compilePerson.ts`** — new exported `MembershipWindow`;
  `compileJobIncome` / `compilePersonIncomeSeries` accept an optional `membership` window
  that clips the paid span (join → separation), anchoring salary growth at the job's
  natural start. No-op (byte-for-byte identical) when omitted.
- **`packages/engine/src/ledger/interpret.ts`** — factored the owned-series → household
  mapping into `ownedSeries`; new `partnerJobSeries` compiles each event-added
  membership's jobs (clipped to its window) into `household.series`, so projection and
  snapshot share the identical partner income.
- **`packages/app/src/planPeople.ts`** — `blankJobDraftForAge` (age-parameterized blank
  draft) and exported owner-scoped `buildJobFromDraft`; `jobFromDraft`/`blankJobDraft`
  now thin wrappers for the primary person.
- **`packages/app/src/components/addEventForm/relationshipForm.tsx`** — a "Jobs
  (optional)" section: add jobs via the shared `JobForm`, list/remove them, and build the
  partner `Person.jobs` scoped to the partner on submit. A partner with no jobs joins
  exactly as before.
- **Tests** — `events.test.ts` (partner forward income + separation clipping + no-jobs
  baseline), `snapshot.test.ts` (partner income in the snapshot), `relationshipForm.test.tsx`
  (author / multi-add / remove partner jobs).

## Verification & Testing

- `npm run check:purity` → engine purity passes (no I/O, no app/rules imports).
- `npm run typecheck` → clean.
- `npm run test` → **732 tests green** (45 todo), 61 files. Engine suite alone: 439 green.

## Review follow-ups (both bugs found in review, both fixed here)

**1. The income-vs-spend graphs ignored the ledger entirely.** Adding a partner with a job
moved the net-worth chart and the snapshot but not the "Monthly income by source" graph
below them. Root cause was not partner-specific and predates this issue: the
**Base + Adjustments** panel ran its *own* `Projection.create({ plan })`, whose ledger is
empty — so no timeline event of any kind (an expense event, a home purchase, a separation)
ever reached its income, spending, or tax graphs. The panel now takes the app's ONE
projection (plan + ledger) as a prop, the same series the net-worth chart and snapshot
read, and projects nothing itself. Verified in a real browser: the partner's job draws as
its own wage band and the income row reads $5,000 + $2,000 = $7,000.

**2. A partner's jobs were write-once.** They were authored at the join form and
unreachable afterwards — the Jobs panel listed `primaryJobs(plan)` only, and the app could
add/remove ledger events but never revise one. Two changes close it:

- **`updateEvent(ledger, id, next, base)`** (`packages/engine/src/ledger/updateEvent.ts`) —
  the third ledger write beside `addEvent`/`removeEvent`. Replaces an event in place,
  keeping its id, type, and sequence number (all three are what dependencies and §6 ordering
  are built on), and blocks the revision — naming the offender — if the resulting ledger no
  longer replays cleanly. Surfaced on the app as `useLedger.reviseEvent`.
- **The Jobs panel now lists every household member's jobs**, each row named by its owner
  once a second earner exists, with an owner picker on the job form. Adding, editing,
  deleting, and *reassigning* a job all work for either member. `jobOwnersOf`
  (`packages/app/src/jobOwners.ts`) is the seam: it hands the panel one uniform owner list
  and a `writeTarget` saying which plane to write back to — `Plan.jobs` for the primary
  person, a revision of the `RelationshipEvent` for a partner — so the panel never has to
  know the difference. Ages everywhere resolve against the **owner's** birth year.

Also exported `MembershipWindow` from the engine barrel: `compilePersonIncomeSeries` is
public and takes one, so callers could not name the parameter type.

**3. The partner's life-stage ages are now authored, not invented.** Their age (40),
retirement age (65), and claiming age (67) were all hardcoded — free while a partner had
no jobs, load-bearing the moment they became an earner. `birthYear` decides when their
open-ended jobs stop (+ `retirementTargetAge`), when their Social Security starts (+
`benefitClaimingAge`), their RMDs, and the calendar years their authored job ages resolve
to, so every partner's benefit landed in the same year whoever they were.

The join form now asks for their **age in the year they join** (`Their age in 2031`,
re-anchoring as the join month moves) — the age the user has in mind at the moment the
form describes; the birth year is derived from it. Ages, not a birth year, because that is
the unit the rest of the app speaks. Their **retirement** and **claiming** ages sit behind
the `Advanced` disclosure (§10.4) with the same 40–80 / 62–70 bounds the primary earner's
carry, labelled "Their …" since the primary's own versions are on screen at the same time.
Deliberately *not* chained to their current age the way the primary's are: a partner who
has already retired is a real thing to author.

Pinned by three engine tests (`events.test.ts`, stub benefit seam): a partner's benefit
starts on *their* clock, moves when they claim later, and their open-ended job stops at
*their* retirement age. Confirmed in the browser with a 62-year-old partner earning
$4,000/mo, retiring at 64, claiming at 70 — household income reads $9,000/mo while both
work, $5,305 once their wage stops at 64, and $9,503 once their benefit begins at 70. With
only a two-year career the benefit is correctly $0: the US rules' 40-credit gate.

**4. Each person's government benefit is now its own band, named.** With two claimants the
income graph drew one "Social Security" band in Simple (both benefits summed into it) and
two identically-labelled "Government benefit" bands in Advanced — a legend entry repeated,
saying nothing. A benefit label names the *kind* of income, never the earner, so:

- `ProjectionIncomeSource` now carries `ownerId` (it was already on the internal source and
  dropped at the reporting boundary), so a consumer can say whose income a band is.
- Simple collapses the benefit **per person** rather than outright — it already bands a
  two-earner household's wages per person, so folding their benefits into one hid exactly
  what the wage bands show. Each claims on their own record, at their own age, so the two
  starts differ and that is the thing to read off the chart.
- Both views name the earner (`Social Security · Sam`) **only when two of them are on the
  chart** — a single-earner plan reads exactly as before, with no redundant "· Alex".
- The benefit left the blue family for a two-step teal one. Validated with the dataviz
  palette checker: the old single steel blue `#6b93b8` sat ΔE 4.0 from the second job's
  wage band — a benefit was already near-indistinguishable from a paycheck — while the two
  teal steps separate at ΔE 17.9 normal / 17.8 CVD, past the ≥15 / ≥8 floors.

Worth knowing for later: the validator will not pass this chart's palette as a whole. With
four wage steps, two benefit steps, and four drawdown steps it carries more categorical
series than colour can separate (its own worst pair is two wage blues at ΔE 8.5), and the
prescribed fix is fewer bands or faceting, not another hue.

**5. An untitled job is named after its owner, not its id.** The band label fell back to
the job's id, which reads tolerably for the primary earner (`Income · job-1`) and not at
all for a partner, whose ids are generated from their person id (`Income · p-0-job-1`).
It now falls back to the owner (`Income · Sam's job`). Ordinals appear only where they
must — a person holding several untitled jobs gets "Sam's job 1" / "Sam's job 2", since
one name for two bands identifies neither; a lone untitled job stays unnumbered, so its
label cannot shift as other jobs come and go. A band's identity is its `sourceId`
throughout; this is display text, and the debug report gets the same fix.

**6. Editing a job is one operation — fields and owner together.** Reassignment was two
unrelated writes: the job was removed from one member's list and a *new* one minted on the
other from the form draft alone. The draft is a projection of a job, not the whole of one,
so the job came back with a fresh id and without its one-month overrides, its permanent pay
changes, or its employer match — and if the ledger half of the move was refused (§6.1) after
the plan half had been written, the job was lost outright.

- **`applyJobDraft(job, birthYear, draft)`** (`planPeople.ts`) applies the form's fields onto
  the **existing full `Job`**, carrying everything else — id, overrides, pay changes, the
  deferral's account and match, and any field added to `Job` later — untouched. `updateJobInList`
  is now one line over it, and its hand-written graft-back of the same fields is gone.
- **`editJob(owners, sourceOwnerId, jobId, draft)`** (`packages/app/src/jobEditing.ts`) is the
  single domain operation: it resolves the job and the target owner, applies the draft **once**
  against the *target's* birth year (an authored age follows the job to its new owner), and
  returns the complete set of list rewrites — one for an in-place edit, two for a transfer. Every
  check runs before any write is produced, so a refused edit yields no writes at all.
- **The commit is atomic across the two planes.** `useLedger.reviseEvents` replays a batch onto
  one ledger value and reports whether it committed; the Jobs panel writes the ledger side first
  and the plan side only if it was accepted. A job can no longer be removed from one member and
  missing from the other.

Pinned by 11 tests in `jobEditing.test.ts` (in-place edit, owner + salary + dates in one
submission, id/overrides/pay-changes/match preserved across a transfer, ages re-read against the
target owner, and each unresolvable edit writing nothing) plus two panel tests: the whole job
surviving a real plan → ledger reassignment, and a refused ledger revision leaving both planes
untouched.

**7. Adjustments and the 401(k) nudge now see every earner.** Two surfaces still read
`primaryJobs(plan)` — which is *only* the primary person's jobs, since a partner's ride
their `RelationshipEvent`:

- **The Base + Adjustments pay-change control.** Its job picker listed only the plan's jobs,
  so a partner's bonus, missed paycheck, one-month correction, raise or cut had nowhere to
  land. It now lists every member's jobs, owner-qualified (`Sam · Job 1`) so two jobs with
  the same title are told apart, and each adjustment routes to its job's own plane. The
  routing is not written here: `ownedJobsOf`/`reviseJob` (`jobEditing.ts`) find the job and
  hand back a write, and `commitJobWrites` (`jobWrites.ts` — extracted from the Jobs panel,
  now shared by both) commits it, ledger side first and all-or-nothing. `reviseJob` is handed
  the whole existing `Job`, so overrides, pay changes and every unrelated field survive. The
  Jobs panel's "remove pay change" button routes the same way; it was plan-only, and would
  have silently done nothing on a partner's job.
- **The elective-deferral limit is per PERSON** (§5.4), so `firstDeferralLimitCrossing` now
  scans the household roster rather than the plan: each earner's jobs summed against *their*
  age-indexed limit over *their* working years, never pooled, and the crossing names whose it
  is. Pooling would have invented a warning for a couple who has none ($20k + $20k is two
  people inside a $24,500 limit), and reading a partner's deferral at the primary earner's
  age would read the wrong catch-up band.

The quickstart's 50/30/20 split reads household income for the same reason — budgeting a
two-earner household off one earner's pay sized its spending to half its income. Identical on
a single-earner plan.

Pinned by 12 tests in `deferralLimit.test.ts` (unchanged single-earner behaviour, one person's
jobs aggregated, a partner's crossing found and read at their age, two earners not pooled, the
earliest crossing winning, a partner scanned against their own retirement age) and 8 in the
panel suites: a partner's raise, cut, bonus, missed paycheck and one-month correction — each
landing on the ledger plane with the rest of the job intact and the projection moving — plus
the picker naming both members' jobs and the nudge naming whose limit was topped.

## Notes for the next iteration

- ~~**In-place editing of an existing partner's jobs** is deferred; it needs an "update
  ledger event" capability the app does not yet have.~~ **Done** in the review follow-ups
  above: `updateEvent` on the engine, and the Jobs panel generalized to every member.
- Partner jobs carry their own `sourceId` (`job:<id>`), so the #99 per-source income
  bands render a partner's jobs as their own bands for free.
