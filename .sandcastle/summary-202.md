# Migrate the app onto the Projection facade (both planes) and stop minting ids

## Overview

The app instantiated `Projection` in **zero** production places: it drove the low-level engine
pipeline by hand on the read path, wrote the ledger through the functional `addEvent` layer,
held `Plan` and `Ledger` as two separate React states, and minted its own ids into the engine's
namespace from seven sites. That is the two-write-paths problem: two authorities minting into
one scenario, safe only because they never acted on the same scenario at once.

This change collapses all of that into one atomic migration. React now holds a single immutable
`ProjectionState`. Reads go through one `Projection` handle (`run` + `funding`) rebuilt per state
change; every write builds a momentary handle, mutates it, and discards it — funnelled through a
single `useProjection` hook that owns the transaction discipline. No app file mints an id: the
facade's shared counter is the sole authority, and it is floored past whatever a state already
carries on the way into every write.

## RGR Verification Details

**Engine (RED → GREEN).** Added two tests to `projectionRoot.test.ts`:

- *"derives the mortgage liability id parent-suffixed from the property id"* — RED: `buyHome`
  minted `mortgage-home-1`; asserted `home-1-mortgage`. GREEN: flipped the derivation in
  `buyHome` to `` `${id}-mortgage` ``.
- *"answers the funding question from the current ledger's liquid balances"* — RED: `funding()`
  did not exist (compile failure). GREEN: added `Projection.funding()`, reusing the handle's own
  `baseConfig()` and validation jurisdiction so the picker and the §4.5 gate decide on the same
  numbers.

**App.** The migration is inherently atomic (read path, write path, state model, and id minting
cannot be separated), so the existing behavioral suite is the executable spec. `mainState.test`'s
14 integration tests — add/remove events, cross-plane partner-job edits, preset loads, the
loan-payment spend band, budget edits — all pass unchanged in intent, which is the "no behavior
change other than the id scheme" guarantee. The three memoization spies that watched the
now-encapsulated `createProjectionBase` were repointed to `Projection.fromState` (the app's
reprojection entry point, which `transact` also routes through) — the only observable left once
the base build moved inside the facade.

Unit tests for the changed seams were moved to the new shapes: the event sub-forms now assert the
**facade input** they hand `takeLoan` / `separate` / `haveChild` / `marry` / `buyHome` (via a
stub `Projection`), not a hand-built `NewLifeEvent`; `goalsView`'s `addGoal`/`freshGoalId` blocks
were removed (that behavior is now `Projection.addGoal`, covered in the engine).

## Key Decisions & Why

- **One `ProjectionState`, momentary handles.** A held mutable `Projection` is `Object.is`-equal
  to itself, so `useState` would bail out and re-render nothing; forcing it with a version counter
  makes React's state a lie and invalidates every memo on any write. React holds the plain value;
  writes pick up a handle, mutate, and drop it.
- **`useProjection` owns the discipline, and `transact` is the whole of it.** One write primitive:
  it runs any facade write — plan or ledger, one call or a batch — off `stateRef.current`, commits
  the resulting `ProjectionState` whole, and turns a refused write (the facade throws) into the
  `conflict` message, cleared only on a write that succeeds. The hook exposes no plan-shaped
  setter: one would take a `Plan` the hook could only accept on faith, while the id mint, the
  goal-funding guard and the affordability gate all live on the far side of the facade. A write
  spanning both planes is therefore one transaction, not two coordinated ones.
- **The counter is floored on the way in.** Every facade write builds through
  `fromState`, which floors the counter past every id the scenario already holds — including
  primary jobs the app still mints via `nextJobIdFor`. So the engine steps over an app-minted
  `job-N` before its next mint regardless, closing the collision the single-scenario model would
  otherwise open, without re-flooring on every keystroke.
- **`funding()` on the facade.** The home-purchase picker needs a `FundingLookup`, which needed a
  `base` from the now-banned `createProjectionBase`. Exposing it on the handle — reusing the same
  `baseConfig` and validation jurisdiction the affordability gate uses — keeps the picker and the
  gate from ever telling the user different stories.
