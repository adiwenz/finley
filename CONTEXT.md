# Financial Life Simulator — Engine

A pure, event-sourced simulation engine that projects a household's month-by-month net
worth from a ledger of entered financial facts and life events, and solves for a
retirement age. Seeded from `BUILD_SPEC.md`/`ARCHITECTURE.md`; sharpened live during the
spec-interrogation ("grilling") session — see `DECISIONS.md` for the resolutions that
prompted term changes here.

## Language

**Ledger**:
The ordered, immutable list of `Event` records — the sole source of truth for the plan.
_Avoid_: history, event log (use "ledger" specifically for the stored record list).

**Projection**:
The derived month-by-month net-worth output produced by replaying the ledger. Never
persisted as truth — recomputed fresh whenever the ledger changes.
_Avoid_: simulation result, forecast (reserve "forecast" for user-facing copy only).

**CashFlowSeries**:
The reusable primitive modeling any recurring dollar amount that changes over time
(salary, rent, groceries, debt payments). Carries a baseline, a growth mode, and
overrides.
_Avoid_: stream (used loosely elsewhere in the spec, but "series" is the precise type name).

**Account**:
A balance-holding entity, either `asset` (compounds) or `liability` (amortizes). Always
carries an `ownerId`.
_Avoid_: wallet, balance (balance is a property of an Account, not a synonym for it).

**Durable entity**:
`Person`, `Child`, or `Property` — created by an `Event` but thereafter a first-class,
independently-editable object with an ongoing life. The creating event is its *origin*,
never its edit surface.
_Avoid_: "owned object" (ownership is `ownerId`, a different, narrower relationship).

**Dependent artifact**:
An `Account` or `CashFlowSeries` that exists only as a consequence of an `Event` (a
mortgage, a child-support stream) and has no independent life. Tagged with
`sourceEventId` for provenance, but provenance never dictates its editing surface.
_Avoid_: byproduct, side effect.

**Provenance**:
The `sourceEventId` (or `appliedRecommendationId`) tag recording *what created* an
artifact, kept for lineage and undo. Distinct from — and never determinative of — where
the user edits that artifact.

**One-time transfer**:
A discrete, dated movement/injection/removal of money at a specific month (influx,
outflow, or proportional shock), as opposed to an ongoing `CashFlowSeries`. Never
compounds.
_Avoid_: transaction (reserve "transaction" for future ledger/persistence layers, if any).

**Goal**:
A prioritized funding target competing for cash in the allocation waterfall. Two kinds:
**one-time goal** (accumulate to a target, then spent by an event — e.g. a house down
payment) and **horizon goal** (accumulate toward a target date, then draw down over time
— e.g. retirement, college).
_Avoid_: milestone, target (target is a property of a Goal, not a synonym for it).

**Override** (scope):
A user edit to a `CashFlowSeries` at a point on the timeline, in one of two forward-acting
scopes: `thisMonthOnly` (perturbs one month) or `fromHereForward` (starts a new segment).
Both act from the edit month forward.
_Avoid_: edit, change (too generic — "override" is the precise mechanism).

**History correction**:
A THIRD edit operation, distinct from an override: an in-place change to a closed
historical segment's stored value (fix an old salary, correct a superseded mortgage rate).
Creates no new segment and shifts no boundary (segment start/end stay event-owned, per
§10.7). Authored on an entity's history view, never through the scrubber's
this-month/forward prompt. See `DECISIONS.md` §11.10.
_Avoid_: backdated override (it is NOT an override — it neither rebases forward nor
perturbs a single future month).

**On-track %**:
`projected fund balance at target date ÷ target amount`, computed from the full
projection (future contributions + growth) — never "saved so far ÷ target."

**Allocation waterfall**:
The fixed, opinionated per-month order that routes net cash flow: per-income-source
pre-tax deductions → personal cash pool → shared pool (proportional-to-income by default)
→ shared goals in priority order → personal goals → shortfall cascade. Not user-configurable
except for three named levers (contribution %, shared-contribution scheme, goal priority
order + surplus-cash destination). The ordering is fixed plumbing, never user-configurable.
_Avoid_: budget rules, allocation policy (waterfall is the precise term; "policy" is used
loosely in the spec but "waterfall" names the specific fixed sequence).

**Lever**:
One of the (now four) user-exposed choices *within* the fixed waterfall: per-person 401(k)
%, shared-contribution scheme (proportional vs. even), goal priority order, and default
surplus-cash destination (idle-in-liquid vs. swept-to-investment). Everything else about the
waterfall is under the hood. See `DECISIONS.md` "Waterfall configurability."
_Avoid_: knob, setting, option (the spec's own word is "lever," and it is deliberately a
small closed set).

**Surplus cash**:
Unallocated cash remaining in a month after every goal in the priority order is funded. Its
default destination is a lever: idle-in-liquid (default) or swept-to-investment.
_Avoid_: leftover, discretionary income (too vague — "surplus cash" is the post-allocation
residual specifically).

**Shortfall cascade**:
The specific fallback sequence when a month can't be covered from cash: skip discretionary
savings → draw down liquid assets → route the deficit to a credit-card liability (accruing
at its APR) → hard-infeasibility flag if credit is exhausted. Distinct from ordinary
negative net worth, which requires no intervention.
_Avoid_: shortfall handling, deficit logic.

