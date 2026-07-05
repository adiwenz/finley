# Financial Life Simulator — FINAL Build Spec (decisions interleaved)

> **THIS IS THE CANONICAL SOURCE OF TRUTH** (interleaved final spec). It is `BUILD_SPEC.md` verbatim with the grill-session
> resolutions injected inline as **✔ RESOLVED** blocks at the end of each affected section. Where a
> ✔ RESOLVED block and the surrounding prose conflict, **the RESOLVED block wins** — it post-dates
> the prose and reflects a deliberate decision (full rationale in the inline ✔ RESOLVED blocks;
> build-step mapping in `PRD.md`; glossary in `CONTEXT.md`). Every §11 "open decision" is now
> resolved; see the inline blocks and the annotated §11.

A browser-based financial life simulator. Inputs are a person's (household's) income,
expenses, accounts, and discrete life events; output is a month-by-month net-worth
projection and a solved retirement year. This document is the single source of truth for
the build — it consolidates decisions made across design discussion and supersedes any
earlier fragment.

> **Repo / open-core note.** This spec is repo-agnostic: it describes *what the engine and
> rules compute*, not how they're packaged. Per `ARCHITECTURE.md`, the **engine** and the
> **jurisdiction rules** live in separate **public** repos (open core); the **app** (UI,
> persistence, user data) is a **private** repo importing both. Where this spec says "the
> simulator," that's the public engine. The engine-purity rule (§0.8) is the constraint that
> keeps that boundary clean.

---

## 0. Guiding principles

These are load-bearing. Violating them is how the model silently produces wrong numbers.

1. **Money is integer cents, never floats.** Floating-point drift compounds over a
   40-year horizon. Every monetary value is an integer number of cents.
2. **Events never touch net worth directly.** Events only add / end / modify
   `CashFlowSeries` and `Account`s, or perform explicit one-time transfers. All growth
   happens in exactly one place (account compounding), unconditionally, once per month.
   This keeps compounding untouchable by event logic.
3. **The event ledger is the source of truth.** The projection is a *derived view*,
   recomputed by replaying the ledger — never persisted as truth. This gives free
   scenario branching, undo/redo, and audit trail.
4. **Simulate in nominal dollars, report in real dollars.** Raises, returns, and
   inflation all compound nominally (a fixed mortgage payment shrinks in real terms — the
   model must capture this). Convert to real only at the reporting layer:
   `real = nominal / (1 + inflation)^years`.
5. **The retirement solver's withdrawal-sufficiency check runs on REAL net worth**, not
   nominal — otherwise the model tells people they can retire earlier than is safe.
6. **No privileged "user."** A household is a set of `Person`s; one is *flagged* primary
   for the UI, but is not structurally special. Do not bake `self` into the schema.
7. **Build the engine as pure, framework-free TypeScript with tests BEFORE any UI.** Get
   the math right in isolation, then wire it up.
8. **Engine purity (open-core boundary — `ARCHITECTURE.md`).** The engine is a **pure function
   of its inputs**: no I/O, no network, no storage, no user-data / PII types, no dependency on
   any app code. Jurisdiction-specific rules (tax, government programs) enter ONLY through the
   jurisdiction interface (§5.3–5.5), never hardcoded in the engine. This is a *correctness*
   constraint, not just packaging: code that violates it cannot live in the engine. Enforce with
   a CI/lint check; the determinism invariants (replay is byte-identical, §6) partly prove it.

---

## 1. Build sequence (hand these to Claude Code as ordered, independently-testable tasks)

Each step should compile and pass tests before the next begins.

1. **Extend `CashFlowSeries`** (foundation exists — see §2). Add `baselineUnit`,
   `growthAnchor`, `endMonth`, and the `resetAnchor` override option.
2. **Build `Account`** — asset (compounding) and liability (amortizing), including credit
   cards with APR/limit/min-payment. Test against a known mortgage amortization table.
3. **Build `Person` and `Household`** — entities + time-bounded membership. Add `ownerId`
   to accounts and cash-flow series (default single person; refactor must not change any
   output).
4. **Build `FinancialState`** — container: household, accounts, active series, properties, goals.
5. **Build the `Event` base class + subclasses** (§4) — each with `apply`,
   `checkPreconditions`, source tagging. Includes `Person`/`Child`/`Property` durable entities,
   the `HomePurchaseEvent` down-payment hard block + DTI soft warning (§4.5), `RefinanceEvent`,
   `HomeSaleEvent`, and account rate-segments + one-time transfers (§3.1–3.2).
6. **Build the `Simulator`** — the fixed monthly pipeline (§5), including the shortfall
   cascade (§5.1) and goal-aware allocation (§5.2).
7. **Build undo / cascade machinery** — replay validation (Strategy A), then
   reference-scoped `computeDependents` (Strategy B) (§6).
8. **Build `findRetirementAge`** — household-aware binary search on real net worth (§7).
   Retirement is the highest-priority horizon goal.
9. **Build v1 government programs** (§5.4) — the general `GovernmentProgram` concept, then Social
   Security (derived from an accumulated lifetime-earnings record + claiming age) and Medicare
   (age-65 health-cost step). Build RMDs + contribution limits alongside the tax seams (§5.3).
   Means-tested programs deferred. Heavy "estimates, not advice" disclaimer.
10. **Build the recommendation engine** (§8) — re-run `simulate()` against candidate changes,
    diff on-track numbers, present quantified options. Each recommendation carries a structured
    `change` payload; Apply commits it via the ordinary override path (tagged
    `appliedRecommendationId`, undoable); "increase income" is display-only. No new simulation
    logic.
11. **Minimal browser UI** — reuse the existing ledger-aesthetic mockup; wire to
    `simulate()` client-side. **Follow the interaction model (§10)** — two authoring surfaces
    (Budget/Accounts for value edits, life-event timeline for events), the three anti-deception
    rules, progressive depth, temporal entity views (§10.7), the snapshot/scrubber view (§10.8),
    and the must-surface properties. Ledger palette (ink green / parchment / amber),
    person-partitioned input panel, net-worth area chart with retirement reference line, event
    list, unified life-event timeline + scrubber, goals panel with on-track %, recommendation
    cards (with Apply / Applied✓/Undo states), and a separate Applied adjustments panel for
    durable un-apply (§8.4).

Persistence: **none at first.** Ledger lives in memory / localStorage. Add a real backend
(Postgres, one `events` table, jsonb payload) only once there's signal people want to save
and revisit scenarios — serialize the *same* ledger, don't rearchitect.