- **Preset loading via `fromScenario`, structural stamping.** A preset's authored events are
  stamped in order into a ledger (identical to replaying through `addEvent` for a valid preset,
  which every preset is verified to be in `presets.test.ts`) and loaded through `fromScenario`,
  which floors both counters. This keeps `createProjectionBase` out of production without
  rewriting the preset seed data (its literal ids are #194's job).
- **Derived ids parent-suffixed.** `mortgage-home-3` → `home-3-mortgage`, matching the existing
  `p-3-job-1` convention so a sort groups derived ids under their parent. (Partner-job ids are
  now minted by `marry` as `job-N`, so the app-side `${partnerId}-job-N` scheme is moot.)
- **An edit aimed at something that is not there is refused — every collection, both planes.**
  The id came from somewhere that no longer agrees with the state, so the write the caller
  believes it made has not happened; reporting nothing is how that stays invisible. One
  `planSite` guard covers jobs, goals and budget lines, `partnerJobSite` covers a partner's
  jobs, and `addPartnerJob` never had the choice anyway — it returns a minted id, so there is no
  value a quiet no-op could hand back. `reorderGoal` refuses at the ends on the same reading:
  priority IS the list order, so "move the first goal up" is a caller believing it changed the
  funding order when it did not. The Goals panel disables the control there instead of clicking
  into a refusal, which a test now pins.
- **The app names nothing from the engine that `projectionRoot.ts` does not export.** One module
  now states the app's entire dependency on the engine — values and types alike — and the guard
  is checked against that module's own text rather than a list kept in the test. The line: a
  question about the household, the run, or the plan and ledger as a whole is a METHOD; what the
  facade re-exports is total over a value the caller already holds (a `Job`, a list of budget
  lines, a dollar amount) or is a constant. Twenty read functions became methods, taking the
  app's engine imports from 33 values to 13. Nothing that writes is exported there, which is
  what makes the rule enough on its own — asserted directly, so a facade that quietly re-exported
  `withPayChange` would fail.
  - On `Projection` — questions about the plan as authored: `retirement`, `accountDescriptors`,
    `eventsFundedByGoal`, `expenseRowsAt`, `jobMonthlyIncomeCents`, `jobDeferralFraction`,
    `personMonthlyIncomeCents`, `personDeferralFraction`, `householdMonthlyIncomeCents`.
  - On `ProjectionResult`, closing over the pass already in hand rather than provoking another:
    `snapshot`, `membersAt`, `goalProgress`, `assessHomePurchase`.
- **`retirement()` is one query, because the answers are not independent.** The headline age and
  the pinned-age verdict come out of the SAME search, and what to fall back to when the pin
  fails is part of the finding, not the caller's policy — assembling that across the boundary is
  how a panel and a chart come to describe different households. So `solveRetirement`,
  `evaluateRetirementAtAge` and `earlyRetireeHealth` are private, and one call returns the
  solution, the target evaluation with `nearestFeasibleAge` resolved, the health flag, and the
  chart's month offset. `run()` is untouched: a simulation is not a search, so a caller that
  only wants the graph never pays for one — pinned by a test.
- **`ProjectionReader` is the reading half, as a type.** A `Projection` is a mutable handle, and
  a write onto one nobody reads back is silently discarded — the exact failure this migration
  exists to prevent. Panels take the reader instead, so authoring from a view is a compile
  error and the prop says what it is for.
- **Compilation internals stay in.** `compileExpenseBudgetLines` is gone from the app surface;
  `expenseRowsAt(month)` returns the resolved amount and whether an override is what is showing
  — what the caller wanted — instead of a `SimOwnedSeries` with an owner tag that means nothing
  outside the pipeline. `resolveRowsAtMonth` and the app's editor-inflation helper went with it.
  - The per-job adjustments (`addJobPayChange`, `addJobIncomeOverride`, `setJobMonthlyIncome`, …)
    are owner-aware: a job id is unique across the household, so "give job-3 a raise" has one
    answer and the caller does not have to know which plane job-3 is on to ask for it. That
    retired `jobEditing.reviseJob` and the `withPayChange` / `withIncomeOverride` re-exports the
    panels applied themselves.
- **A raise is authored where the job is.** The Jobs panel lists a job's permanent pay changes,
  so it now adds and removes them too — "Change pay" on any row, dated in the OWNER'S age like
  every other date in that panel. Looking for a raise anywhere else means knowing in advance
  which month it lands in. Base + Adjustments still authors the same `JobPayChange` from the
  other direction (a month is already selected there) and remains the only place a single-month
  perturbation — a bonus, a missed paycheck — can be authored, because that belongs to a month
  rather than to the employment. The headline stays the *starting* salary, qualified with "to
  start" once a change exists, so the two never contradict each other.
- **Job writes are intents, routed per plane, facade methods on both.** `jobEditing` returns
  `add` / `replace` / `remove` rather than a `(jobs) => jobs` transform, because the write
  authority is the facade and a list callback had nowhere to be applied that wasn't the app
  rebuilding a job list. `commitJobWrites` is now pure dispatch inside one handle — `addJob` /
  `replaceJob` / `removeJob` for the plan, `addPartnerJob` / `replacePartnerJob` /
  `updatePartnerJob` / `removePartnerJob` for a partner. It builds nothing and mints nothing.
- **Removals are applied before adds.** A move is a remove plus an add carrying the same id, and
  the facade refuses an id the household already holds; landing the job before letting go of it
  would be refused as a duplicate of itself. Both are still one transaction.
- **One job-id namespace across both planes.** A partner's jobs were numbered `p-1-job-N`, which
  read as tidy and was not: `seqFloor` does not recognize that shape, so nothing stopped a later
  mint from issuing an id an imported partner already held. Partner jobs now mint `job-N` off the
  shared counter, and `Projection` refuses a supplied id already in use on either plane.
- **`JobWriteTarget` names a plane and carries no handle to one.** A caller only needs to know
  which family of job methods to call; `Projection` finds the `RelationshipEvent` by person id at
  write time, off the state it is committing against rather than a render-old snapshot.

## Changes Made

**Engine**

- `projectionRoot.ts`: `buyHome` derives `` `${id}-mortgage` ``; added `funding(): FundingLookup`.
  `addJob` now carries every `JobInput` field through (it dropped `name`, `incomeOverrides` and
  `payChanges`, which a job moving between members has to keep); added `replaceJob` (a wholesale
  rewrite keeping the id, so an absent field CLEARS where a patch could only ever add) and
  `addBudgetLineOverride` (beside `updateBudgetLine`, because a patch replaces the `overrides`
  array it is handed).
- `budgetLine.ts`: added `withLineOverride` — the one-per-(scope, month) rule, moved down from the
  app.
- `job.ts`: added `monthlyIncomeCentsOf` and `deferralFractionOf`, the read counterparts of
  `withMonthlyIncome` and `withDeferralFraction`. The engine owned each conversion in the write
  direction only, so the read was open-coded at five app sites — including the `?? 0` that reads
  an absent deferral as the 0% it was elected at, which is the same rule as removing it at 0.
- `projectionRoot.ts`: partner-owned jobs — `addPartnerJob` (mints off the shared counter),
  `replacePartnerJob`, `updatePartnerJob`, `removePartnerJob`. Each locates the person's
  `RelationshipEvent`, rewrites that person's `jobs`, and commits through the same `updateEvent`
  replay `reviseTransaction` validates with, landing ledger and counter as one state. `addJob` and
  `addPartnerJob` refuse a supplied id the household already holds, on either plane.
- `projectionRoot.test.ts` / `budgetLine.test.ts`: tests for each of the above.

**App — state model & hook**

- `hooks/useProjection.ts` (new): the single authoring hook — `state`, `conflict`, `transact`,
  `removeEvent`, `loadState`. Replaces `useLedger.ts` (deleted).
- `main.tsx`: holds one `ProjectionState`; reads via a `Projection` memo (`run` + `funding`) keyed
  on `state`; preset load via `presetState` + `loadState`; hands every panel the same `transact`.
  The five low-level pipeline calls are gone.

**App — creation through the facade**

- `goalsView.ts`: removed `addGoal` and `freshGoalId`.
- `baseAdjustments/budgetLines.ts`: removed `nextLineId`, `addLineFromDraft` and `removeLine`;
  a draft becomes facade input (`budgetLineInputFromDraft`) or a facade patch
  (`budgetLinePatchFromDraft`), both off a shared `lineBody`.
- `baseAdjustments/budgetTemplate.ts`: added `tierRebalanceWrites`, the 50/30/20 quickstart
  decomposed into the writes that perform it (rescales by id, plus a seed per empty tier) —
  derived by diffing `redistributeToTiers`' own output, so the rule keeps one implementation.
- `baseAdjustments/monthEdit.ts`: `applyLineOverride` moved into the engine as `withLineOverride`.
- `goalsView.ts`: also removed `setGoalRate`, `updateGoal`, `removeGoal` and `reorderGoal`.
- `goalsPanel.tsx` / `baseAdjustmentsPanel.tsx` / `jobsPanel.tsx` / `budgetEditor.tsx`: every
  edit — add, patch, reorder, delete, month override, quickstart, pay change — runs through
  `transact`. No panel holds a plan setter or rebuilds a plan.

**App — no id minting in forms**

- `addEventForm/formControls.tsx`: `FormProps` drops `nextId`; `onAdd` is now
  `(write: (p: Projection) => void) => void`.
- `childForm` / `loanForm` / `homePurchaseForm` / `relationshipForm` / `separationForm`: submit by
  calling the matching facade method (`haveChild` / `takeLoan` / `buyHome` / `marry` / `separate`);
  `addEventForm.tsx` drops `nextId`.
- `planPeople.ts`: added `jobInputFromDraft` (a `JobInput` for `marry`, no id/owner).

**App — preset & wiring**

- `presets.ts`: added `presetState(preset): ProjectionState`, built with `Projection.create` +
  `resetLedger` so no scenario is assembled by hand. `buildPresetLedger` — the replay oracle the
  preset tests check that state against — moved into `presets.test.ts`, its only caller.
- `jobEditing.ts` / `jobWrites.ts`: `JobListWrite` (a list transform) becomes the `JobWrite`
  intent union; `commitJobWrites` takes the hook's `transact` and dispatches both planes to facade
  methods inside it. `applyJobWrite` and `nextJobIdFor` are gone — the app has no job-list
  interpreter and no id authority left.
- `jobOwners.ts`: `JobWriteTarget` is `"plan" | "event"`.
- `planPeople.ts`: two functions span the draft seam and neither touches an id —
  `jobInputFromDraft` (a `JobInput`, so there is no `id` field to fill and no parameter to pass
  one through; the facade mints it and stamps the owner) and `jobToDraftFor`, which only reads.
  The plan-level wrappers `jobToDraft`, `blankJobDraft` and `primaryBirthYear` are deleted: each
  was a thin shim over the `*For` version, alive only because a test called it. The plan-level writers (`setJobMonthlyIncome`, `addJobPayChange`, …) live in
  `testing/planFixtures.ts` — they are fixture builders, and in the app layer they would be a
  second write path the guard could not rule out. Every one of them ADJUSTS a job the plan
  already holds; none creates one, because creating means minting and the counter belongs to
  `Projection`.

**Tests** updated to the new seams: `mainState`, `subForms`, `relationshipForm`,
`fundingSourcePicker`, `homePurchaseForm`, `goalsView`, `goalsPanel`, `goalsDelete`,
`baseAdjustmentsPanel`, `jobsPanel`.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity holds.
- `npx vitest run` — **1104 passed | 45 todo (88 files)**.
- `packages/app/src/planWrites.guard.test.ts` scans app production source and fails on a
  `Dispatch<SetStateAction<Plan>>` prop, a plan-collection rebuild, any function returning a
  `Plan`, a rebuild of a partner's `jobs` on the event carrying them, or a minted job id. Seed
  modules and `src/testing/` are exempt by location.