**Hard-infeasibility**:
The terminal state where a monthly deficit exceeds all available liquid assets and credit
— the plan cannot be funded by any real mechanism. Surfaced as the most severe flag the
tool produces.

**Liquid** (account flag):
Marks an `Account` as usable for the §4.5 down-payment check and the shortfall cascade's
drawdown step. `checking`/`savings`/`brokerage` = liquid; retirement accounts
(`401k`/`Roth`/`HSA`) = not liquid. See `DECISIONS.md` §11.1.

**Engine purity**:
The constraint that the engine is a pure function of its inputs — no I/O, no storage, no
app/jurisdiction-specific code. Jurisdiction specifics enter only through the jurisdiction
interface.

**Jurisdiction interface**:
The seam the engine defines and a `rules` package implements: `computeTax`, contribution
limits, and government-program formulas, all parameterized by year. The engine ships a
null jurisdiction (zero tax, no programs) so it runs standalone.

**EarningsRecord**:
An engine-owned, per-person accumulator filled as the simulator runs forward (every income
segment contributes), plus an optional entered pre-now earnings seed (§4.6 second historical-
financial-input exception). Pure engine bookkeeping with no jurisdiction knowledge — the
`rules` side reads it to compute the Social Security benefit via the jurisdiction seam.
_Avoid_: earnings history, wage record (this is the specific accumulator type).

**taxTreatment** vs. **taxCategory**:
Two distinct tax seams, not synonyms. **`taxTreatment`** is on `Account`
(`preTax`/`roth`/`taxable`/`hsa`) — how a balance/its withdrawals are taxed.
**`taxCategory`** is on an income `CashFlowSeries`
(`wages`/`socialSecurity`/`ordinaryIncome`/`capitalGains`/`taxExempt`) — how an income
stream is taxed. Both are present but ignored in v1. See `DECISIONS.md`.
_Avoid_: using "tax treatment" loosely to mean either — name the specific field.

**GovernmentProgram**:
A modeled income or cost change whose amount/availability is *derived* from the
household's history or age (not entered directly) — e.g. Social Security, Medicare.
Three shapes: derived income stream, eligibility-triggered step change, and (deferred)
means-tested phase-in/out.

**Nudge**:
A prompt surfaced when the user authors a life event that plausibly changes a related
budget item (e.g. job-change / early retirement → adjust the `category:"health"` item;
home purchase → end a housing item), typically with a pre-filled suggested value. A nudge
never silently rewrites a user-controlled value — it makes the change user-authored,
honoring the anti-deception rules (§10.3). See `DECISIONS.md` §11.12.
_Avoid_: auto-adjust, automatic step (a nudge is explicitly NOT silent/automatic).

**Backdating** / **"now" marker**:
Entering events dated before the present. "Now" is a distinguished point on the
simulation timeline; history before it establishes *structure only* (who/what exists) —
never a reconstructed past net-worth curve. Entered current balances are the sole source
of financial truth as of now.

**Job** (income source):
A single `CashFlowSeries` owned by a person representing one income stream. A person may
hold multiple concurrent jobs; each is independently anchored and may carry its own plan
descriptor (§5.5). "Job" and "income source" are used interchangeably — prefer "income
source" in engine-level contexts (it's the general primitive) and "job" in event/UI-facing
contexts (it's what the user calls it).

**JobChangeEvent**:
The event authored when a person's income source changes structurally (new employer, new
terms) — as opposed to a same-employer raise, which is a plain override. Reference-scoped
to exactly one income source (`targetIncomeSourceId`); does not touch a person's other
concurrent jobs. Ends the target income series and its plan descriptor, starts a new
income series with `resetAnchor: true`. See `DECISIONS.md` §11.8.
_Avoid_: job event (ambiguous — "JobChangeEvent" is the exact type name).

**Historical financial input**:
One of exactly TWO permitted entered-as-of-now facts about the pre-"now" past that feed a
forward calculation (everything else backdated is structural-only, §4.6): (1) year-to-date
401(k) contributions (for the partial-first-year contribution cap), and (2) the pre-now
earnings summary (to seed the `EarningsRecord` for Social Security). See `DECISIONS.md`
§11.17 and the SS-earnings gap.
_Avoid_: past finances, historical balance (those are exactly what §4.6 forbids — only these
two inputs are allowed).

**Recommendation**:
A machine-computed, mechanically-derived suggestion (never opinion) that closes a goal's
on-track gap, carrying a structured `change` payload the engine can apply via the ordinary
override path. Distinct from advice — the tool quantifies options, the user decides.

## Notes

- This is a **single-context** repo for now (the `engine`). If `rules` and `app` grow
  their own vocabulary as those repos come online (Phase 2/3 per `ARCHITECTURE.md`), split
  into a `CONTEXT-MAP.md` at that point rather than overloading this file.
- Terms here mirror `BUILD_SPEC.md`'s own vocabulary — this file exists to keep that
  vocabulary consistent and opinionated as it gets stress-tested during grilling, not to
  introduce new concepts unilaterally.