**Tax seams (§5.3):** even though the tax model is deferred, build the three tax seams — the
`computeTax()` stub in the pipeline, the `taxTreatment` account field, and routed withdrawals —
from the start (they're cheap now, expensive to retrofit). Real tax is a prerequisite for the
tool being *accurate* rather than *illustrative*, and especially before the recommendation
engine is trusted for money-serious decisions.

Deferred / out of scope for v1 (flagged, not built): Monte Carlo return sampling instead
of fixed rates; the actual per-account-type **tax computation** (seams built now, logic later —
§5.3); marital asset division on separation (§4.3); legitimate down-payment assistance
sources — gifts, DPA programs, piggyback loans (§4.5); **means-tested government programs**
(Medicaid, SNAP, ACA subsidies — shape 3, §5.4) and other deferred-but-patterned programs
(unemployment, SSDI, CTC, 529, Roth conversion, FMLA — §5.4); **equity/deferred comp** (stock
options, RSUs, vesting schedules — designed but not built, §5.5) and match vesting (v1 treats
match as immediately vested).

---

## 2. `CashFlowSeries` — the reusable primitive

Already implemented and tested (`cashFlowSeries.ts`). Models any recurring dollar amount
that changes over time: salary, rent, groceries, debt payments, support obligations.

### Existing, verified behavior

- **Cumulative rounding** for annual→monthly:
  `month(m) = round(annual·m/12) − round(annual·(m−1)/12)`. Guarantees the 12 months sum
  exactly to the annual total; spreads rounding error instead of dumping it in one month.
- **Year-over-year growth compounds iteratively** from the previous year's *actual* cents
  value (cached per segment), never re-derived from the original baseline.
- **Overrides** model "click a point on the timeline, type a new number":
  - `thisMonthOnly` — perturbs exactly one month (e.g. a one-off cost); neighbors
    untouched.
  - `fromHereForward` — starts a new segment; prior months untouched, future months
    rebase.
- **Forward-only cache invalidation** — an override only invalidates cached months at or
  after the edit month.
- `preciseMonthlyRate(annual) = (1+annual)^(1/12) − 1` for account compounding.

### Additions required (step 1)

**`baselineUnit: "annual" | "monthly"`** — the fix to the annualization problem.
- *Annual-native* (salary): store annual cents, escalate annually, split via cumulative
  rounding. (Current behavior.)
- *Monthly-native* (rent, groceries, debt, support): store monthly cents directly. It
  repeats **exactly**, unchanged, every month — no splitting, no rounding drift — until
  edited or until a growth boundary escalates it. Escalation compounds iteratively from
  the actual prior *monthly* value. This is what makes "$150 stays $150 until it ticks up
  once a year" true.

**`growthAnchor: "ownCycle" | "calendar"`**, default `"ownCycle"`.
- *`ownCycle`* (the default and common case): growth fires every 12 months from the
  series' own anchor month. Rent anchored to move-in date increases each year on the
  move-in anniversary; salary anchored to hire date raises on the work anniversary.
- *`calendar`*: growth fires on the shared simulation calendar boundary. Reserve for
  things tied to an external published schedule (CPI, tax brackets).
- The anchor month is set at creation (move-in / hire / origination date).

**`endMonth?`** — a stream can auto-expire (a child's cost stream ends 216 months after
birth; a housing budget item ends when the user ends it). No value on `getMonthlyCents` past
`endMonth`.

**`resetAnchor` option on `fromHereForward` overrides.** An edit's value change and the
growth *clock* are independent axes. Three real edits look identical in the UI:
- *Scheduled increase fired / correction / typo fix* → **do not** move the anchor
  (default, `resetAnchor: false`).
- *Structural restart* (new apartment, new job, new loan) → **reset** the anchor to the
  edit month, so the next escalation counts from here (`resetAnchor: true`).

---

> **✔ RESOLVED — §2 additions (grill session):**
> - **New field `taxCategory`** on every income series (v1-ignored seam, a third tax seam):
>   `wages|socialSecurity|ordinaryIncome|capitalGains|taxExempt`, default `wages`. Orthogonal to
>   waterfall placement — placement reads `planDescriptor`, taxation reads `taxCategory`.
> - **History correction** = a THIRD edit op beyond the two override scopes: an in-place edit of a
>   closed historical segment's value, creating no new segment; boundaries stay event-owned (§10.7).
> - **Backdated streams** need **anchor ≠ financial-start** (growth clock in the past, no value
>   before "now") and the next escalation at the next own-cycle **anniversary** (may be <12 months) —
>   not 12 months from "now." Same for `calendar` anchors at the next calendar boundary.

## 3. `Account`

Every account has an **`ownerId`** (a `Person` id, or the special `"shared"` owner).

### Asset accounts (`kind: "asset"`)
401k, Roth, brokerage, checking, savings. Balance compounds once per month at
`preciseMonthlyRate(annualReturn)` — in the single compounding step of the pipeline,
unconditionally.

### Liability accounts (`kind: "liability"`)
Mortgage, auto loan, student loan, credit card. **The monthly payment is COMPUTED from the
account's own balance, rate, and term — it is NOT a `CashFlowSeries` expense line.** Each
month: accrue interest, apply the computed amortizing payment, reduce principal. A fixed
mortgage payment is nominal and constant, so it shrinks in real terms over time — the model
captures this naturally by simulating nominally.

Test liability logic against a known amortization table before moving on.

**Negative net worth is normal.** Net worth = Σassets − Σliabilities; if liabilities exceed
assets (e.g. $80k student loans, $5k savings → −$75k), the net-worth line is simply below
zero and climbs over time. This is a first-class, expected state — often the most useful
story the tool tells — not an error. The chart renders below zero; nothing intervenes.

### Credit-card accounts (a liability sub-kind, entered up front)

The account-entry flow lets the user add credit card(s) as first-class liability accounts,
each with: current balance (often $0 or a carried balance), **APR**, **credit limit**, and a
**minimum-payment rule** (serviced by the allocation waterfall like any other debt). These
terms are what the cash-shortfall fallback (§5.1) uses when a month can't be covered from
cash — so entering a real card means shortfall debt accrues at the user's *actual* terms
rather than an assumed default.

### 3.1 Editing an account: more than a starting balance

An account is not just "starting balance + compounding." A user needs to edit three distinct
things, mechanically different:

1. **Starting balance** — a value edit at month 0; recomputes forward.
2. **Rate over time** — the return/interest rate is NOT a fixed scalar. Use the **same
   segment + override machinery as `CashFlowSeries`** (§2): a baseline rate with
   `fromHereForward` changes ("moved to a conservative allocation → 4% instead of 7% from
   2030"). Do not model the rate as a single number.
3. **One-time transfers at a specific month** — see §3.2.

### 3.2 One-time transfers (a first-class user action)

A one-time transfer is the account analogue of a `CashFlowSeries` override: the discrete,
dated, legible way to say "something changed here that isn't the normal monthly flow." It
already exists as an internal primitive (down payments, wedding costs); **promote it to a
user-authorable action** attachable to any account or property:

- **Influx** — bonus, inheritance, gift, sale proceeds landing in an account.
- **Outflow** — large withdrawal, moving money between accounts, a renovation into a property.
- **Proportional shock** — a market hit expressed as a percentage of balance ("−30% in 2029")
  — the same primitive with a percentage mode instead of a dollar amount.

**Invariant:** a one-time transfer only *moves / injects / removes* money at its month; it must
**never apply growth** — compounding stays the single growth site (§0.2). The normal compounding
step then continues from the new balance. Transfers between two accounts conserve total money.

---

> **✔ RESOLVED — §3 Account (grill session):**
> - **`liquid` (§11.1):** checking/savings/brokerage = liquid; 401k/Roth/HSA = not. Binary flag,
>   no partial-liquidity tier.
> - **Credit-card minimum payment (§11.2):** greater of **2% of balance or $25** — applies to
>   user-entered cards and the synthetic default shortfall card.
> - **Goal fund account = any account with a user-set rate/type** (brokerage/HYSA/bonds/cash),
>   already supported via a goal's `fundAccountId` + the account's editable rate (§3.1). See the
>   §5.2 RESOLVED block for the short-horizon-risk flag.

## 4. Entities & Events

### 4.1 Entities

- **`Person`** — id, name, `isPrimary` (UI-only flag), retirementAge, lifeExpectancy. Holds
  *no* finances directly; income streams and accounts reference it via `ownerId`. An
  obligation-only person (e.g. an ex you pay support to) is just a `Person` with no modeled
  accounts.
- **`Household`** — the set of `Person`s plus time-bounded membership intervals
  `{personId, joinMonth, leaveMonth?}`. Events open and close these intervals.
- **`Child`** — a `Person` with **parentage refs**: the two parent person ids (user + a
  partner id, or user + `"external"`). A child references its *parents*, never a marriage.
  Membership and cost stream run birth→18.
- **`Property`** — a **durable entity** representing a house (see the durable-vs-dependent
  distinction below). Has `id, ownerId`, a **current value** with its own appreciation growth
  mode (a stock that grows independent of the mortgage), and *associates* (owns) a mortgage
  liability `Account` and its cost streams (property-tax/insurance/HOA). Equity = property value
  − mortgage balance. Created by a `HomePurchaseEvent`, targeted by `RefinanceEvent` and
  `HomeSaleEvent`, but **edited as a first-class entity thereafter** — the purchase event is its
  origin, not its container. A renovation is a one-time transfer (§3.2) into the property that
  may raise its value.
- **`Account`**, **`CashFlowSeries`** — as above, each carrying `ownerId`.

**Durable entities vs. dependent artifacts (the distinction that governs editing).**
- **Durable entities** — `Person`, `Child`, `Property`. Created by an event, but thereafter
  first-class objects with ongoing, evolving lives (a partner gets a raise; a house appreciates
  and is refinanced). The event is their *origin*, not their edit surface. A partner is far more
  than the relationship event; a house is far more than its purchase.
- **Dependent artifacts** — a mortgage, a wedding-cost transfer, property-tax streams, a
  child-support stream. Consequences of their event, with no independent life; tagged by
  `sourceEventId` for provenance and undo.
- **Provenance ≠ editing surface.** Which event created an artifact is tracked (`sourceEventId`)
  for lineage and undo, but does NOT dictate where the user edits it. Durable entities are the
  editing surface for everything they contain, *including their dependent artifacts*: you edit a
  partner's accounts on the partner, and a house's mortgage on the house — never by digging up
  the origin event. (This corrects an earlier over-strong "edit through the creating event"
  rule.) See §10.3.

> **✔ RESOLVED — §4.1 Property appreciation (§11.9):** model appreciation in v1 (not flat-until-
> sale); default growth mode `inflationLinked`, user-overridable per property via the same
> segment+override machinery as any other growth-bearing quantity.

### 4.2 Ownership rule

Every account and every cash-flow series has an `ownerId` that is either a person id or the
special `"shared"`/`"household"` owner. "Joint" is not a boolean — shared is just another
owner. This keeps allocation uniform: per-person pre-tax deductions come off each person's
gross first, then owned/shared flows feed the appropriate pool.

The **Budget/Accounts panel is person-partitioned**: a section per household member plus a
`shared` section, each person's accounts/income/budget items grouped under them. This is *where*
a partner (or any member) is edited directly — their balances, income, a future job change — not
through the relationship event. Scales to N people for free.

### 4.3 Events

Every event created stream/account is **tagged** with:
- `sourceEventId` — which event created it.
- `role` — what kind of thing it is (`"partner_income"`, `"partner_expense"`,
  `"wedding_cost"`, `"mortgage"`, `"child_expense"`, `"child_support"`, `"alimony"`, …).

Tagging is what makes undo and selective unwinding mechanical rather than bespoke.

Each event implements:
- **`apply(state, month)`** — mutates state using only three primitives: add/end a
  `CashFlowSeries`, add/remove an `Account`, or a one-time transfer between accounts
  (`applyOneTime`). One-time transfers (down payment, wedding cost, legal fees, lump-sum
  payoff, loan disbursement) are their own primitive — NOT faked as a one-month series.
- **`checkPreconditions(state)`** — declares required state (e.g. `RelationshipEvent`
  requires the partner not currently in an active relationship with the user;
  `SeparationEvent` requires an active relationship to end).

Event set:

- **`RelationshipEvent`** (start) — adds a `Person` to the household (opens a membership
  interval), optionally their income streams and accounts, optionally flags it a marriage
  (`isMarriage`). Partner income is annual-native, own-cycle anchored to *their* hire date.
  A wedding cost is a one-time transfer, not a stream.
- **`ChildEvent`** — adds a `Child` referencing two parents; creates the child-cost stream
  (monthly-native, birth→18). Carries who the other parent is, so support can be computed
  later. Independent of any partnership.
- **`SeparationEvent`** (references a specific partner id) — sets that partner's
  `leaveMonth`; ends streams tagged `{sourceEventId: thatRelationship, role ∈
  {partner_income, partner_expense}}`. **Must NOT touch `child_expense` streams** (owned via
  `ChildEvent`) or a house/mortgage (owned via `HomePurchaseEvent`) — kids and the house
  don't vanish on separation. Then: one-time legal-fee transfer; optional alimony; per shared
  child, a child-support stream. "Divorce" is not special — it's a `SeparationEvent` where
  the partner's `isMarriage` is true (only affects whether alimony/division applies; unmarried
  co-parents still owe support).
- **`HomePurchaseEvent`** — **property-only.** Creates a **`Property` entity** (§4.1) with its
  value + appreciation, its mortgage liability `Account`, and monthly-native
  property-tax/insurance/HOA streams (own-cycle anchored to the purchase date); one-time
  down-payment transfer. **Does NOT touch any budget item** — buying and ceasing to rent
  are independent (you may buy an investment property and keep renting, or buy a home you don't
  yet live in). It also *cannot* know which of the user's budget items is "the rent" (there may
  be several, or none, or it's labeled "apartment") — so ending a housing item on purchase is a
  **separate decision the user makes** (see budget-item end, below). Subject to the down-payment /
  affordability rules (§4.5). Each purchase creates its **own** `Property`, so multiple houses
  coexist and a later sale/refinance can target exactly one.
- **`RefinanceEvent`** (references a specific `Property`) — a structural *replacement* of that
  property's mortgage: ends the old mortgage artifact at the refinance month and creates a new
  mortgage `Account` (new balance/rate/term, possibly cash-out as a one-time transfer), both
  tagged to the property. The old mortgage remains as **history** (a past segment), not deleted.
  Refinancing is an *event* (discrete structural change) — distinct from *tweaking* an existing
  mortgage's terms, which is done directly on the `Property` (§10.3). See §10.7 for how the old
  and new mortgages are presented across time.
- **Rent is NOT special — it is an ordinary budget item.** There is no rent-specific start or end
  event. Rent is a monthly-native expense `CashFlowSeries` like groceries or utilities; a user may
  have **any number** of them (two apartments, a storage unit) simply by adding budget items.
  - **Starting** any expense = adding a budget item with a start month. (No "start rent" event.)
  - **Ending** any expense = setting that item's `endMonth`. A **general budget-item capability**
    available to every item, surfaced as a legible, undoable action on the timeline (not a silent
    field edit, and not a bespoke per-item event). "I stopped renting" is mechanically identical
    to "I cancelled my gym membership."
  - Because home purchase can't identify "the rent," the user ends whichever housing item(s) they
    are leaving themselves — an ordinary budget-item end, with or without a coincident purchase.
  - Budget items carry an optional **`category`** tag (e.g. `"housing"`). Affordability/DTI (§4.5)
    and "% of income on housing" read the tag and sum all housing-tagged items — they do NOT look
    for a magic "rent" stream. This tag is the only distinction housing items get; it's a tag, not
    a different object type.
- **`HomeSaleEvent`** (references a specific `Property` by id) — (1) pays off / removes that
  property's mortgage account from proceeds; (2) ends that property's cost streams and closes the
  `Property` entity (its value stops contributing to net worth); (3) one-time transfer of **net
  proceeds** (property value − remaining mortgage − selling costs; may be positive or, if
  underwater, negative) into a liquid account. **Touches no other property** — same
  reference-scoped discipline as separation not touching child costs. "Sell the current home and
  buy a new one the same month" = `HomeSaleEvent(old)` + `HomePurchaseEvent(new)` at one month;
  "own both a while then sell" = the sale event fires later, both properties coexisting in the
  gap. See the intra-month ordering rule (§5) — proceeds must settle before the new down-payment
  check runs.
- **`LoanEvent`** — creates a liability `Account` (amortizing) + a one-time disbursement
  transfer if proceeds land in an account.
- **`DebtPayoffEvent`** — a one-time lump-sum transfer against a liability. (Ongoing extra
  payments are handled by the allocation policy's priority list, not an event.)

> **✔ RESOLVED — §4.3 Events (grill session):**
> - **New event `JobChangeEvent` (§11.8):** reference-scoped to ONE income source; ends its series
>   + plan descriptor, starts a new series (`resetAnchor:true`, new anchor) + optional new plan
>   descriptor; must not touch a person's other concurrent jobs. A same-employer raise stays a plain
>   `fromHereForward` override (no event).
> - **`HomeSaleEvent` selling cost (§11.7):** default **7%** (editable per sale). Underwater
>   (negative net proceeds) is funded that month from liquid assets, then the §5.1 cascade.
> - **Backdated obligations (child / house / spouse):** enter via structure-at-historical-origin +
>   value-entered-as-of-now, producing no cash flow before "now" (see §4.6). Child support
>   is income-linked, so it is naturally current with no reconstruction.

### 4.4 Support obligations

- **Child support → income-linked.** Modeled after real "percentage/income-shares"
  formulas: computed each month as a share of the **payer's current salary series value**
  (not a fixed baseline). This is the first stream type that references *another live
  series*. One support stream per shared child, ending when that child turns 18 (end month
  derived from the child's birth month).
- **Alimony → fixed-dollar.** Real alimony is typically set as a fixed amount at divorce
  time; it doesn't auto-adjust to the payer's raises. Compute the amount once (a default
  formula such as a share of income difference is fine), then store the *result* as a
  monthly-native stream with its own growth mode and a duration (default: e.g. half the
  marriage length — jurisdiction-dependent).

> **Disclaimer requirement:** support/alimony formulas vary widely by jurisdiction. What's
> encoded here is a general pattern, not legal guidance. The UI must not present computed
> figures as authoritative — include a visible disclaimer wherever these appear.

### 4.5 Home purchase — down-payment (hard) and affordability (soft) rules

Two separate constraints, modeling how real underwriting actually works:

- **HARD BLOCK — down payment must come from liquid, "sourced" funds.** The down payment must
  be coverable at the purchase month from **liquid assets** (the house-fund goal balance +
  other accessible savings/investments). If it isn't, the `HomePurchaseEvent`'s
  `checkPreconditions` **fails and the purchase cannot fire** — this is a block, not a warning.
  Real mortgage lenders require documented, sourced funds and specifically prohibit funding a
  down payment with another loan or credit-card cash advance (they scrutinize large recent
  deposits for exactly this). So: **the §5.1 credit-card shortfall cascade is NOT a valid
  down-payment source.** That is the clean line — shortfall financing keeps you afloat month to
  month; it cannot manufacture a down payment. (Legitimate assistance — documented family
  gifts, down-payment-assistance programs, piggyback second mortgages — is deferred; if added
  later, they're explicit funding *sources the user adds*, never the automatic fallback.)
- **SOFT WARNING — ongoing affordability (DTI).** Even with the down payment covered, the
  resulting housing cost (mortgage + property tax + insurance + HOA) may be crushing. Do NOT
  block. Instead, compare housing cost against debt-to-income guidelines (~28% of gross on
  housing, ~36% on total debt) and flag when exceeded, showing the *downstream consequence*
  from the actual projection: "this purchase puts you at 45% of income on housing (lenders
  typically cap ~28–36%); this scenario hits shortfalls starting [month] and drops retirement
  to 82% on track." Show the consequence; let the user decide.

Summary: **down-payment coverage = hard block; ongoing-payment affordability = soft warning
with visible downstream consequences.**

> **✔ RESOLVED — §4.5 affordability (§11.6):** DTI soft-warning thresholds are **28% front-end**
> (housing ÷ gross) / **36% back-end** (total debt ÷ gross). Soft warning only — does not block.
> Down-payment coverage remains a hard block from liquid/sourced funds (credit is never a source).

### 4.6 Backdating — historical events & the "now" marker (past is STRUCTURAL ONLY)

Users can enter events that already happened ("I had a kid 2 years ago"). This means **"now" is
a distinguished marker that sits in the *middle* of the simulated span, not at month 0** — the
timeline may start before now (at the earliest historical event) and runs forward through the
past to now and on into the future.

**Core principle: the past establishes *structure*, never finances.** History exists only to set
up what is structurally true and in-flight as of now; it is never financially simulated.
**Entered current balances are the sole source of financial truth at "now," and the projection's
financial accumulation runs forward from there.** This decisively resolves the otherwise-fatal
conflict between a *reconstructed* past (what the model would compute) and the *entered* present
(what the user actually has) — the present always wins, because real financial history is too
noisy to reconstruct from a few events, and the user's stated current balance is the number they
trust. There is **no past net-worth curve** in v1.

Rules:

1. **"Now" marker.** Events may be dated before or after now. The timeline's *structural* start is
   the earliest historical event; its *financial* start is now.
2. **Historical events reconstruct structure only** — which entities exist and which streams are
   active-and-partway as of now, and they date *future* consequences correctly. A kid born 2 years
   ago exists, is age 2, their cost stream is 2 years into its 18-year run and ends in 16 years. A
   mortgage from 3 years ago exists with 27 years left. No past billing, no past balances, no past
   curve.
3. **In-flight state is entered as of now, not re-derived.** A backdated mortgage's *current*
   balance is entered (or approximated), not computed by re-amortizing from origin. Same for any
   partner finances (their *current* balances), etc.
4. **Narrow exception — in-progress annual constraints.** Recent-past facts that feed a *forward*
   annual limit may be entered as of now: specifically **year-to-date 401(k) contributions** if the
   sim starts mid-year, because the current balance doesn't encode them and they reduce this year's
   remaining contribution room (§5.4). This is the *only* historical financial input.
5. **Scrubber into the past is structural only (§10.8).** Scrubbing before "now" shows reconstructed
   structure (who existed, what was active) but **no financial curve** — the net-worth line begins
   at "now." Pre-now is visually marked as structural-only, distinct from the projected future.

*(A reconciled, approximate backward financial view is a possible later addition — explicitly
deferred. v1 past is purely structural scaffolding for the forward projection.)*

---

> **✔ RESOLVED — §4.6 Backdating (grill session):**
> - **Mid-year start (§11.17):** "now" is an arbitrary month, never snapped to January. The first
>   calendar year is partial; contribution caps prorate against YTD; `calendar` escalations fire at
>   the next boundary (may be <12 months). YTD 401(k) is optional and nudged; absent → zero YTD,
>   flagged as possibly overstating remaining cap room.
> - **TWO permitted historical financial inputs, not one:** (1) YTD 401(k) contributions and (2) a
>   **pre-now earnings summary** seeding the `EarningsRecord` for Social Security — this resolves the
>   §4.6 ↔ §5.4 contradiction (a mid-career `EarningsRecord` cannot be built from post-"now" earnings
>   alone; the 35-year AIME would be systematically understated). Rule 4's "only historical financial
>   input" is corrected accordingly. Everything else backdated remains structural-only.
> - **In-flight state entered as of now** (mortgage current balance/remaining term, partner current
>   balances) — never re-amortized or re-derived from origin.

## 5. `Simulator` — fixed monthly pipeline

Run the simulation in **nominal** terms. For each month, in strict order:

1. **Fire due events** (structural changes) — `apply` each event whose month has arrived,
   after `checkPreconditions` passes. **Intra-month ordering:** when multiple events share a
   month, apply **proceeds-generating events (e.g. `HomeSaleEvent`) before proceeds-consuming
   ones (e.g. `HomePurchaseEvent` and its down-payment check)**, so "sell-then-buy in one month"
   funds the new down payment from the sale's net proceeds. More generally: events that add
   liquid funds settle before events that spend them.
2. **Net cash flow** = Σ income series − Σ expense series (for active, non-expired series).
3. **Allocation policy** — route net cash flow through the household waterfall: per-person
   pre-tax deductions (e.g. 401k as % of that person's gross) come off first; take-home
   feeds shared expenses (proportional-to-income contribution by default) then shared goals
   in a user-defined **priority order**; each person's leftover funds their own goals. When a
   month can't be covered, apply the **shortfall cascade (§5.1)** — never make an arithmetic
   impossibility (moving cash an account doesn't have).
4. **Compound every account exactly once, unconditionally** — the ONLY place growth
   happens. Assets grow at `preciseMonthlyRate`; liabilities accrue interest and reduce by
   their computed payment.
5. **Snapshot** net worth (nominal). Reporting layer converts to real per §0.4.

### 5.0 Allocation waterfall (pipeline step 3, in detail)

One opinionated waterfall — **not** a pile of configurable knobs. Every knob exposed is a way
for the projection to be subtly wrong or to model something that doesn't match how people
actually manage money. Build the structure fixed; expose only the three levers noted at the end.

Per month, in strict order:

1. **Per-income-source pre-tax deductions come off each source's gross, first.** A person may
   have **multiple concurrent income sources (multiple jobs)** — income is a `CashFlowSeries`
   owned by a person, and nothing limits one per person. **Only jobs that carry a retirement-plan
   descriptor (§5.5) contribute** — a job with no plan defers nothing. Each such job's deferral is
   a % of *that job's* gross (pre-tax is pre-tax — non-negotiable ordering), with that employer's
   match rule, funding a **person-owned account** (§5.5); the combined per-person deferral is
   subject to shared IRS annual limits (§5.4). Funded only from that income — if a person has no
   income a month (job loss), their contribution is zero; it can't be funded
   from a partner's gross. (This is the §5.3 `computeTax` seam's upstream.) **Contribution caps
   apply here (§5.4):** if a deferral would exceed the applicable limit, cap it and redirect the
   overflow to the next destination in the priority order (never contribute an illegal amount).
2. **Each person's remaining take-home lands in a personal available-cash pool.**
3. **Shared expenses are paid from a shared pool both contribute to.** The one real modeling
   decision — *how much does each person contribute?* Two schemes:
   - **Proportional to income (DEFAULT)** — each contributes to the shared pool in proportion to
     their take-home; the higher earner covers a bigger share of rent/groceries/mortgage. Most
     common modern arrangement and the most robust — degrades gracefully under very unequal
     incomes or an income drop to zero.
   - **Even split (alternative, not default)** — 50/50 regardless of income. Common among couples
     who keep finances separate, but breaks under income shocks (a zero-income partner can't pay
     half the rent).
4. **Shared goals funded from the shared pool in the user-defined priority order** — emergency
   fund → shared tax-advantaged → shared taxable/brokerage → extra debt payments. Fund in order
   until money runs out (this is the §5.2 goal priority list at household level).
5. **Each person's leftover personal cash funds their own goals**, in their own priority order.
6. **Shortfall** (shared expenses exceed the shared pool, or any step can't be funded) → the
   §5.1 cascade. Never a silent negative.

**Exposed to the user (and nothing more):** each person's 401(k) contribution %; the
shared-contribution scheme (proportional default vs. even); the goal priority order
(drag-to-reorder). **Kept under the hood:** the waterfall structure itself, the proportional
math, the shortfall drawdown — do not let users rearrange the waterfall; pre-tax → take-home →
shared → personal is how money works, and making it configurable invites incoherent models.

> **✔ RESOLVED — §5 pipeline & §5.0 waterfall (grill session):**
> - **Same-month determinism tie-break:** after the producer-before-consumer rule (§5), order
>   remaining same-month events by **ledger-insertion order** (a monotonic sequence number on each
>   event record). Required for byte-identical replay (§6).
> - **Waterfall stays FIXED; FOUR exposed levers, not three:** per-person 401(k) %, shared-
>   contribution scheme (proportional default / even), goal priority order, **and surplus-cash
>   destination** (idle-in-liquid default / swept-to-investment). Surplus-cash is the backstop
>   destination when the goal priority list is exhausted. The ordering itself is never user-
>   configurable (pushed back on making the waterfall a user choice — it is money-flow plumbing, not
>   a strategy; every "I don't do the waterfall" case is a waterfall whose inapplicable steps are 0).
> - **Non-wage income enters POST-DEFERRAL by default:** pre-tax deferral is taken only off wage
>   income carrying a `planDescriptor`; SS, alimony/child-support received, rental, and dividends all
>   skip step 1. Placement reads `planDescriptor` presence, never `taxCategory`.
> - **"Post-deferral" ≠ "post-tax":** post-deferral income (including SS) still joins the taxable
>   pool feeding `computeTax` (tagged by `taxCategory`); only the post-tax net lands in the personal
>   cash pool. Dropping it in the post-tax pool under-taxes it; putting it at the top over-taxes it as
>   wages — both wrong.
> - **Overflow (caps, §11.14 / §5.4):** cap at the applicable limit and redirect to the **next
>   destination in the user's goal priority order** (not hardcoded to taxable brokerage); the capped
>   deferral re-enters the waterfall as **taxable** cash following that order. The user sets the
>   priority order (drag-to-reorder); default order is emergency fund → tax-advantaged →
>   taxable/brokerage → extra debt.
> - **Zero total household income:** short-circuit the proportional math (no 0/0); the shared-
>   shortfall drawdown order is shared liquid → shared credit → members' personal liquid → personal
>   credit → hard-infeasibility (deterministic by owner insertion order). Even-split's zero-income-
>   partner personal shortfall is intended behavior, not to be smoothed over.

### 5.1 Shortfall cascade (replaces the old "never go negative" rule)

The rule is **not** "net worth can't go negative" — negative net worth is normal and modeled
(§3). The rule is: **model a cash shortfall realistically, and never make an impossible move
(money appearing from nowhere, an account paying from an empty balance).** Distinguish three
cases:

- **Negative net worth → allowed, no intervention.** The line goes below zero and climbs.
- **Monthly cash shortfall (expenses > available cash) → cascade, in order:**
  1. **Skip discretionary savings** that month (don't fund the brokerage the month you can't
     make rent).
  2. **Draw down liquid assets** (savings → brokerage).
  3. **Route the remaining deficit to a credit-card liability account**, up to its limit,
     accruing at that card's APR and servicing minimum payments. This is the
     paycheck-to-paycheck / living-on-credit case — the shortfall doesn't vanish, it becomes
     compounding high-interest debt that drags net worth down. **Automatic**, with a
     **prominent flag**: "expenses exceed income starting [month]; this scenario accumulates
     $X in high-interest debt by [year]."
     - *If the user entered credit card(s):* route to them, **lowest-APR first** by default
       (reuse the drag-to-order priority mechanic to let the user override the order).
     - *If the user entered none:* use a **synthetic default card** (~22% APR, optional
       default limit) and flag explicitly: "No credit account entered; this scenario assumes
       borrowing at 22% APR. Add a card for accurate terms."
- **Deficit exceeds all available credit → terminal HARD-INFEASIBILITY flag.** No assets, no
  credit left, expenses still due — the money can't be routed anywhere real. Still compute
  and show the plunging line, but surface the most-severe marker: "**you run out of money and
  credit in [month] — this plan doesn't work.**" This is arguably the single most valuable
  warning the app produces, and the reason to model credit limits precisely.

> **✔ RESOLVED — §5.1 shortfall cascade (grill session):** the synthetic default card uses the
> §11.2 minimum-payment rule (greater of 2% / $25). For a SHARED shortfall exceeding shared
> resources, the drawdown reaches members' personal liquid/credit after shared, in deterministic
> owner-insertion order (see the §5.0 RESOLVED block). Underwater home-sale proceeds route here too
> (§4.3 / §11.7).

### 5.2 Goals

A **goal is a funding target competing for the same net cash flow the allocation waterfall
(§5 step 3) already distributes.** This is not a new subsystem — it makes the allocation
policy goal-aware. A goal is a prioritized destination in the waterfall with a target amount
and target date. **Retirement is not special — it becomes the highest-priority *horizon* goal
by default**, sharing the same priority list and on-track math as every other goal.

**`Goal` fields:** `id, name, targetCents, targetDate (or "asap"), fundAccountId` (dedicated
account/sub-balance it accumulates into), `priority` (drag-to-order, shared with retirement),
`type`.

**Two structurally different goal types:**

- **One-time goals** (trip, house down payment, wedding) — accumulate to target, then the
  balance is *spent* by an event. A house-down-payment goal feeds `HomePurchaseEvent` (its
  fund IS the "liquid, sourced" money the §4.5 hard block checks for); the accumulated balance
  is drawn as the one-time transfer when the purchase fires. Then the goal is "done."
- **Horizon goals** (college fund, baby fund, retirement) — accumulate toward a target by a
  date, then *draw down over time* (college paid over ~4 years). A savings phase then a
  withdrawal phase — retirement is just the largest instance, so the same "can it be funded
  and survive withdrawal?" logic applies.

**"Percent on track" — precise definition (must be projection-based, not naive).** Run the
projection with the current plan; for each goal compute:
`onTrack% = projected fund balance at target date ÷ target amount`.
100%+ = on track; 60% = you'll have 60% of the target by your date at current savings rates.
This uses the *projection* (future contributions + growth), not "saved so far ÷ target" —
which is the entire point of having a simulator.

**Priority interaction is the planning insight, surfaced honestly.** Goals compete for finite
cash. Prioritizing "house in 3 years" above retirement funds the house first and *visibly
lowers* retirement's on-track number. The tool shows this tension rather than pretending all
goals can be maxed at once — reprioritizing one goal moves the others on screen.

> **✔ RESOLVED — §5.2 goals (grill session):**
> - **Near-month-0 verdict threshold (§11.3):** a **horizon** goal with target date **< 12 months**
>   routes to the §8.6 immediate feasibility-verdict branch (asset-ratio path). **One-time** goals
>   always use the projection path regardless of proximity.
> - **Goal fund account type/rate + short-horizon-risk flag:** a goal may accumulate into any
>   account with a user-set rate/type (brokerage/HYSA/bonds/cash) — already supported. Because v1 uses
>   fixed rates with NO risk modeling, add an honesty flag on a short-horizon goal held in a high-
>   return/high-risk account ("does not model short-term market risk, which matters most for near-term
>   goals").

### 5.3 Tax — deferred, but design THESE THREE SEAMS now

Tax is deferred for v1, but unlike Monte Carlo or asset-division (which are localized bolt-ons),
tax **threads through the whole pipeline** — income (gross vs. net), contributions (pre-tax
401k vs. Roth vs. taxable), withdrawals (taxed by account type), and the retirement check.
Hardcoding "take-home = gross × 0.75" anywhere bakes in an assumption that's painful to remove.
So build these three cheap seams now so the real model is a *fill-in-the-functions* job later,
not a re-architecture:

1. **`computeTax()` seam — never conflate gross and net.** Formalize the pipeline (§5 step 3)
   transform as **gross → (pre-tax deductions) → taxable income → `computeTax()` → net**, even
   though v1's `computeTax()` is a stub (flat effective rate, or returns 0). What matters is the
   *shape*: one replaceable function the pipeline calls, not tax logic smeared across allocation
   code. Building the real model = replacing one function.
2. **`taxTreatment` field on `Account`** — add `"preTax" | "roth" | "taxable" | "hsa"` now
   (v1 ignores it). Nearly free (one enum), but retrofitting it later means migrating every
   account. Pairs with the `liquid` flag (checking/savings/brokerage liquid; retirement not —
   relevant to the §4.5 down-payment check and §5.1 shortfall drawdown).
3. **Route retirement withdrawals through a function** — the §7 solver withdraws at a safe rate;
   real withdrawals are taxed by account type (pre-tax 401k as income, Roth untaxed, taxable as
   cap gains). v1 may ignore this, but withdrawals must go through a *replaceable step* so
   "apply withdrawal tax by type" is a function swap, not a solver rewrite. Ignoring withdrawal
   tax makes the tool say people can retire earlier than they can — the same error class the
   real-vs-nominal decision guards against.

**When to actually build it:** stubbed tax is fine for validating UX and architecture, but real
tax is a **prerequisite for the tool being *accurate* rather than merely *illustrative***, and
especially for the recommendation engine (§8) — untaxed projections overstate take-home and
retirement readiness, so recommendations built on them are confidently wrong in the dangerous
direction. Until real tax is in, show a visible "estimates exclude taxes" disclaimer on
projections.

> **✔ RESOLVED — §5.3 tax seams (grill session):** a THIRD income-side seam joins the two here —
> **`taxCategory` on income `CashFlowSeries`** (`wages|socialSecurity|ordinaryIncome|capitalGains|
> taxExempt`), distinct from `taxTreatment` on `Account`. Both are present but v1-ignored.
> **Orthogonality rule:** taxation reads `taxCategory`; deferral / waterfall placement reads
> `planDescriptor` presence — never conflate them (a no-plan wage job is still `wages` but defers
> nothing).

### 5.4 Government programs (eligibility-derived income & cost changes)

Programs whose amount or availability is **derived from the user's history or age**, not entered
directly. This is a distinct pattern from jobs/accounts. **All are US-specific and
legislation-dependent — heavy "estimates, not advice, rules change" disclaimer required, and
gated behind the same "accurate vs. illustrative" caveat as tax (§5.3).** If the tool ever serves
other jurisdictions, this concept must be pluggable per-country, not hardcoded.

**Three shapes — build a general `GovernmentProgram` concept covering all three:**

1. **Derived income stream** — a `CashFlowSeries` whose baseline is *computed* from history
   (Social Security, SSDI). Like child support (income-linked) but history-dependent.
2. **Eligibility-triggered stream change at an age/event** — a scheduled step-change in an
   existing stream (Medicare at 65 lowers health costs; unemployment on job loss; Child Tax
   Credit while kids are minors).
3. **Means-tested phase-in/out** (Medicaid, SNAP, ACA subsidies) — eligibility depends on the
   projection's *own output* (income/assets below thresholds) each month. The hardest shape.
   **Deferred for v1** — leave the pattern open, don't build.

**v1 concrete instances (build these two — they affect nearly everyone's retirement picture):**

- **Social Security (shape 1).** A derived income `CashFlowSeries`. **Two parts, split across the
  seam:**
  - **Engine side (no jurisdiction knowledge):** the simulator owns and **accumulates a lifetime
    `EarningsRecord`** as it runs forward — every income segment contributes. Pure bookkeeping.
  - **Rules side (the seam):** the jurisdiction computes the benefit *from* that record at claiming
    age. Interface method, e.g.
    `socialSecurityMonthlyBenefitCents(record: EarningsRecord, ctx: {claimingAge, currentAge, year}) → cents`.
    The engine calls it when the person reaches their claiming age; `rules` implements the actual
    formula. This is the *seam* — same engine-defines-socket / rules-fills-plug pattern as tax/RMD,
    but history-dependent, so the record is threaded through.
  - Real mechanics to *approximate* (disclaim — complex, legislation-bound): highest ~35 years of
    indexed earnings (AIME → PIA bend-point formula); **claiming age is a decision variable** (62
    earliest, ~67 full, delayed to 70 ≈ +8%/yr) — separable from but interacting with the retirement
    solver (§7); COLA-adjusted annually (fits the nominal engine).
  - **It IS income and flows into net cash flow — but with two corrections vs. salary:**
    1. **Tagged for partial taxation.** SS benefits are only *partially* taxable (provisional-income
       rules), NOT taxed as wages. The SS stream carries a `taxCategory:"socialSecurity"` tag; the
       `computeTax` seam reads it and applies the jurisdiction's partial-taxation rule. Dumping SS
       into the salary line and taxing it as wages **over-taxes it** — wrong.
    2. **Enters the waterfall POST-deferral.** SS is not earned wages: no 401(k) deferral or payroll
       deduction comes out of it. It enters net cash flow *after* the §5.0 pre-tax deduction step,
       never at the top with salary — otherwise the model would wrongly let someone "defer" their SS
       check into a 401(k).
  - Subsystem = engine-side earnings-record accumulator + rules-side benefit seam + claiming-age
    choice (default ~67) + the tax tag + post-deferral placement.
- **Medicare (shape 2).** An eligibility age (65) that triggers a **downward step in a
  health-cost stream** (Medicare replaces self-funded insurance, though premiums/Part B/
  supplements/out-of-pocket remain — not to zero). Its main value: making the **pre-65 vs. post-65
  health-cost difference visible**, which is huge for early retirees — the gap between retiring at
  55 and Medicare at 65 is a decade of expensive self-funded insurance the retirement solver must
  reflect (pre-65 health costs are higher).

**General rule for derived program income (applies to SS, later SSDI, etc.):** a
derived-income program stream (a) is computed by a rules-side seam, (b) carries a tax tag so the
jurisdiction taxes it by its own rule, and (c) enters the waterfall **post-deferral** (it is not
earned wages). This keeps "it's income" true without mis-taxing it or wrongly allowing deferrals.

**Pull FORWARD into the tax/retirement work (not deferred):**

- **Required Minimum Distributions (RMDs)** — at ~73–75, forced taxable withdrawals from pre-tax
  accounts regardless of need. Interacts directly with withdrawal logic (§7) and the tax seams
  (§5.3) — pre-tax accounts can't compound untouched forever. Build alongside tax.
- **Contribution limits + catch-up** — caps on retirement-account contributions. NOT one number:
  - **Several distinct limits.** The 401(k) *employee-deferral* limit is separate from the *total-
    additions* limit (employee + employer match combined, a higher ceiling); IRAs (traditional/
    Roth) have their own, much lower, separate limit. Modeling one cap mis-handles someone maxing
    both a 401k and an IRA, or with a large match.
  - **Catch-up is age-banded and per-account-type.** An extra amount starts at 50 (different for
    401k vs. IRA), with a larger catch-up in a specific higher-age band (~60–63) under recent
    legislation — exactly the kind of figure that dates quickly.
  - **Shared-vs-separate across jobs.** A person's *own* deferrals share ONE annual limit across
    all their 401(k)s (multiple jobs — §5.0); each employer's *match* is separate and does NOT
    share. The §5.0 "summed against shared limits" rule applies to deferrals, not to match.
  - **Overflow behavior (allocation decision — §5.0).** When a contribution would exceed the
    applicable cap, **cap it at the limit and redirect the overflow to the next destination in the
    priority order** (e.g. taxable brokerage) — never contribute an illegal amount silently.
  - The actual dollar limits, catch-up amounts, and age bands are legislation-set and change
    yearly — keep them in one place, disclaim they change (§11 open decision).

**Deferred but patterned (list, don't build):** unemployment insurance (time-limited income on a
job-loss event); SSDI (derived like SS); ACA subsidies / Medicaid / SNAP (means-tested, shape 3 —
ACA matters for pre-Medicare early retirees); Child Tax Credit / dependent benefits (tie to
`ChildEvent` + tax); 529 plans (college-fund goal + `taxTreatment` tag); Roth conversions
(supported later by the `taxTreatment` seam); FMLA / parental leave (temporary income reduction
around a `ChildEvent`).

> **✔ RESOLVED — §5.4 government programs (grill session):**
> - **Social Security fidelity (§11.11):** FULL AIME→PIA bend-point formula + 35-year indexing
>   (forced by the cent-pinned anchor; a replacement-rate shortcut is incompatible with it).
>   "Estimate" applies to the FORWARD projection (projected AWI / bend-points / COLA / law), not the
>   formula; the cent-pinned anchor uses a known HISTORICAL claiming case. **Claiming age is user-
>   configurable 62–70, default 67**, and is separate from retirement age.
> - **SS engine/rules split:** the engine accumulates the `EarningsRecord` (+ the pre-now earnings
>   seed, §4.6); `rules` computes the benefit via `socialSecurityMonthlyBenefitCents(record, ctx)`.
>   The null jurisdiction returns 0 (the record still accumulates). The **cent-pinned SS benefit
>   anchor and monotonicity tests live in the `rules` repo**, not the engine (the engine can only
>   test accumulation + the null path).
> - **Medicare / health costs (§11.12):** health is an ordinary `category:"health"` budget item
>   (uninsured = no item / $0). Job-change / early-retirement → a **nudge** (pre-filled ~$1,200/mo/
>   person self-funded, UNSUBSIDIZED in v1 → conservative). Medicare at 65 = a **visible attributed
>   stepped segment** (~$500/mo/person residual), not a silent auto-step. An **honesty flag** fires
>   if pre-65 retirement is not reflected in an elevated health cost.
> - **RMDs (§11.13):** birth-year start age **73 (1951–59) / 75 (1960+)**; rules-side seam;
>   **preTax accounts only** (Roth/HSA exempt); binds as **max(desired, required)** — NOT additive;
>   the forced withdrawal is taxed and routed to a taxable account.
> - **Contribution limits (§11.14):** a structured set of caps (employee-deferral shared across a
>   person's jobs; total-additions; separate IRA; age-banded per-type catch-up). Dollar values live
>   in `rules`, year-parameterized. Overflow → next priority destination (see §5.0 RESOLVED).
> - **Future-year figures are INDEXED FORWARD, not held flat** (nominal-engine correctness): the
>   per-figure basis is rules-side (CPI / wage / legislated / flat), the rate is engine-supplied via
>   seam context; known future legislation stays authored. All §5.4 programs are US-only, behind the
>   pluggable jurisdiction concept.

### 5.5 Employer retirement plans & equity/deferred comp (per-job, feeding person-owned accounts)

**A retirement plan is an employer benefit, so it attaches to the JOB (income source), not the
person — but the account it funds belongs to the person.** Two distinct objects:

- **The account** — the pot of money (balance, returns, `taxTreatment`). An `Account` with
  `ownerId = person`; **shows up in the person's account list** and persists across jobs (you keep
  a 401(k) balance after leaving — you just stop contributing). Durable entity.
- **The contribution channel** — the monthly *flow* in (employee deferral + employer match). This
  is the **job's plan descriptor**, a *funding rule* on the income source that references the
  account it funds. Ending the job ends the descriptor (contributions stop); the account persists.

**Plan descriptor on an income source** (optional — absent = job offers no plan, e.g. gig/part-
time/contract): `{ planType ("401k"|"403b"|"457"|"simpleIRA"|"sepIRA"|"pension"),
employeeContributionRate, employerMatchRule, fundsAccountId }`. `planType` matters because
contribution limits differ by type (§5.4). The match lives here → inherently per-job, doesn't
share the deferral limit. The §5.0 waterfall iterates over income sources that *have* a descriptor.

- **Employer plans (401k/403b/etc. + match) attach to the job; personal retirement accounts (IRA,
  solo-401k) attach to the person.** So "this job has no 401(k)" does NOT mean "can't save pre-tax"
  — a self-employed/gig person uses a personal IRA/solo-401k owned by them. Clean split.
- **Job change:** old descriptor ends, old account persists (may later be rolled into an IRA — a
  one-time transfer, §3.2, between two person-owned accounts). New job's descriptor starts.

**Equity & bonuses — DEFER implementation, but design the shape now.** These are compensation
that arrives on a schedule/condition separate from base salary (lumpy and conditional, unlike the
smooth salary stream). v1 builds none of this, but each piece maps to an existing primitive so it
slots in later by composition:

- **Concept:** an `EquityGrant` / deferred-comp record **attached to an income source** (equity is
  a job benefit; leaving forfeits unvested portions), expressed as a **schedule of conditional
  future payouts** `{ date, amountOrFormula, condition }`.
- **Each payout = a one-time transfer (§3.2)** into an account. v1 has the transfer; the future
  adds the conditional scheduling around it.
- **Value is fixed OR price-derived.** A cash bonus is a fixed amount; an RSU/option is
  `shares × price` where price is a variable — the same *fixed-vs-derived* split as alimony (fixed)
  vs. child support (derived). Designing payout value as "fixed cents OR a formula referencing a
  price series" lets options fit later, and connects to the deferred Monte Carlo work (a stock
  price is exactly what you'd sample, not fix).
- **Vesting condition = the `checkPreconditions` gate (§6).** "Still employed at the vest date" is
  a precondition on the payout firing; leaving early forfeits unvested portions. Reuses existing
  machinery, not new logic. **v1: treat any modeled match/grant as immediately vested** (simpler,
  slightly optimistic) — a known simplification, not an oversight.
- **Equity tax treatment (ISO/NSO/RSU — AMT, ordinary income at vest, etc.) is deferred WITH the
  tax model (§5.3)** — do not attempt it now.

---

> **✔ RESOLVED — §5.5 plans & equity (grill session):**
> - **Employer-plan account on job change (§11.15):** each plan-bearing job creates its OWN
>   person-owned account that persists after the job ends (contributions stop, balance stays &
>   compounds). A new job's plan funds a new account by default, but may point at an existing one.
>   Rollover = a deferred one-time transfer (§3.2). v1 match is immediately vested (forfeits nothing).
> - **Equity / deferred comp (§11.16 — DEFERRED, shape confirmed):** grant on an income source →
>   schedule of conditional payouts → one-time transfers; value is fixed-cents OR a formula over a
>   live series (the §4.4 child-support pattern generalized to a price series); vesting =
>   `checkPreconditions`. `condition` is present but unevaluated in v1 (always vests); forfeiture-on-
>   leave composes with `JobChangeEvent`. The price-derived branch is blocked on a future price-series
>   primitive. Multiple grants per income source allowed. Equity tax stays with the deferred tax model.

## 6. Undo, preconditions, cascade

**The cardinal rule: undo is remove-a-record-then-replay — NEVER in-place editing of an
existing event.** Ledger records are immutable facts; the projection is a pure function of the
record list. Every change to the plan is either *add a new record* or *remove a record, then
replay* — nothing ever mutates a stored event/edit in place.

Concretely, "undo the marriage" does **not** reach into later events (buy-house, child) and
rewrite them. It:
1. **Removes** the marriage record from the ledger (the other records are byte-for-byte
   unchanged).
2. **Discards the entire derived projection** — every balance, stream, and monthly snapshot.
   The projection was only ever a derived view, never truth, so discarding it is free.
3. **Replays from empty state**, applying the remaining records to a world where the marriage
   never happened.

The later events are untouched *as records*; what changes is the *result of replaying them*
against a different history. This applies uniformly — event undo, cascade removal, and
un-applying a recommendation (§8) are all the same remove-tagged-record(s)-then-replay
operation, keyed on an event id or an `appliedRecommendationId`.

### 6.1 Replay validation — Strategy A (build first)

Replay applies events in chronological order, calling `checkPreconditions` on each. If
removing an event would leave a later event's preconditions violated, **block the removal and
name the conflict** in the UI, e.g. *"Removing this divorce would leave you married twice due
to the marriage on [date]. Remove that first."* This is correct and safe — it can never
silently produce a wrong projection — and it's nearly free once replay validation exists.

### 6.2 Reference-scoped cascade — Strategy B (build second, opt-in)

Some dependencies are *partial*. Removing a child invalidates only the **child-support stream
computed from that child**, not the entire `SeparationEvent` (the split still happened; legal
fees and alimony still make sense). So:

- **`computeDependents(entityOrEventId)`** walks references and returns the specific
  streams/obligations that point at the removed thing — NOT everything chronologically after
  it. "Downstream" means *causally dependent via references*, never *later in time*. (A job
  change after a divorce is independent and must survive.)
- **Escalate to removing a whole event only if that event would have no valid reason to exist
  without the reference.** A separation minus one child's support still has a reason to exist
  → it stays, with that one obligation removed. A support stream whose only purpose was that
  child → it goes.
- Present the exact set in a confirmation before removing, e.g. *"Removing this child also
  removes their child support in your [date] separation ($X/mo until 20XX). The separation,
  alimony, and legal fees are unaffected."*

Do **not** build Strategy C (keep an inconsistent ledger with events flagged broken) — it
forces defining projection semantics for an invalid timeline, which is a lot of complexity
before there's demand.

---

## 7. `findRetirementAge` — household-aware

**Build ONE core routine, and both retirement "modes" plus staggered retirement fall out of
it.** The core routine is a single yes/no check:

> Given a specific retirement age for **every** person, does the combined **real**
> (inflation-adjusted, §0.5) portfolio survive to every person's life expectancy? Each
> person's income stops at their age; a safe-withdrawal-rate withdrawal stream starts; the
> check runs against shared + owned assets.

Every retirement question is that check with different ages pinned vs. searched:

- **Mode 1 — "When can *we* retire?" (default headline).** Tie everyone's ages together and
  binary-search them down as a group until the check fails. The last passing age is the
  earliest point where everyone stops at once and the money still lasts. One number.
- **Mode 2 — "When can *this person* retire, given the others' plans?" (per-person).** Pin
  everyone else's ages where they currently are; binary-search only one person's. Answers "can
  I stop at 55 if my partner works to 62?"
- **Staggered retirement needs no special code.** It's just Mode 2 with someone else's age
  manually set to a non-matching value. Set partner to 62, run Mode 2 for yourself against it;
  the extra income years are accounted for automatically.

So there is one survival check and one binary search; "mode" is only *which ages are pinned
and which are searched* (Mode 1 pins nothing, Mode 2 pins all but one). **No upfront choice is
forced on the user:** show Mode 1 as the headline, and let the user click any individual person
to see their Mode 2 number. Each person's retirement age is independently editable.

> **✔ RESOLVED — §7 retirement (grill session):**
> - **Headline default (§11.5):** Mode 1 ("when can we all retire") is the headline number;
>   per-person Mode 2 is one click away. No upfront mode choice is forced.
> - **Claiming-age pinned:** the solver stays 1D (searches retirement age with the Mode-1/2 pins);
>   the SS claiming age is a PINNED INPUT to the survival check, not a searched dimension. "Suggest
>   optimal claiming age" is a future §8 recommendation (sweep 62→70, diff), never a solver change.

### 7.1 Solve mode vs. target mode

The same survival check runs in two directions:

- **Solve mode** (above) — retirement age is *searched*; answers "when can I retire?"
- **Target mode** — the user *pins* a desired retirement date ("I want to retire at 55") and
  the tool reports what has to change. This is just **retirement as a fixed-date horizon goal**
  (§5.2): run the projection with the age pinned, compute on-track %
  (`does the portfolio sustain withdrawals from 55 to life expectancy?` → e.g. "78% of the way
  to a feasible age-55 retirement"), and feed the gap to the recommendation engine (§8) like any
  under-100% goal. No new code — a mode flip on the retirement goal, both directions on the same
  §7 check.

**Honesty requirement:** when a pinned target is unreachable by any realistic combination of
levers, the truthful output is "this date isn't achievable; the nearest feasible is 58" — not a
fabricated plan. This is the §8.2 impossible-lever honesty rule applied to dates.

> Flagged for later: this should eventually run under **Monte Carlo** market returns rather
> than one fixed average — sequence-of-returns risk matters specifically for early
> retirement.

---

## 8. Recommendation engine

The highest-value and highest-risk feature. Value: "how do I actually reach my goals" is the
real question. Risk: overconfident financial advice is genuinely harmful. Two governing
principles:

1. **Recommendations are diagnostic and MECHANICAL — derived from the model, never opinion.**
   Every recommendation must be something the tool can *prove* by re-running the projection:
   "redirecting $200/mo from dining takes your house goal from 70% → 100% on track" is a
   computed, verifiable statement. The engine re-runs the existing `simulate()` with a
   candidate change and diffs the on-track numbers — **no new simulation logic**, just the
   projection run against hypotheticals.
2. **The tool is NOT a licensed advisor.** Anything touching how someone allocates real money
   carries a visible disclaimer: this is a projection tool, not personalized financial advice.

**How recommendations are generated.** The projection identifies which goals are under 100% on
track. For each gap, there is a finite set of levers, and the engine computes the effect of
each by re-running:
- **Reprioritize** — move this goal up; show what it does to the others (honest tradeoff).
- **Extend the timeline** — "pushing the trip from 2y to 3y makes it 100% fundable."
- **Reduce the target** — "a $40k (10%) down payment instead of $60k (15%) is reachable."
- **Redirect spending** — identify expense streams and compute how much redirection closes the
  gap (the most powerful lever; handle with the most care — see register rule below).
- **Increase income** — flag when the gap simply isn't closeable without more income (an
  honest, important message the tool must be willing to deliver).

**Presentation: computed options with tradeoffs, user chooses.** The tool does not declare
"cut your dining budget." It presents quantified options: "Ways to fully fund your house goal:
(a) delay 8 months, (b) redirect $150/mo from [category], (c) reduce target to $48k, (d)
deprioritize retirement (drops it to 88% on track)." The person decides; the tool quantifies.
Decision-support, not robo-advice.

**Register rule (important).** Keep recommendations in the register of *"here's what would
close the gap"*, never *"here's what you're doing wrong."* "Redirecting $X from dining closes
your gap" is a math statement; "you spend too much on dining" is a value judgment the tool must
not make. Note that a category is large/discretionary — do not moralize about it.

### 8.1 Structured change payload

A recommendation is **not** a display string — it carries a machine-applicable `change`
payload, and the human-readable text is *derived* from it. The payload holds:
`{ lever, targetId (series / goal / priority list), magnitude (amountCents | newDate |
newTargetCents | newOrder), startMonth, endMonth? }`.

`startMonth` matters: "redirect $150/mo from dining" needs a *when* (default: next month; user
may adjust before applying). For some levers the date *is* the whole change — "extend the trip
goal 8 months" is purely a `newDate` edit with no series change. `endMonth` distinguishes
"redirect for 3 years" from "redirect forever."

### 8.2 Apply — commits via the ordinary override/edit path

**Apply does NOT mutate past events and is NOT a new event type.** It commits the `change`
through the same `fromHereForward` override/edit path the user already has (§2) — exactly the
change the engine already simulated to produce the preview. E.g. "redirect $150/mo dining →
house, from Mar 2024" becomes a `fromHereForward` override lowering the dining series by $150 +
raising the house-goal contribution, both from `startMonth`. Mapping by lever:

- **Reprioritize** → reorder the goal priority list.
- **Extend timeline / reduce target** → edit the `Goal`'s `targetDate` / `targetCents`.
- **Redirect spending** → `fromHereForward` override on the expense series + goal contribution.
- **Increase income → DISPLAY-ONLY, no Apply button.** The tool can compute that "+$500/mo
  income closes the gap" (useful diagnostic), but it cannot *grant* income — there is no
  user-controlled plan-input to flip. Applying it would fabricate a salary the person hasn't
  earned, projecting a life they aren't living. Show it as information; attach no action.

Every edit an applied recommendation creates is tagged **`appliedRecommendationId`** (mirroring
the `sourceEventId` pattern), so it can be reversed as a clean unit.

### 8.3 Stale previews — regenerate, or re-validate on apply

The preview ("70% → 100%") is computed against the plan *as it was when generated*. If the user
changes other things afterward, that cached number may no longer hold. Two acceptable handlings
— pick one:

- **Live-regenerate** recommendations whenever the plan changes, so a stale preview never sits
  on screen (preferred if browser perf allows — the sim is cheap; previews are always current).
- **Re-validate on apply** (fallback): on click, re-run against the *current* plan, show the
  real current effect ("this now gets you to 92%, not 100%"), and apply that — never commit
  under a stale promise.

> **✔ RESOLVED — §8.3 stale previews (§11.4):** **live-regenerate** — recommendations recompute
> whenever the plan changes, so a stale preview never sits on screen (anti-deception, §10.3).
> Debouncing rapid unrelated edits is an implementation detail.

### 8.4 Un-applying — two locations, one mechanism

An applied recommendation surfaces in **two** places, because the card is transient:

1. **On the card, while visible** — immediately after Apply, the card flips to a stateful
   "Applied ✓ / Undo" for instant "oops, reverse that" feedback. Card lifecycle: *suggested →
   applied (with undo) → dismissed*.
2. **In a persistent "Applied adjustments" panel** — a running list of every accepted
   recommendation (description, start date, realized effect, un-apply button per row). This is
   the durable place to review and reverse adjustments later, when the originating card is gone.
   Keep this panel **separate from the life-event timeline**: a marriage/home-purchase is
   something that happened in the person's life; "redirect $150/mo from dining" is a knob turned
   on advice — mixing them muddies both.

Un-apply from either location is the same operation, reusing §6: **remove all edits tagged with
that `appliedRecommendationId`, replay.** Identical to event undo, keyed on the recommendation
tag instead of an event id — never an in-place edit.

### 8.5 Gate every lever on whether it can actually act

A lever is only offered if it can *do something given the time available*. The engine must not
pad the list with inert suggestions. Before presenting a lever, check it has room to act:

- "Save more" / "redirect spending" require **future accumulating months** between now and the
  goal date. Zero such months → these levers are dead, do not show them.
- "Extend the timeline" is always available (it's a date edit), and is often the *only* live
  lever for a near-term target.
- "Reduce the target" is available whenever a smaller target exists.

When **no lever can close the gap**, say so plainly ("this target isn't achievable with any
available change; the nearest feasible is [X]") rather than listing suggestions that can't
move the number. This protects against every infeasible-near-term request — "fully fund a $60k
goal by next month with no assets" gets the same honest verdict as "retire today."

### 8.6 Degenerate case: "retire (or fund a goal) today / at month 0"

A target at or very near month 0 leaves **no accumulation window**, so it is NOT a
recommendation problem — it's an immediate **feasibility verdict**. Branch explicitly:

1. **Run the immediate survival check** on *current* assets (no projection of future
   contributions — there are none). On-track % here is a straight ratio:
   `current retirement/liquid assets ÷ amount needed to fund life expectancy` — a distinct
   computation path from the projection-based on-track for future goals, so handle it separately
   (it must not route through machinery that assumes ≥1 accumulation month, or it will
   divide-by-zero / behave absurdly).
2. **Return a clear yes/no with the numbers:** "You can retire today," or "You cannot retire
   today — your assets safely fund $X/yr; you need $Y/yr; you're $Z short. Earliest feasible
   date: [year]."
3. **Offer only the levers that exist at month 0** — essentially "push to the earliest feasible
   date" and possibly "lower your retirement income target." Do not render empty
   save-more/redirect cards.

This is a verdict, not an Apply-able recommendation set. (The partner-still-working variant is
§7 Mode 2 at its extreme — one person retires at month 0 while the other keeps earning; the
household survival check handles it, but test this boundary.)

---

> **✔ RESOLVED — §8.6 degenerate case (grill session):** the near-month-0 verdict branch is
> triggered for **horizon goals < 12 months out** (§11.3); one-time goals stay on the projection
> path. The output is a yes/no feasibility verdict, not an Apply-able recommendation set.

## 9. Data-model summary (schema to hand Claude Code)

- **`Person`** — `id, name, isPrimary, retirementAge, lifeExpectancy`.
- **`Household`** — `persons: Person[]`, `membership: {personId, joinMonth, leaveMonth?}[]`.
- **`Account`** — `id, ownerId (personId | "shared"), kind ("asset"|"liability"), balanceCents,
  rate (segments + overrides, NOT a scalar — §3.1), taxTreatment ("preTax"|"roth"|"taxable"|
  "hsa"), liquid (bool)`, and for liabilities an amortization schedule (term, computed payment).
  Credit cards additionally carry `apr, creditLimitCents, minPaymentRule`, and a flag marking
  them eligible as shortfall-fallback targets (§5.1). `taxTreatment` is present but ignored in v1
  (§5.3 seam 2); `liquid` gates the §4.5 down-payment check and §5.1 drawdown. Accounts may have
  attached **one-time transfers** (§3.2) at specific months.
- **`CashFlowSeries`** — `id, ownerId, baselineUnit, growthAnchor, anchorMonth, endMonth?,
  category?` ("housing" etc. — read by DTI/affordability and "% on housing"; a tag, not a type),
  plus baseline/growth-mode/overrides (existing). An override created by an applied
  recommendation carries an `appliedRecommendationId` tag. An **income source (job)** may carry an
  optional **`planDescriptor`** (§5.5): `{ planType, employeeContributionRate, employerMatchRule,
  fundsAccountId }` — absent = no employer plan. The account it funds is person-owned and persists
  across jobs.
- **`EquityGrant`** (DEFERRED — designed, not built; §5.5) — attached to an income source:
  `{ grantDate, schedule: [{date, amountOrFormula, condition}], fundsAccountId }`. Each payout is a
  one-time transfer (§3.2); value is fixed-cents or a price-derived formula; `condition` is a
  `checkPreconditions` gate ("employed at vest date"). v1 does not build this; the shape reuses
  existing primitives so it composes in later.
- **`Child`** — a `Person` with `parentIds: [personId, personId | "external"]`, `birthMonth`.
- **`Property`** — `id, ownerId, valueCents` (with appreciation growth mode), associated mortgage
  `Account` + cost streams. A **durable entity** (§4.1): created by `HomePurchaseEvent`, targeted
  by `RefinanceEvent`/`HomeSaleEvent`, edited as a first-class entity (including its mortgage,
  §10.3). Equity = value − mortgage balance. May have attached one-time transfers (renovations).
- **`Goal`** — `id, name, targetCents, targetDate | "asap", fundAccountId, priority, type
  ("oneTime"|"horizon")`. Retirement is the default highest-priority horizon goal. On-track %
  is projection-based (§5.2).
- **`Recommendation`** — `id, lever, targetId, magnitude, startMonth, endMonth?`, derived
  display text, cached preview, and card state (*suggested|applied|dismissed*). "Increase
  income" recommendations are display-only (no apply). Applying stamps
  `appliedRecommendationId` on the edits it creates (§8.2).
- **`GovernmentProgram`** (§5.4) — `id, kind, shape ("derivedIncome"|"eligibilityStepChange"|
  "meansTested"), eligibilityAge?, decisionParams` (e.g. SS claiming age). v1 instances: Social
  Security (derivedIncome, computed from the lifetime earnings record + claiming age) and
  Medicare (eligibilityStepChange at 65 on a health-cost stream). Produces/modifies a
  `CashFlowSeries`. US-specific; disclaimered as estimates.
- **`EarningsRecord`** — a per-person accumulator the simulator fills as it runs (every income
  segment contributes); Social Security's benefit is computed from it (§5.4).
- **`Event`** (base) — `id, month, sourceTag`, methods `apply(state, month)`,
  `checkPreconditions(state)`, participates in `computeDependents`. Subclasses:
  `RelationshipEvent, ChildEvent, SeparationEvent, HomePurchaseEvent, RefinanceEvent,
  HomeSaleEvent, LoanEvent, DebtPayoffEvent`. (No rent-specific event — rent is a budget item;
  starting/ending budget items is a general capability, §4.3.)
- **`FinancialState`** — `household, accounts[], activeSeries[], properties[], goals[],
  programs[], earningsRecords[]` (+ derived snapshots). A person's income is one-to-many
  (multiple concurrent jobs — §5.0).
- **Ledger** — ordered, immutable `Event[]`; the source of truth. Projection is derived by
  replay.

Everything created by an event carries `sourceEventId` + `role`; everything created by an
applied recommendation carries `appliedRecommendationId`. Both reverse via the same
remove-tagged-record(s)-then-replay operation (§6) — never an in-place edit. `ownerId` is
orthogonal to the event/undo machinery — adding N-person support does not disturb the
event-sourcing spine.

---

> **✔ RESOLVED — §9 data-model additions (grill session):** add to the schema — **`taxCategory`**
> on income `CashFlowSeries`; a **monotonic ledger sequence number** on each `Event` record (the
> same-month tie-break); **`JobChangeEvent`** in the `Event` subclass list; an optional entered
> **pre-now earnings seed** on `EarningsRecord` (§4.6). `Property.value` defaults to `inflationLinked`
> growth. All new tax fields (`taxCategory`, `taxTreatment`) are present but v1-ignored.

## 10. Interaction model — authoring surfaces (UX that the architecture requires)

Most UI is design-craft to improvise at build time (step 10) against the existing mockup. This
section is the exception: it encodes UX rules the architecture *requires*, because getting them
wrong produces a deceptive interface where a value edit secretly authors a ledger event (with
preconditions, cascade, undo semantics) the user can't see. These rules are not optional styling.

### 10.1 Two things the user can do — keep them legibly distinct

1. **Edit a value over time** — change a number that exists (salary, a budget item, an account
   rate). Mechanically a `CashFlowSeries` override (§2). Mental model: *"I'm adjusting a number."*
2. **Author a life event** — a discrete structural change (marriage, child, buy/sell home, loan).
   Mechanically a ledger event (§4) that creates/ends streams and accounts. Mental model:
   *"Something happened in my life."*

The UI must make these *feel* as different as they *are*.

### 10.2 Two surfaces, one shared time axis

- **Budget/Accounts panel (value editing)** — ongoing numbers: income, budget items, accounts.
  Editing is direct: click a number, type, projection re-renders. **No event is created.** The
  "spreadsheet-like" surface; where the savvy user works.
- **Life-event timeline (event authoring)** — a horizontal timeline; adding an event is
  *explicit* authoring (pick "buy a home," fill details, a marker appears). The "story of my life"
  surface; where the beginner feels oriented.
- **Shared spine** — both read against the *same* time axis as the net-worth chart, so an event
  marker and the curve change it caused sit at the same horizontal position. Cause and effect are
  legible because you see the action and the consequence in one place.

### 10.3 The three anti-deception rules (load-bearing — do not violate)

1. **Value edits never silently create events.** Typing a new rent number is an override, period.
   Typing `0` = "this item costs zero now" (recoverable), NOT "stopped renting" (which is ending
   the item — a different, structural action). The two must *look* different on screen: an ended
   item shows "ended [month]", distinct from a `$0` value.
2. **Events are authored explicitly; but PROVENANCE ≠ EDITING SURFACE.** You never add a naked
   mortgage or a naked partner that secretly spawns an event — structural things arrive *via* an
   explicit event (home purchase, marriage). But once created, an artifact/entity is **edited on
   the surface that matches the user's mental model, not by digging up the origin event:**
   - **Durable entities** (`Person`, `Property`) are edited as first-class objects on the normal
     surfaces. A partner's accounts, income, and a future job change are edited **on the partner**
     (in the person-partitioned Budget/Accounts panel), NOT on the marriage event. A house's
     value, costs, **and mortgage** are edited **on the `Property`**, NOT on the purchase event.
     A partner is far more than the relationship event; a house is far more than its purchase.
   - **Tweak vs. structural replacement.** *Editing* an existing artifact's parameters (correct a
     mortgage rate, add extra principal, fix a starting balance) happens on its entity. *Structural
     replacement* (a refinance, a job change big enough to be its own event) is authored as a new
     event. Same value-edit-vs-life-event line, applied within an entity.
   - Provenance (`sourceEventId`) is still tracked for lineage and undo — undoing the marriage
     removes the partner and everything owned by them (including the year-five job change, via the
     person-existence precondition, §6). Editing freely and clean undo coexist; tagging handles both.
3. **User-facing labels are plain language, but each maps to exactly one honest structural
   change.** "Bought a home," "Stopped renting," "Had a child" — friendly words, one label = one
   event. A composite (e.g. a future "Moved" flow) must *visibly* author its constituent events,
   never hide several ledger changes behind one innocent-looking action. (This is why we did not
   name the rent-end action "Move": a move is several different underlying changes; the label
   must match one structural change. Rent is now a plain budget item, §4.3, so "ending rent" is
   just the general budget-item end — no special event at all.)

### 10.4 Progressive depth — one UI, both audiences

- **Anxious beginner** lives on the **timeline**: "add the things that will happen in your life"
  is approachable. Adds events, watches the curve, rarely touches raw numbers; defaults + the
  recommendation engine (§8) carry them.
- **Savvy planner** drops into the **Budget/Accounts panel** for per-item growth modes, account
  rates, contribution %, and override scope.
- **Bridge:** editing a value is possible for the beginner (click, type) but its *advanced*
  controls (growth mode, anchor, override scope) are **progressively disclosed** — hidden behind
  the plain number until asked for. Same field, more depth on demand. One UI, no dumbing-down.

### 10.5 The two interactions, pinned

- **Editing a value over time** — clicking a number opens an inline editor. The *first* edit to a
  series prompts the lightweight intent question (§2): *"this month only, or from here forward?"*
  (the override scope). Beginners get a sensible default (from here forward); the clicked point
  *is* the start month. The word "override" is never shown to the user.
- **Authoring an event** — an "add to timeline" affordance offers the plain-language event types;
  picking one opens a small form (date + specifics); on save it appears as a timeline marker.
  Ongoing costs it creates (child cost, mortgage) appear in Budget/Accounts labeled with their
  source event, reinforcing §10.3 rule 2.

### 10.6 Must-surface properties (UI requirements, not design)

These must be *represented*; exactly how they look is open. The honesty-critical surfaces:
- Infeasibility flags (§5.1 hard-infeasibility; §8.6 "this plan doesn't work").
- Disclaimers: "estimates exclude taxes" (until §5.3 tax is built); not-a-licensed-advisor (§8);
  jurisdiction disclaimer for support/alimony (§4.4).
- Priority-tradeoff visibility (§5.2): reprioritizing one goal visibly moves the others.
- Dual-location un-apply (§8.4): card state *and* the persistent Applied-adjustments panel.
- Per-component data contract: chart needs the monthly projection series; goals panel needs
  on-track %; recommendation cards need the structured `change` payload.

Everything else about visual design is improvised at step 10 against the ledger-aesthetic mockup,
using the frontend-design skill.

### 10.7 Temporal entity views (everything is a sequence of states over time)

The data model is inherently temporal (the ledger is the source; state is derived — §6). The UI
must honor that rather than flatten every entity to a single "now." **Anything with a history — a
person's income/jobs, an account's rate, a property's mortgage — is presented as a sequence of
segments along a time axis, not one value.**

- **Superseded segments stay visible as history**, visually distinct (past-tense / muted) from the
  active one. A refinance does not delete the old mortgage; the property shows *"mortgage 2024–2029
  (original)"* and *"mortgage 2029–present (active)"* as consecutive segments — not two competing
  active lines. Same for jobs: *"old job 2019–2024," "current job 2024→"*.
- **Segments may be CONCURRENT, not only sequential.** A person can hold two jobs at once — the
  income view must show overlapping active segments (two current jobs), not assume one-at-a-time.
  Distinct from superseded history: both are *active* in the overlap.
- **Content is editable; boundaries are event-owned.** A user CAN edit a superseded segment's
  *parameters* (correct the old mortgage's rate, fix a past salary) — that's correcting history.
  But a segment's *start/end* is owned by the events that bracket it: you can't extend the old
  mortgage past the refinance by editing the mortgage — that's editing the `RefinanceEvent`'s date.
  General rule: **a superseded artifact is editable in its content, but its lifespan boundaries
  belong to the events that created and ended it.**
- **"As of [month]" focus.** Any entity view can be focused on a point in time; the active segment
  shown reflects that focus.

### 10.8 The snapshot / scrubber view (a primary view)

A household-wide cross-section at a chosen month: scrub a handle along the time axis and see, *as
of that month*, all account balances, each person's current job, the current partner(s), the
current child(ren), and the current property(ies). This is the most faithful reading of an
event-sourced timeline and should be a core view.

Design requirements (beyond the bare prototype):

- **One unified time axis.** The scrubber handle, the life-event markers, and the snapshot are a
  *single* coordinated control — drag the handle → snapshot updates → the event markers you pass
  explain *why* it changed. Not two separate time controls.
- **Snapshot + curve, side by side.** The snapshot answers "what's true now" (a *stock* — balances,
  who's here). The net-worth **curve** answers "where is this heading / will I be okay" (the
  *trajectory*). Both are required and linked: scrubbing the snapshot moves a marker along the
  curve. A snapshot alone hides trajectory and sequence-of-returns.
- **Stock vs. flow, labeled.** Balances are stocks (instantaneous, clean). Income/expense/cash-flow
  are *rates* (only meaningful over a span). A snapshot mixes them; the UI must make clear which is
  which.
- **End-of-month convention.** The snapshot shows state with that month's events *applied* (the
  month you marry shows you married), consistent with intra-month ordering (§5). Decide once, apply
  everywhere, or boundary months look buggy.
- **Edit-scope = scrubber position.** An edit made while scrubbed to month M defaults to starting at
  M (a `fromHereForward` override at M), with the §2 this-month/forward prompt confirming. The
  scrubber makes *reading* time obvious; this makes *editing* time unambiguous.
- **Three tenses, hinted.** At month M an entity is *active*, *historical* (already ended), or
  *future* (not yet begun). The snapshot shows active, but peripherally hints past/future ("a child
  arrives in 2 years," "you leave this job in 2026") so scrubbing has continuity and things don't
  pop in from nowhere.
- **The "now" marker and the structural-only past (§4.6).** "Now" is a distinguished point on the
  axis; the timeline may extend *before* it (backdated events). Scrubbing before "now" shows
  reconstructed **structure only** — who existed, what was active — with **no net-worth curve
  before "now"** (the financial line begins at "now"). Pre-now is visually distinct (structural /
  approximate) from the projected future.
- **Person-grouped for N people.** The snapshot is partitioned by household member (you / partner /
  shared / children) and collapsible, so it doesn't become a wall with N people and many entities.

Everything else about visual design is improvised at step 10 against the ledger-aesthetic mockup,
using the frontend-design skill.

---

> **✔ RESOLVED — §10 interaction model (grill session):**
> - **Snapshot (§11.10):** end-of-month (events-applied) convention; edit-scope = scrubber position
>   **from "now" forward only**; pre-now scrubbing is **view-only** (no financial curve to edit
>   against). Past values are edited via **history correction** (see §2 RESOLVED), not the scrubber.
> - **Nudges** (insurance at job-change/retirement; end-housing-item on purchase; YTD 401(k) on
>   mid-year start) are explicit prompts, never silent value changes — consistent with §10.3.
> - **Must-surface honesty flags** now also include: pre-65 early-retiree health cost (§11.12) and
>   short-horizon high-risk goal (§5.2 RESOLVED), alongside the existing infeasibility/disclaimer set.

## 11. Open decisions (resolve during the "grill me" step — do NOT let the loop guess these)

> **✔ ALL 17 RESOLVED (grill session, 2026-07-05), plus 13 found gaps.** Each item below is
> resolved — see the inline ✔ RESOLVED blocks in the relevant sections above for full rationale.
> The list is retained for reference and traceability; do NOT treat any item as
> still open. Found gaps beyond this list (determinism tie-break, zero-income 0/0, future-year rules
> indexing, SS earnings seed, backdated obligations, post-deferral generalization, and more) are
> captured in the RESOLVED blocks.

These were deliberately left unresolved in design. Each has a real consequence; the implementer
must not silently pick one. Decide them explicitly before the components that depend on them are
built.

1. **What counts as `liquid`** (per-account flag). Gates the §4.5 down-payment coverage check
   and the §5.1 shortfall drawdown. Proposed v1 default: checking/savings/brokerage = liquid;
   retirement accounts (401k/Roth/HSA) = not liquid. Confirm or adjust.
2. **Credit-card minimum-payment convention** (§3, §5.1). Common options: flat % of balance, or
   greater-of-(% of balance, fixed-dollar floor). Pick one so amortization/growth is defined.
3. **"Very near month 0" threshold for the §8.6 verdict branch.** Is it literally month 0, or a
   small window (e.g. < 12 months) where accumulation levers can't meaningfully move the number?
   A few months of saving genuinely can't close a retirement gap, so a small window is likely
   right — but pick it deliberately, not `=== 0`.
4. **Stale-preview handling (§8.3): live-regenerate vs. re-validate-on-apply.** Pick one.
   Live-regenerate is cleaner UX if browser perf allows; re-validate-on-apply is the fallback.
5. **Retirement headline default (§7).** Which is the headline number — Mode 1 ("when can we all
   retire") or a per-person Mode 2? Spec suggests Mode 1 as headline with per-person on click;
   confirm.
6. **Home-purchase affordability (DTI) thresholds (§4.5).** The ~28%/36% figures are the common
   guideline; confirm the exact numbers used for the soft warning.
7. **Selling-cost default for `HomeSaleEvent` (§4.3).** Realtor + closing costs (~6–8% is common);
   pick a default and confirm the underwater case (negative proceeds) routes through the shortfall
   cascade.
8. **Tweak-vs-structural-replacement lines (§10.3 rule 2 — now mostly resolved).** Rule: tweak an
   existing artifact on its entity (edit a mortgage on the `Property`); structural replacement is a
   new event (`RefinanceEvent`). Remaining to confirm per-case: is a *job change* always its own
   event, or sometimes just a `fromHereForward` salary override? Suggested: a raise/level-change =
   override; a genuine job change (new employer, new terms) = an event. Confirm the threshold.
9. **Property appreciation default (§4.1).** A `Property`'s value grows by its own mode; pick a
   default appreciation rate (or "inflation-linked" / user-set), and whether v1 models it at all
   or holds value flat until sale. Flat-until-sale is simpler; appreciation is more realistic.
10. **Snapshot end-of-month convention & edit-scope (§10.8).** Confirm the snapshot shows
    events-applied (end-of-month) state and that edits default to starting at the scrubber's month.
11. **Social Security approximation fidelity (§5.4).** How faithfully to model the PIA bend-point
    formula and 35-year indexing vs. a simpler estimate — and the default claiming age (~67). This
    is estimate territory; pick a fidelity level and disclaim accordingly.
12. **Medicare health-cost step size (§5.4).** The pre-65 self-funded insurance cost and the
    post-65 residual (premiums/Part B/supplements) are user inputs or defaults — pick defaults, and
    confirm pre-65 early-retiree health costs are modeled as elevated.
13. **RMD schedule & jurisdiction scope (§5.4).** Confirm RMD start age (~73–75, legislation-
    dependent) and that all §5.4 programs are US-only, gated behind a pluggable per-jurisdiction
    concept if the tool ever expands.
14. **Contribution-limit values + overflow behavior (§5.4, §5.0).** Pin the current-year dollar
    limits (401k employee-deferral, total-additions, IRA) and catch-up amounts/age-bands in ONE
    place, disclaimed as annually changing. Confirm the overflow rule: cap at the limit, redirect
    the excess to the next priority destination (taxable brokerage) — the one genuine allocation-
    behavior decision here, needed before the waterfall is built.
15. **Employer-plan account on job change (§5.5).** Confirm the default: a job with a plan creates
    its own person-owned account that persists after the job ends (contributions stop, balance
    stays). Optional later: prompt to roll into an IRA on job change (a one-time transfer).
16. **Equity/deferred-comp modeling depth (§5.5).** v1 defers it; confirm the shape (grant on
    income source → schedule of conditional payouts → one-time transfers, fixed-or-price-derived,
    precondition-gated vesting) is right before anyone builds toward it, and that equity tax
    treatment stays with the deferred tax model.
17. **Mid-year start & YTD contributions (§4.6, §5.4).** Decide whether the sim can start mid-year
    (asking for year-to-date 401k contributions to get the remaining cap right) or always starts at
    a clean year boundary assuming zero YTD. YTD contributions are the *only* historical financial
    input; everything else backdated is structural-only.

Everything else in this document is a made decision, not an open question.
