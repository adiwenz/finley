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

## Notes for the next iteration

- **In-place editing of an existing partner's jobs** (post-join, e.g. from the Jobs
  panel) is deferred. It needs an "update ledger event" capability the app does not yet
  have (only add/remove). Today a partner's jobs are set when they join; changing them
  means removing and re-adding the partner. Generalizing the Jobs panel to edit each
  member's jobs owner-scoped (the issue's other UI option) is the natural follow-up.
- Partner jobs carry their own `sourceId` (`job:<id>`), so the #99 per-source income
  bands render a partner's jobs as their own bands for free.
