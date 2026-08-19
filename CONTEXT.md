# Financial Life Simulator — Engine

A pure, event-sourced simulation engine that projects a household's month-by-month net
worth from a ledger of entered financial facts and life events, and solves for a
retirement age. This glossary is the project's ubiquitous language — the canonical
vocabulary for the domain.

## Language

### Core model and identity

**Ledger**:
The ordered, immutable list of `Event` records — the sole source of truth for the plan.
_Avoid_: history, event log (use "ledger" specifically for the stored record list).

**Projection**:
A scenario as something you can act on — edit it, add events to it, run it. The bare word
means this; every derived-output concept carries a suffix. In code it is a momentary handle
picked up to make a change and put down again, never the resting place of state.
_Avoid_: simulation (that names the math layer), editor, store, session.

**Projection state**:
A projection at rest — the plain immutable value holding the scenario plus the bookkeeping
authoring needs. What an application keeps as its state, and what serialises.
_Avoid_: document, snapshot, store.

**Projection output**:
The derived month-by-month net-worth result produced by running a projection. Never
persisted as truth — recomputed fresh whenever the projection changes.
_Avoid_: simulation result, forecast (reserve "forecast" for user-facing copy only),
projection unqualified (that is the thing you ran, not what it produced).

**Scenario**:
A plan and a ledger together — the smallest unit that can be projected. Neither half
projects alone: the plan states the standing numbers, the ledger states what happens.
_Avoid_: state, document, model.

**Scenario input**:
A declarative, id-free description of a whole scenario — standing numbers plus the events
that create everything else. The authoring counterpart to a scenario: it says what should
exist, not what does.
_Avoid_: plan input (it describes both planes, not just the plan), config, template.

**Ref**:
An author-chosen name used inside a scenario input so one entry can point at another before
any id exists. Resolved when the scenario is built and discarded — never persisted.
_Avoid_: id, key, alias.

**CashFlowSeries**:
The reusable primitive modeling any recurring dollar amount that changes over time
(salary, rent, groceries, debt payments). Carries a baseline, a growth mode, and
overrides.
_Avoid_: stream (used loosely elsewhere, but "series" is the precise type name).

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

**Minted id**:
An id issued by the engine's shared counter (`job-3`, `goal-7`). The counter is the only
thing permitted to invent one, so a minted id is unique across a scenario by construction.
_Avoid_: generated id, auto id.

**Derived id**:
An id computed from its parent's id rather than from the counter (a mortgage's, from the
property that owns it). Unique because its parent is, so it never consumes a count.
_Avoid_: composite id, child id (a child has a minted id like anything else).

**External id**:
An id that arrived from outside the engine and is carried verbatim — never parsed, never
allowed to influence the counter. The engine treats it as an opaque label.
_Avoid_: foreign id, custom id.

**Provenance**:
The `sourceEventId` (or `appliedRecommendationId`) tag recording *what created* an
artifact, kept for lineage and undo. Distinct from — and never determinative of — where
the user edits that artifact.

**One-time transfer**:
A discrete, dated movement/injection/removal of money at a specific month (influx,
outflow, or proportional shock), as opposed to an ongoing `CashFlowSeries`. Never
compounds. Its per-account amount is fixed when authored — which is what separates it from
a **One-Time Spend**, whose split across accounts depends on their balances and so resolves
at simulation time.
_Avoid_: transaction (reserve "transaction" for future ledger/persistence layers, if any).

### Goals, overrides and corrections

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
Creates no new segment and shifts no boundary (segment start/end stay event-owned).
Authored on an entity's history view, never through the scrubber's
this-month/forward prompt.
_Avoid_: backdated override (it is NOT an override — it neither rebases forward nor
perturbs a single future month).

**On-track %**:
`projected fund balance at target date ÷ target amount`, computed from the full
projection (future contributions + growth) — never "saved so far ÷ target."

### Obligations and funding

**Financial obligation**:
An amount that must be funded in one simulation month, carrying its economic treatment and
its funding strategy. The single normalized form every source of monthly cost — budget line,
health line, event-spawned expense, debt payment, home down payment, one-time spend — is
reduced to before funding runs.
_Avoid_: spending item (the superseded name), expense (an obligation may be an asset
acquisition or a debt payment instead), bill, charge.

