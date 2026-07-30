# Handoff — issue 194

**Completed so far:** tasks 1-5 (Declare the input types; Resolve refs; Build fromInput; Re-prefix
the goal fund account; Convert PLAN_DEFAULTS)

## Live constraints

- **Engine surface.** Types live in `packages/engine/src/scenarioInput.ts`; ref resolution in
  `scenarioRefs.ts`; the applier is `Projection.fromInput` in `projectionRoot.ts`. `EventEntry`
  discriminates on **`type`** via `eventEntryType()` (exhaustive `never` default) — extend that
  switch, never a parallel one. `ScenarioInput` and `FromInputResult` are now re-exported from the
  **facade** (`projectionRoot.ts`), not just the barrel — the `planWrites.guard.test.ts` check at
  its "names nothing … the facade module does not export" test scans EVERY shipped app module
  (seeds included) against `projectionRoot.ts`'s exports, so anything task 6 names from
  `@finley/engine` in `presets.ts` must be re-exported there. `nullJurisdiction` is NOT on the
  facade; task 5 built PLAN_DEFAULTS under `usJurisdiction` from `@finley/rules` (unscanned) to
  avoid widening the surface — do the same in presets, or add `nullJurisdiction` to the facade with
  a justifying comment.
- **`fromInput` takes a jurisdiction:** `Projection.fromInput(input, jurisdiction): FromInputResult`
  — NOT the bare `fromInput(input)` the issue's Shape section shows. The §4.5 down-payment
  affordability gate only fires under a real jurisdiction. `presetState` already projects presets
  under `usJurisdiction`; a `buyHome` authored in a preset's `events` would be gate-checked if built
  through `fromInput` under `usJurisdiction`. The current `student-loan` preset only takes a loan,
  not a home, so this is latent — but any preset that buys a home must fund the down payment or
  `fromInput` will refuse it.
- **Goal fund account ids are `fund-<goal.id>`.** Once minted through `fromInput` a goal reads
  `goal-N` and its fund account `fund-goal-N`. A goal ref binds to `goalFundAccountId(goal)` (task
  2's model). Any fixture/assertion that named a fund account by a literal (`fund-emergency`) must
  derive it — task 5 did this in `fundingSourcePicker.test.tsx` via the exported `goalFundAccountId`.
- **Plan-plane apply order is goals → jobs → budget lines**, load-bearing (a job's
  `deferral.fundAccountRef` and a budget line's `accountRef` can name a goal's derived fund account;
  a goal points at nothing). A deferral with no `fundAccountRef` defaults to `RETIREMENT_ID`.
- **Well-known refs** (`WELL_KNOWN_REF_IDS`, exported) resolve to themselves: `PRIMARY_PERSON_ID`,
  `SAVINGS_ID`, `RETIREMENT_ID`, `BROKERAGE_ID`, `SYNTHETIC_CARD_ID`.
- **A partner's nested `marry` jobs drop `ownerRef`** — `marry` stamps the owner it mints; the
  nested job's own `ref` is validated but never consumed.
- **Refusal shape:** `ScenarioInputError { reason, eventIndex?, ref? }`; event failures carry the
  index/ref, plan-plane failures carry only `reason`. **All-or-nothing** — a refusal returns
  `{ ok: false }` and no projection escapes. Don't add a partial-return path.

## PLAN_DEFAULTS conversion (task 5) — the pattern task 6 mirrors, and where it differs

- `planDefaults.ts` now builds `PLAN_DEFAULTS` from a `ScenarioInput` (`DEFAULT_INPUT`) through
  `Projection.fromInput(..., usJurisdiction)` and reads `built.projection.plan`. The job and goals
  carry minted ids (`job-N`, `goal-N`); no `job-1`/`emergency`/`home` literal remains.
- **Budget lines are deliberately NOT routed through `fromInput`.** They are spliced onto the built
  plan as `budgetLines: toBudgetLines(defaultBudgetTemplate())`, preserving their stable
  label-keys (`housing`, `groceries`, …). This was intentional: the task 5 acceptance names only
  `job-1`/`emergency`/`home` (planDefaults) and `seed-*` (budgetTemplate) for removal, and
  `budgetTemplate.test.ts` guards that `defaultBudgetTemplate()` lines keep "stable ids". Several
  app tests look budget lines up by these keys (`mainState.test.tsx` `id === "housing"`; the
  spending-editor route echo checks `"dining"`). **If task 6 routes preset budget lines through
  `fromInput`, those lines get minted `line-N` ids** — decide per preset whether that breaks a
  lookup. The `presets.test.ts` "seed-savings" fixture is self-authored (not from the seed helpers)
  and is fine to leave.
- **`budgetTemplate.ts` seed helpers are now ID-free.** `seedSavingsLine`/`seedExpenseLine` return
  `BudgetLineInput` (no `seed-*` id); `redistributeToTiers` keys them via `toBudgetLines` (label
  fallback). Behaviour is unchanged — the panel's `addBudgetLine(seed)` keeps the label as the
  line's id, same as it kept `seed-savings` before.
- **Test fixtures that named PLAN_DEFAULTS's old ids became lookups**, not new literals:
  `PLAN_DEFAULTS.jobs[0]!.id` / `.goals.find(g => g.name === …)`. Self-contained fixtures that build
  their OWN plan/job/goal with a literal id (e.g. `jobsPanel.test.tsx`'s `richJob`,
  `goalsDelete.test.tsx`'s `id: "home"`, the two-earner `job("job-1", …)` builders in
  `deferralLimit.test.ts`) were left alone — a fixture naming its own id is allowed; only ids that
  refer to PLAN_DEFAULTS's now-minted entities had to change.

## Dead ends

- (none)

## Deferred

- **Task 6** converts the presets in `presets.ts` to `ScenarioInput` values built through
  `fromInput` and deletes `buildPresetLedger`. Note `presets.ts` currently hand-writes `job-1`,
  `e0`, `loan-student` and reuses PLAN_DEFAULTS via `...PLAN_DEFAULTS` (which now carries minted
  ids — still a valid `Plan`, so spreading it is fine). `presetState` stamps authored events into a
  ledger via `resetLedger`; whether that stays or each preset becomes a full `ScenarioInput` (plan
  + `events`) is task 6's call. There is **no `id?` field on any `ScenarioInput` entry**, so a
  preset cannot pin an id through `fromInput` alone — the loan event's `loan-student` id, if any
  test depends on it, must survive some other way (or the test derives it). Re-read the issue's
  "Relationship to #200 and #202" and the last task note before assuming the conversion is pure.