**Obligation treatment**:
The economic result of satisfying an obligation: **expense** (money leaves, net worth
falls), **asset-acquisition** (cash converts to an asset, net worth conserved), or
**debt-payment** (a liability's balance falls). Governs both how the obligation reports and
what happens when it cannot be funded.
_Avoid_: kind, type, category (an obligation carries a separate display category).

**Funding strategy**:
How an obligation gets paid: **automatic** (through the allocation waterfall — every
recurring obligation) or **explicit** (drained from a user-ordered list of named accounts —
one-time spends and home down payments). Independent of treatment; neither axis implies the
other.
_Avoid_: funding mode, payment method, funding kind.

**Resolved funding**:
The derived, per-obligation record of which sources actually paid it and how much. Belongs
to the projection, never the ledger — recomputed whenever the plan changes.
_Avoid_: allocation, payment record (a liability's payment record is a different, narrower
thing).

**Funding attribution**:
The assignment of particular funding sources to particular obligations within a month — a
**derived interpretation, not a fact**. Money is fungible; "the car payment went on credit
while rent came from income" is produced by the priority order, and reordering priorities
reassigns it. Presented as a stated-rule reading, in the spirit of a **Nudge** — never as
something the user authored or the ledger observed.
_Avoid_: stating it as an observed or authored fact.

**One-Time Spend**:
A dated, source-directed cash outflow funded from named accounts in a chosen order.
Distinguished from a dated expense override by exactly one thing: the user names *which*
accounts pay and in what order. Being an **expense**, a credit card is among the sources it
may name.
_Avoid_: purchase (a home purchase is its own event), spend event, expense event.

**Funding eligibility**:
Which sources an obligation is permitted to name, decided by the engine and never by the UI.
Governed by **treatment**: an `expense` may draw on liquid accounts and credit cards, an
`asset-acquisition` on liquid accounts only (no bank funds a down payment on a card).
_Avoid_: allowed accounts, valid sources.

### Validity, feasibility and blocking

**Structural validity**:
Whether an authored change is well-formed — ids resolve, references exist, percentages total
100%. The only grounds on which a change may be refused. A structurally valid plan may still
be impossible to fund.
_Avoid_: validation (unqualified — name which of the two is meant).

**Projection feasibility**:
Whether the authored plan can actually be simulated. Never affects structural validity, and
never grounds for refusing a change: aspirational plans are authorable by design.
_Avoid_: validity, correctness.

**Blocking obligation**:
The explicitly-funded obligation whose named sources cannot cover it, halting the projection.
Exactly one blocks any projection — the first one reached. The **event** that authored it is
the reporting handle; an event is blocked if any of its obligations is.
_Avoid_: failed obligation, invalid event, underfunded (the superseded name, which implied
the projection continued).

**Blocked month**:
The month containing the blocking obligation — simulated to completion with that obligation,
and the artifacts it would have created, omitted. The last month the projection emits.
_Avoid_: failure month, cutoff.

**Not reached**:
An obligation authored after the blocked month, whose affordability is unknown because the
simulation stopped before it. Positional, never inferred from dependency — nothing after the
block was tested.
_Avoid_: unreachable, skipped, invalidated (an invalidated *event* is the reported rollup).

**Funding configuration failure**:
The named sources cannot cover an obligation, but eligible sources elsewhere can. An
authoring mistake, not a money problem — the engine reports the alternatives and never picks
one.
_Avoid_: insufficient funds (it is the opposite — the money exists).

**Blocked** vs **insolvent**:
Two distinct terminal conditions, never conflated. **Blocked** means an authored instruction
cannot be carried out, and has no continuation. **Insolvent** means the shortfall cascade
exhausted savings and credit; it *does* continue — the household is in debt and may dig out —
so the projection runs on with net worth nulled. A block strictly precedes insolvency within
a month.

**Soft warning**:
A persistent, non-dismissible statement of fact about the projection, rendered while its
condition holds and blocking nothing (debt-to-income, blocking, insolvency). Distinct from a
**Nudge**, which proposes a value change and is advice; a soft warning proposes nothing and
dismissing it would not make it less true.
_Avoid_: error, alert, dismissible warning.

### The allocation waterfall

**Allocation waterfall**:
The fixed, opinionated per-month order that routes net cash flow to the month's
**automatically-funded obligations**: per-income-source pre-tax deductions → personal cash
pool → shared pool (proportional-to-income by default) → shared goals in priority order →
personal goals → shortfall cascade. Not user-configurable except for four named levers
(contribution %, shared-contribution scheme, goal priority order, surplus-cash
destination). The ordering is fixed plumbing, never user-configurable.
_Avoid_: budget rules, allocation policy (waterfall is the precise term; "policy" is used
loosely, but "waterfall" names the specific fixed sequence).

**Lever**:
One of the (now four) user-exposed choices *within* the fixed waterfall: per-person 401(k)
%, shared-contribution scheme (proportional vs. even), goal priority order, and default
surplus-cash destination (idle-in-liquid vs. swept-to-investment). Everything else about the
waterfall is under the hood.
_Avoid_: knob, setting, option ("lever" is the precise word, and it is deliberately a
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
negative net worth, which requires no intervention. Reserved for **automatically-funded**
obligations: an explicitly-funded one names its own sources, so falling short blocks the
projection rather than cascading — substituting an unnamed source would rewrite an authored
funding decision.
_Avoid_: shortfall handling, deficit logic.

**Hard-infeasibility**:
The terminal state where a monthly deficit exceeds all available liquid assets and credit
— the plan cannot be funded by any real mechanism. Surfaced as the most severe flag the
tool produces.

**Liquid** (account flag):
Marks an `Account` as eligible to fund an obligation and usable by the shortfall cascade's
drawdown step. `checking`/`savings`/`brokerage` = liquid; retirement accounts
(`401k`/`Roth`/`HSA`) = not liquid.

### The end of the plan

**Estate settlement**:
The one calculation that happens after the last household member dies, replacing the monthly
cash-flow simulation rather than extending it. Answers two separate questions off the terminal
state: **was the household still ahead** (economic net worth) and **who actually gets paid**
(the probate distribution). No month, no waterfall, no sale — the run's balances and net worth
are untouched by it. _Avoid_: final year, wind-down; and do not use "estate" alone where the
two questions differ — say economic or probate.

**Terminal economic net worth**:
All assets − all debt − final accrued taxes, at death. **All** means all: beneficiary-designated
retirement accounts included on the asset side, mortgages and unsecured balances alike on the
debt side. The second half of the retirement solver's feasibility test, beside lifetime
solvency, and the whole of the terminal half. Stops a plan from qualifying on a tax bill or a
mortgage that simply falls after the last modeled month, without letting the TITLE on an asset
decide a retirement age. No tolerance: a shortfall is a shortfall.

**Probate distribution** (reported, never scored):
What the estate rules do with that position once the solve is over. Collateral answers for the
debt it secures (a property's `mortgageLiabilityId`), any balance beyond the collateral's value
becomes an unsecured claim, **probate assets** — cash, taxable investments at death-date value,
property equity — pay the final tax and the unsecured debt, and **beneficiary retirement assets**
pass outside probate to their named beneficiary. An obligation the probate estate cannot cover is
stated as **unpaid obligations** and left unpaid; it is never backfilled from a beneficiary
account, and never grossed up for tax. A household can therefore be economically solvent — so
feasible — while its probate estate goes short, which is a real planning finding rather than a
verdict.

**Basis reset at death** (simplified):
Taxable investments enter the estate at their death-date value with no capital gain realized
on liquidation. A terminal valuation rule only — every sale made while the household was
alive prices its gain against the ordinary basis model.

### Engine purity and the jurisdiction seam

**Engine purity**:
The constraint that the engine is a pure function of its inputs — no I/O, no storage, no
app/jurisdiction-specific code. Jurisdiction specifics enter only through the jurisdiction
interface.

**Jurisdiction interface**:
The seam the engine defines and a `rules` package implements: `computeTax`, contribution
limits, and government-program formulas, all parameterized by year. The engine ships a
null jurisdiction (zero tax, no programs) so it runs standalone.

**Validation jurisdiction** vs **run jurisdiction**:
Two distinct uses of the same seam. The **validation** jurisdiction decides whether an
authored change may be accepted (an affordability gate nets tax, so the answer is
jurisdiction-dependent). The **run** jurisdiction is chosen per projection, so one scenario
can be re-run under several. Authoring against one and projecting under another is normal.
_Avoid_: "the jurisdiction" unqualified when either could be meant.

**EarningsRecord**:
An engine-owned, per-person accumulator filled as the simulator runs forward (every income
segment contributes), plus an optional entered pre-now earnings seed (the second historical-
financial-input exception). Pure engine bookkeeping with no jurisdiction knowledge — the
`rules` side reads it to compute the Social Security benefit via the jurisdiction seam.
_Avoid_: earnings history, wage record (this is the specific accumulator type).

**taxTreatment** vs. **taxCategory**:
Two distinct tax seams, not synonyms, and the distinction is load-bearing.
**`taxTreatment`** is a property of the STOCK — an account — and names what HOLDING it still
defers: `taxedAtAccrual` (a cash balance, already taxed as its interest was credited),
`taxable` (gain deferred to sale), `taxDeferred` (pre-tax), `taxExempt` (never taxed). It is
the only thing the drawdown order ranks on.
**`taxCategory`** is a property of the FLOW — an income `CashFlowSeries`, or a withdrawal —
and names what the money IS when it arrives, for the jurisdiction to price:
`wages`/`socialSecurity`/`ordinaryIncome`/`capitalGains`/`taxedAtAccrual`/`taxExempt`/`borrow`.
One account carries both, and they answer different questions: a pre-tax retirement account is
`taxDeferred` (so it is drawn third) and pays `ordinaryIncome` (so the brackets tax it).
_Avoid_: using "tax treatment" loosely to mean either — name the specific field; and never rank
a drawdown on a tax category, which collapses accounts that merely share a label.

**`taxedAtAccrual`** vs **`taxExempt`**:
The two tax categories that bear no tax on withdrawal, and never interchangeable.
**`taxedAtAccrual`** is a cash balance whose interest was taxed as ordinary income the month it
was credited: drawing it down returns already-taxed principal, so it is not income, stays out of
a benefit's provisional-income test, and is drawn FIRST — holding it defers nothing.
**`taxExempt`** is a genuinely untaxed vehicle (Roth-like, or exempt interest) whose growth is
never taxed: holding it is worth something, so it is drawn LAST, and where a jurisdiction counts
exempt interest toward a benefit test it is real income for that purpose.
**`borrow`** is the third: loan proceeds, which are not income under any regime and belong to no
rate regime at all. Distinct from both, because those describe money the household OWNS that some
rule declines to tax, and this is money it owes back.
The category-to-base sort in `federalTaxParts` is an exhaustive switch over `TaxCategory`, so a
new category cannot be added and silently priced at zero: it fails to compile until someone
states which base it enters, or that it enters none.
_Avoid_: "tax-free" for any of them — it is true of all three withdrawals and hides the
distinction that decides the drawdown order and the benefit test.

**Withholding** vs **liability** vs **settlement**:
Three different figures about the same tax year, and conflating any two of them is the mistake
this vocabulary exists to prevent.
**Withholding** is what payroll takes out of one paycheck, computed from that paycheck alone.
Deliberately approximate, and causal by construction: a raise, a cut or a month with no pay
changes it from that paycheck forward and can never revise an earlier one. Nothing outside
payroll is withheld against — a retirement withdrawal, a realized gain and a one-off spend all
withhold nothing.
**Liability** is what the year actually owes, priced once at the year's close over every dollar
of income that actually arrived, whatever month it landed in. Authoritative.
**Settlement** is `liability − withheld`, signed: positive a balance due, negative a refund. It
is parked when the year closes and moves as cash in the FOLLOWING April, through the ordinary
funding waterfall like any other need.
_Avoid_: "estimate" or "instalment" for withholding — neither the engine nor a payroll system
estimates a year; "true-up" for the settlement, which is a filing, not a correction.

**Regular** vs **supplemental** wages:
Both are ordinary wage income and the year's liability makes no distinction between them.
WITHHOLDING does: a payroll system annualizes regular pay and must not annualize a one-off, so a
bonus is withheld against by its own method. A `JobIncomeOverride` of kind `addBonus` is what
makes a month's pay partly supplemental.
_Avoid_: treating a bonus as a pay rise, which is exactly the error the separation prevents.

**Multiple-jobs adjustment**:
The extra per-period withholding a person needs *because* they hold more than one job at once.
Each employer prices its own wages as though they were the person's only income, so between them
they withhold from the bottom of the brackets more than once. The model corrects for that the way
a real taxpayer would: prospectively, on the highest-paying job, sized from what the year has
actually paid and withheld plus this period's rate of pay extended over the periods that remain.
Re-derived from scratch every period, so a job starting, ending or changing pay moves that month
and every later one and no earlier one.
Measured on REGULAR pay alone, on both sides: a bonus is withheld for by the flat supplemental
method when it is paid and then leaves no trace, so a June bonus cannot make July withhold more.
Whatever the flat rate under- or over-shot on it is settled the following April.
_Avoid_: the W-4 Step 2(c) checkbox, which only approximates two similar jobs and cannot express a
job that started in July; and letting supplemental wages into the basis, which reads a one-off
payment as a raise.

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
honoring the anti-deception rules. Distinct from a **soft warning**, which proposes nothing
and cannot be dismissed.
_Avoid_: auto-adjust, automatic step (a nudge is explicitly NOT silent/automatic).

### Time — backdating, holdings, anchors

**Backdating** / **"now" marker**:
Entering events dated before the present. "Now" is a distinguished point on the
simulation timeline; history before it establishes *structure only* (who/what exists) —
never a reconstructed past net-worth curve. Entered current balances are the sole source
of financial truth as of now.

**Holding**:
A pre-existing stock — a loan, property, or mortgage — that opens at the **"now" marker**
with its *current* terms (balance or value, remaining term) and no account side-effects:
no funding draw and no affordability gate. Its true origination is deliberately kept off
the timeline, because reconstructing years of amortization to reach today's balance would
contradict "entered current balances are the sole source of financial truth." The one
pre-now month it may carry is the now marker itself; authored by `carryLoan` / `ownHome`.
_Avoid_: backdated transaction (a holding moves no money at start and reconstructs
nothing), opening balance (that is one of a holding's terms, not a name for it).

**Anchor**:
A pre-existing life event — marriage, birth, or separation — placed at its **true past
month**, whose elapsed position drives the remaining duration of the flows it governs (a
child's support left to run, alimony still owed). Carries no net worth, so dating it
truthfully reconstructs nothing — which is exactly why, unlike a **Holding**, it is not
pinned to the now marker and any negative month is valid. Authored by `startPartnered` /
`haveExistingChild` / a pre-now `separate`.
_Avoid_: backdated transaction, holding (an anchor carries no balance and no current terms
to freeze).

### Jobs, income and recommendations

**Job** (income source):
A single `CashFlowSeries` owned by a person representing one income stream. A person may
hold multiple concurrent jobs; each is independently anchored and may carry its own plan
descriptor. "Job" and "income source" are used interchangeably — prefer "income
source" in engine-level contexts (it's the general primitive) and "job" in event/UI-facing
contexts (it's what the user calls it).

**JobChangeEvent**:
The event authored when a person's income source changes structurally (new employer, new
terms) — as opposed to a same-employer raise, which is a plain override. Reference-scoped
to exactly one income source (`targetIncomeSourceId`); does not touch a person's other
concurrent jobs. Ends the target income series and its plan descriptor, starts a new
income series with `resetAnchor: true`.
_Avoid_: job event (ambiguous — "JobChangeEvent" is the exact type name).

**Historical financial input**:
One of exactly TWO permitted entered-as-of-now facts about the pre-"now" past that feed a
forward calculation (everything else backdated is structural-only): (1) year-to-date
401(k) contributions (for the partial-first-year contribution cap), and (2) the pre-now
earnings summary (to seed the `EarningsRecord` for Social Security).
_Avoid_: past finances, historical balance (those are exactly what backdating forbids — only
these two inputs are allowed).

**Recommendation**:
A machine-computed, mechanically-derived suggestion (never opinion) that closes a goal's
on-track gap, carrying a structured `change` payload the engine can apply via the ordinary
override path. Distinct from advice — the tool quantifies options, the user decides.

## Notes

- This is a **single-context** repo for now (the `engine`). If `rules` and `app` grow
  their own vocabulary as those repos come online, split into a `CONTEXT-MAP.md` at that
  point rather than overloading this file.
- This file is the canonical vocabulary — it exists to keep terms consistent and
  opinionated as they get stress-tested, not to introduce new concepts unilaterally.
