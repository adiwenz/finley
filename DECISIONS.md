# Decisions — resolutions to BUILD_SPEC.md §11 and gaps found during spec interrogation

Each entry: the question, the answer, the date. This file records resolutions only;
`BUILD_SPEC.md` itself is not edited during this session.

---

## §11.1 — What counts as `liquid`?

**Answer:** Confirmed spec default — `checking`/`savings`/`brokerage` = liquid;
retirement accounts (`401k`/`Roth`/`HSA`) = not liquid. Binary flag, no partial-liquidity tier.

**Date:** 2026-07-05

---

## §11.2 — Credit-card minimum-payment convention

**Answer:** Greater-of-(% of balance, fixed-dollar floor): 2% of balance or $25, whichever
is larger. Applies to both user-entered cards and the synthetic default shortfall card.

**Date:** 2026-07-05

---

## §11.3 — "Very near month 0" threshold for the §8.6 verdict branch

**Answer:** 12-month threshold, applied only to horizon goals (retirement, college fund,
etc.) — a horizon goal with target date < 12 months out routes to the immediate
feasibility-verdict branch instead of the normal projection-based recommendation path.
One-time goals always use the normal projection path regardless of proximity, since a
small one-time goal close to its date is still a case where "redirect spending" is a
meaningful, non-degenerate lever.

**Date:** 2026-07-05

---

## §11.4 — Stale-preview handling (§8.3)

**Answer:** Live-regenerate. Recommendations recompute whenever the plan changes, so a
stale preview never sits on screen; consistent with the spec's anti-deception stance
(§10.3) that a displayed number must never be secretly wrong. Debouncing unrelated rapid
edits (e.g. keystrokes in a field) is an implementation detail, not a spec question.

**Date:** 2026-07-05

---

## §11.5 — Retirement headline default

**Answer:** Mode 1 ("when can we all retire," ages tied together) is the headline number.
Per-person Mode 2 is one click away on any individual person. No upfront mode choice is
forced on the user.

**Date:** 2026-07-05

---

## §11.6 — Home-purchase affordability (DTI) thresholds

**Answer:** 28% front-end (housing cost ÷ gross income) / 36% back-end (total debt ÷
gross income) — the standard conventional-loan "28/36 rule." Soft warning only, per §4.5;
does not block the purchase.

**Date:** 2026-07-05

---

## §11.7 — Selling-cost default for `HomeSaleEvent`

**Answer:** 7% flat default (realtor commission + closing costs combined), user-editable
per sale. Underwater case (negative net proceeds — remaining mortgage + selling costs
exceed sale price): the negative amount is funded the same month by drawing liquid assets
first, then falling through to the existing §5.1 shortfall cascade (credit-card routing,
then hard-infeasibility) if liquid assets are insufficient. No separate mechanism —
reuses the cascade.

**Date:** 2026-07-05

---

## §11.8 — Job-change threshold: override vs. event

**Answer:** Add a dedicated `JobChangeEvent` to the event model (§4.3, §9). A same-employer
raise/level-change remains a plain `fromHereForward` salary override, no event. A genuine
job change is authored as `JobChangeEvent(targetIncomeSourceId)` — reference-scoped to one
income source, exactly like `HomeSaleEvent`/`RefinanceEvent` reference one `Property` and
leave others untouched. It: (1) ends the target income series (`endMonth`) and its plan
descriptor if any, (2) starts a new income `CashFlowSeries` with `resetAnchor: true` (new
anchor month = new hire date) and an optional new plan descriptor. Mechanically this is
existing primitives (ended series + new series + plan-descriptor swap) bundled behind one
authored, undoable, timeline-visible action — consistent with how `RelationshipEvent`/
`HomePurchaseEvent` already bundle multiple primitives behind one label. No new
simulation logic.

**Related — multiple concurrent jobs (confirms §5.0, extends to `JobChangeEvent`):** a
person may hold 2+ concurrent income sources (already specified in §5.0 step 1). Explicitly
confirmed here: `JobChangeEvent` targets exactly one income source and must not touch a
person's other concurrent job(s) — the same reference-scoped-undo discipline used for
separation (child costs untouched) and home sale (other properties untouched).

**Date:** 2026-07-05

---

## §11.9 — Property appreciation default

**Answer:** Model appreciation in v1 (not held flat until sale). Default growth mode is
`inflationLinked` (reusing the existing `CashFlowSeries` growth mode), user-overridable to
a custom rate per property via the same segment+override machinery as everything else
growth-bearing in the engine.

**Date:** 2026-07-05

---

## §11.10 — Snapshot end-of-month convention & edit-scope

**Answer (a):** Confirmed. The snapshot at month M shows state with month M's events
already applied (end-of-month convention — "the month you marry shows you married"),
consistent with the intra-month ordering rule (§5).

**Answer (b):** Confirmed with a refinement. "Edit-scope = scrubber position" (an edit
lands as a `fromHereForward` override at the scrubbed month) applies only from "now"
forward, where a financial curve exists. Scrubbing to a pre-now month is **view-only** for
value edits — there is no financial curve to author a `fromHereForward` override against
(§4.6, "past is structural only").

**History correction (new — resolves how past values are edited):** Correcting a *past*
value (fix an old salary, correct a superseded mortgage's rate) is a THIRD operation,
distinct from the two `CashFlowSeries` override scopes (`thisMonthOnly` / `fromHereForward`).
Per §10.7 ("content is editable; boundaries are event-owned"), it edits a closed historical
segment's stored value **in place**, creating no new segment and shifting no segment
boundary (start/end stay owned by the bracketing events). It is authored on the entity's
segment/history view, not through the scrubber's this-month/forward prompt. Mechanically
this requires a new `CashFlowSeries` capability (in-place segment-value correction, separate
from `addOverride`) not present in the current `cashFlowSeries.ts` API — flagged for the
step-1 extension work.

**Date:** 2026-07-05

---

## GAP (found, not a listed §11 decision) — Social Security earnings record vs. structural-only past (§4.6 ↔ §5.4)

**The contradiction:** §5.4/§9 compute the SS benefit from an `EarningsRecord` accumulated
"as the simulator runs," over the highest ~35 years of earnings; §4.6 says the past is
structural-only with YTD 401(k) as the *sole* permitted historical financial input. For a
mid-career start, the accumulator captures only post-"now" earnings, systematically
understating SS (zero-filled early years drag the 35-year AIME down) — wrong in the same
dangerous direction §0.5 guards against, on a load-bearing retirement input.

**Answer (option 1):** Add a SECOND narrow historical-financial-input exception to §4.6
rule 4: an optional **pre-now earnings summary**, entered as of now (approximated, or pulled
from the user's actual SSA statement), that seeds the `EarningsRecord` accumulator's pre-now
portion. The accumulator then continues adding post-now earnings; AIME/PIA is computed over
the combined record, so future earnings can still refine the benefit (a later high year can
displace a low early year in the top-35). Fallback when the user won't reconstruct earnings:
let them enter SSA's estimated benefit-at-FRA directly (a frozen snapshot; COLA + claiming
adjustment applied on top). When neither is provided, compute from post-now earnings only
with a prominent "undercounts prior earnings — enter your SSA history for accuracy"
disclaimer. §4.6's "only historical financial input" claim must be corrected to "YTD 401(k)
+ pre-now earnings summary" — these two are the permitted historical financial inputs.

**Date:** 2026-07-05

---

## GAP (found) — How backdated in-flight obligations (child, house, spouse) enter the sim

**Question:** For obligations that began before "now" (a child, a house/mortgage, a
spouse), do we add them as cash-flow streams to the current simulation, and how?

**Answer:** Yes, they enter as active streams/accounts/entities — but via
structure-rooted-in-the-past + value-entered-at-now, NEVER by replaying past finances
(consistent with §4.6). Each obligation decomposes along two independent axes:

- **Structural axis (rooted at the historical origin month):** the entity/stream exists
  from its historical event. A stream's **growth anchor** and its **`endMonth`** are
  computed from that origin — a child born 2y pre-now has a `child_expense` stream anchored
  at the historical birth month with `endMonth` = birth+216 (→ 16y left); a 3y-old mortgage
  is a liability `Account` with 27y remaining term; a spouse is a `Person` with membership
  `joinMonth` = the historical marriage month.
- **Financial axis (entered as of "now"):** the *value* is the entered current figure, not
  re-derived — current monthly child cost, current mortgage balance + remaining term,
  spouse's current account balances. Growth/amortization proceeds FORWARD from now. The
  stream/account produces **no cash flow before "now"** (clamped to the financial start,
  matching TEST_PLAN.md §5 "no past billing / accumulation starts at now").

**By type:**
- **Child** → monthly-native `CashFlowSeries` tagged `child_expense`, historical birth
  anchor, `endMonth` birth+216, entered current monthly value, yields from now forward.
- **House** → liability `Account` (mortgage: entered current balance + remaining term,
  amortizes forward) + monthly-native property-tax/insurance/HOA streams (historical
  purchase anchor, entered current values) + `Property` durable entity with entered current
  value appreciating forward. Not a single stream — the composite the `HomePurchaseEvent`
  normally builds, but with entered current in-flight state.
- **Spouse** → `Person` durable entity (membership from historical marriage month) + their
  income `CashFlowSeries` (yields from now forward) + their `Account`s at entered current
  balances. A backdated separation's child support (§4.4) is income-linked to the live
  salary series, so it is naturally "current" with no reconstruction needed.

**Implementation flags for step 1 (`CashFlowSeries` extension):**
1. The primitive needs **anchor ≠ financial-start**: a backdated stream's growth anchor
   sits in the past while it must produce nothing before "now." The current
   `cashFlowSeries.ts` starts producing values at its `startMonth` — this decoupling is a
   real addition alongside `growthAnchor`/`endMonth`.
2. **Own-cycle escalation timing trap:** a backdated own-cycle stream's next escalation
   fires at the next anchor *anniversary*, which may be <12 months after "now" — NOT a full
   12 months from now. The entered current value already bakes in past escalations; forward
   escalations must fire on the historical anniversary cycle, or the first forward raise
   lands on the wrong month.

**Date:** 2026-07-05

---

## GAP (found, from SS reimport) — Post-deferral placement is a general non-wage-income rule, not SS-specific

**Answer:** Generalize the predicate. The §5.0 waterfall's pre-tax deduction step (step 1)
iterates ONLY over wage income sources carrying a `planDescriptor`. Every other income
stream — Social Security, alimony received, child support received, rental income,
dividend/investment income — enters the waterfall **post-deferral by default**. Post-deferral
placement is therefore the DEFAULT for all non-wage income; wage-income-with-a-plan is the
exception that gets deferrals taken off the top. This inverts the framing to the safe
default: a newly-added income stream defers nothing unless it is explicitly a job with a
plan descriptor. Prevents a latent wrong-math bug the moment a user models rental or other
non-wage income (which must never have a 401(k) deferral computed against it).

**Date:** 2026-07-05

---

## Waterfall configurability — stays FIXED; add one surplus-cash lever (pushed back on "make the waterfall a user choice")

**Context:** Proposal was to make the waterfall itself a user choice ("not everyone will
want to do the waterfall"). Pushed back: §5.0 explicitly (in bold, twice) forbids making the
waterfall structure configurable — "pre-tax → take-home → shared → personal is how money
works, and making it configurable invites incoherent models." The waterfall is money-flow
*plumbing* (you can't spend money before you have it; a deferral genuinely precedes
take-home), not a savings *strategy* a user opts into. Every "I don't do the waterfall"
person is just a waterfall whose inapplicable steps are empty (no partner → N=1 shared step;
no plan descriptor → zero deferral; no goals → nothing funded).

**Answer:** Keep the waterfall structure fixed and keep the three existing exposed levers
(per-person 401(k) %, shared-contribution scheme proportional-vs-even, goal priority order).
Add ONE new lever — the genuine choice hiding behind the concern: **the default destination
of unallocated surplus cash** each month (after all goals are funded):
- **Idle-in-liquid (DEFAULT):** surplus accumulates in a default liquid account
  (checking/savings), no assumed investment growth. Conservative; matches the spec's bias
  toward not overstating retirement readiness (§0.5).
- **Swept-to-investment (opt-in):** surplus sweeps into a default brokerage/investment goal
  and compounds at its rate. Models the disciplined auto-investor.

This makes it **four** exposed levers; §5.0's "exactly three levers" statement is updated
accordingly. The waterfall ordering itself remains non-configurable.

**Date:** 2026-07-05

---

## (SS reimport) — `taxCategory` field on `CashFlowSeries` (third income-side tax seam)

**Answer (a) — new field, v1-ignored seam:** Add `taxCategory` to every income
`CashFlowSeries` now, ignored by v1's stub `computeTax`, on the same "cheap now / migration-
expensive later" logic as §5.3 seam 2's `taxTreatment`. It is distinct from `taxTreatment`
(which is on `Account` and governs balance/withdrawal taxation); `taxCategory` governs how an
income *stream* is taxed. Enum:
- `"wages"` — ordinary earned income (default for a job)
- `"socialSecurity"` — partial-taxation rule
- `"ordinaryIncome"` — non-wage fully-ordinary-taxed (pension, traditional-401k withdrawal,
  net rental income)
- `"capitalGains"` — investment/dividend/brokerage income
- `"taxExempt"` — non-taxable receipts (Roth withdrawal, child support received, post-2019
  alimony received, gift/inheritance)

**Answer (b) — orthogonality rule:** `taxCategory` and waterfall placement are independent
axes and must not be conflated. Taxation rule ← `taxCategory`. Deferral eligibility /
waterfall entry point ← presence of a `planDescriptor` (the wage-with-a-plan flag). A job
with no plan descriptor is still `taxCategory:"wages"` but defers nothing. Waterfall
placement must read `planDescriptor` presence, NEVER `taxCategory` — routing placement off
`taxCategory` drifts wrong for the no-plan wage-job case.

**Date:** 2026-07-05

---

## (SS reimport) — Exact waterfall re-entry point for SS and non-wage income ("post-deferral" ≠ "post-tax")

**Answer:** SS and all generalized non-wage income enter the waterfall AFTER the pre-tax
deferral step (step 1, which they skip) but are INCLUDED in the taxable-income aggregation
that feeds `computeTax`, each carrying its `taxCategory`. Only the post-tax net result lands
in the personal cash pool (step 2). Sequencing:

```
wage gross ──(step 1 deferrals, plan-descriptor jobs only)──▶ wage taxable
SS / rental / other non-wage ──(skip step 1)──▶ taxable, each carrying taxCategory
      total taxable pool ──▶ computeTax() (per-category) ──▶ net ──▶ personal cash pool (step 2)
```

**Critical:** "post-deferral" must NOT be read as "post-tax." Two symmetric errors to avoid:
(1) SS at the top with wages → over-taxed as wages + wrongly deferrable (the spec's stated
concern); (2) SS in the post-tax personal cash pool → never runs through `computeTax`,
under-taxed. The correct slot is the narrow band between the deferral step and the
`computeTax` transform. v1's stub `computeTax` returns ~0 so nothing differs numerically yet,
but the insertion point must be correct now or the seam is misplaced.

**Date:** 2026-07-05

---

## (SS reimport) — Null-jurisdiction SS behavior and anchor-repo placement

**#4 — Null jurisdiction SS = 0, record still accumulates:** The null jurisdiction
implements `socialSecurityMonthlyBenefitCents(record, ctx)` by returning 0 (no program). The
engine still accumulates the `EarningsRecord` regardless (engine-side, always runs); only the
*benefit* is 0 until a real `rules` package is plugged in. Standalone, the §7 solver sees no
SS income → a more pessimistic retirement age, which is the correct conservative default
(understating readiness is the safe direction, §0.5).

**#5 — Anchor lives in the rules repo, not the engine:** The "known earnings history →
expected SS benefit, pinned to the cent" anchor and the benefit-monotonicity assertions
(higher history → ≥ benefit; later claiming → higher benefit) are **rules-repo anchors** —
the engine's null jurisdiction returns 0, so they are untestable engine-side (only trivially,
0 ≥ 0). Split:
- **Engine-side (`invariants.test.ts`):** `EarningsRecord` accumulates correctly; the
  null-jurisdiction SS path returns 0, enters post-deferral, carries its tax tag. Mechanics
  only, no benefit numbers.
- **Rules-side (rules repo's own anchor suite):** the cent-pinned benefit anchor and
  monotonicity tests, which need a real jurisdiction to produce numbers.

The current engine `todo("ANCHOR (rules repo)...")` is a placeholder pointer, never to be
given real benefit numbers in the engine suite.

**Eyes-open consequence:** Phase 1 ships with SS stubbed at 0 and its most important
correctness check deferred to Phase 2 (`rules`). The engine's green invariant suite does NOT
prove SS is right — only the rules repo will. Correct per `ARCHITECTURE.md`, but stated so
it is not mistaken for full SS coverage.

**Date:** 2026-07-05

---

## §11.11 — Social Security approximation fidelity + claiming age

**Answer:** Full-fidelity formula, not a shortcut. The cent-pinned SS anchor (added by the
reimport, "single most important external-truth anchor") forces this: a replacement-rate
approximation cannot be pinned to the cent against SSA's calculator, so it is incompatible
with that anchor. Therefore:
- **Fidelity:** real AIME → PIA bend-point formula with 35-year indexing. All constants
  (bend points, National Average Wage Index series, COLA) year-parameterized in the `rules`
  package.
- **"Estimate" reframed:** the formula is exact; what's estimated is the *forward* projection
  fed into it — future AWI growth, future bend points/COLA, and possible legislation changes
  are unknowable. The disclaimer attaches to forward projections, not the formula.
- **The cent-pinned anchor uses a known HISTORICAL claiming case** (all AWI values real) —
  the only case where it can be exact.
- **Claiming age:** user-configurable decision variable, range **62–70**, **default 67**
  (FRA for 1960+ births). Exposed as a config/slider on the SS program (`decisionParams`,
  §9).

**Precision note — claiming age ≠ retirement age.** The claiming-age control is independent
of the §7 retirement-age solve: a user may retire at 60 but claim SS at 67 (bridging with
savings), or retire at 67 and claim at 70. An implementer must not conflate the two. §5.4
already frames claiming age as "separable from but interacting with the retirement solver."

**Date:** 2026-07-05

---

## §11.12 — Medicare / health-cost modeling (reshaped: plain budget item + nudges, not auto-stepping)

**Answer:** Health insurance is an ordinary configurable expense `CashFlowSeries` with
`category:"health"` (the same "plain budget item" model §4.3 gave rent) — fully
user-controlled, NOT an auto-managed magic stream. Consequences:
- **"No insurance" needs no special-casing:** the user simply has no health item / $0. An
  auto-imposed cost would wrongly charge the uninsured.
- **Life-event changes to coverage are surfaced, never silent** (anti-deception, §10.3):
  - **Job-change / modeling retirement-before-65 → a NUDGE** ("your coverage may change —
    adjust your health budget item?") with a pre-filled self-funded suggestion
    (**~$1,200/mo/person** default, rules-side). One-click accept; user may decline (spouse's
    plan, COBRA, none). Rides along with the life event the user is already authoring — same
    pattern as home-purchase nudging the user to end their rent item.
  - **Medicare at 65 → kept as the §5.4 GovernmentProgram (shape 2)**, but its step is
    modeled as a VISIBLE, attributed new segment on the health-cost series (§10.7 temporal-
    segment pattern — like refinance old/new mortgage segments), labeled "health (Medicare)
    65→", with a suggested residual default (**~$500/mo/person**: Part B + Medigap + Part D +
    OOP), user-editable. Program-driven but sourced and visible, not a silent in-place change.
- **Honesty flag (must-surface, §10.6):** when a projection shows retirement before 65 with
  health cost NOT elevated for those years, flag it — "assumes current health cost continues
  through early retirement; self-funded pre-Medicare insurance is typically much higher —
  [adjust]." This preserves the §5.4 solver-correctness concern (elevated pre-65 cost) WITHOUT
  reintroducing silent auto-stepping: the ignored-nudge case is caught loudly, not silently.

**Defaults (all disclaimed, US-specific → rules-side):** pre-65 self-funded ~$1,200/mo/person
(UNSUBSIDIZED — ACA subsidies are deferred, §5.4 shape 3, so v1 is a conservative worst-case
for early retirees who'd qualify; safe direction, refine when means-tested programs land);
post-65 Medicare residual ~$500/mo/person.

**Date:** 2026-07-05

---

## §11.13 — RMD schedule & jurisdiction scope

**Answer (confirmed with precision additions):**
- **Start age is birth-year-dependent** (SECURE 2.0): **73** for births 1951–1959, **75**
  for births 1960+. Year/birth-parameterized in the `rules` package.
- **RMD is a rules-side seam** (same split as SS): engine provides pre-tax balances + age;
  `rules` provides the divisor schedule (IRS Uniform Lifetime Table). Null jurisdiction →
  no RMD.
- **Applies only to `taxTreatment:"preTax"` accounts** — Roth and HSA exempt (Roth 401(k)
  also exempt as of SECURE 2.0 2024). RMD logic reads the §5.3 seam-2 `taxTreatment` tag.
- **Binds as `max(desired pre-tax withdrawal, required minimum)` — NOT additive.**
  Non-binding when the §7 solver already withdraws ≥ the minimum; only bites when withdrawing
  less. Adding RMD on top of the solver's withdrawal would over-withdraw — explicitly
  forbidden.
- **Forced withdrawal is taxed as ordinary income (via §5.3 seam 3) and the net is routed to
  a taxable/liquid account** — RMDs erode the tax-deferred balance regardless of need. v1's
  stub tax ≈ 0, but the pre-tax → taxable ROUTING must be real now.
- **All §5.4 programs (SS, Medicare, RMDs, contribution limits) are US-only**, behind the
  pluggable jurisdiction concept.

**Date:** 2026-07-05

---

## §11.14 — Contribution limits + overflow behavior

**Answer (three confirmed points):**
1. **Overflow rule (engine-side allocation decision):** when a contribution would exceed the
   applicable cap, cap it at the limit and redirect the excess to the NEXT DESTINATION IN THE
   USER'S GOAL PRIORITY ORDER — never contribute an illegal amount. Correction to §11.14's
   wording: "(taxable brokerage)" is only an example; the rule is "next in priority order,"
   which may be an IRA before a brokerage. Do NOT hardcode taxable brokerage as the sink.
2. **Limit structure (seam shape, engine-side):** a structured set, not one number —
   employee-deferral cap (shared across a person's jobs), total-additions cap (employee +
   match per plan, match is per-job and does NOT share the deferral limit), separate IRA cap,
   and catch-up that is age-banded (50+ standard, enhanced 60–63 per SECURE 2.0) and
   per-account-type (401k vs IRA).
3. **Dollar values live in the `rules` package (US-2026), not the engine** — one
   year-parameterized constants module, heavily disclaimed as annually changing. That is what
   "pin in ONE place" means post engine/rules split. v1 implements the employee-deferral-cap
   overflow end-to-end (the common binding case); total-additions and IRA caps are exposed in
   the seam to bind later.

**Clarification — "what is next in priority order? did the user set it?" (raised in grill):**
- **Yes, the user sets it.** The priority order is a drag-to-reorder list of `Goal`s, one of
  the exposed levers (§5.0, §5.2). Each goal's `fundAccountId` is the destination, so "next
  in priority order" = the next goal's fund account. Default order if uncustomized: emergency
  fund → tax-advantaged → taxable/brokerage → extra debt (§5.0 step 4), retirement as default
  highest-priority horizon goal.
- **Level-mismatch resolution:** a 401(k) deferral is NOT itself a goal — it is a pre-tax
  deduction at waterfall step 1, ABOVE the goal-funding steps (4–5). So the capped overflow
  does not "jump" to a goal; it RE-ENTERS the waterfall as cash at the post-deferral point and
  flows through the goal-funding steps in the user's priority order like all other cash.
- **Taxation flips:** money that would have been pre-tax deferral is, once capped, TAXABLE
  (it was not deferred). The overflow re-enters post-tax. v1 stub tax ≈ 0, but overflow →
  taxable routing must be correct now.
- **Backstop:** when the priority list is exhausted (no further savings goal), the overflow
  falls through to the surplus-cash lever (idle-in-liquid default / swept-to-investment) — that
  lever is the ultimate "next destination." Composes with the waterfall-configurability
  decision.

**Date:** 2026-07-05

---

## GAP (found in grill) — Goal fund account type / rate of return + short-horizon-risk flag

**Question:** Can the user choose the rate of return and account type (brokerage / HYSA /
bonds / cash) for a goal's fund?

**Answer:** Yes — and the spec already supports it with no new engine feature. A `Goal`
accumulates into an `Account` (`fundAccountId`, §5.2); an asset `Account` already carries a
user-editable rate (full segment+override series, §3.1 — not a scalar), a `taxTreatment`
tag, and a `liquid` flag. "Brokerage vs HYSA vs bonds vs cash" is just the fund account's
{rate, liquid, taxTreatment} bundle. App-layer (step 11): offer preset account-type bundles
(cash ~0%, HYSA ~4.5%, bonds ~4%, brokerage ~7%) that set the rate; savvy users type an
exact rate. Progressive depth; the engine only needs the rate.

**Short-horizon-risk flag (ADD to v1):** v1 uses fixed deterministic rates with NO
risk/variance modeling (Monte Carlo deferred, §7). A high-return account therefore shows a
higher projected balance with zero modeled downside — strictly better, misleadingly so for
SHORT-horizon goals (a 1-year trip fund in equities is exactly where sequence-of-returns risk
bites and the fixed rate hides it). Add a lightweight honesty flag (must-surface class,
§10.6) on short-horizon goals held in high-return/high-risk accounts: "invested for growth;
v1 does not model short-term market risk, which matters most for near-term goals." This is
in addition to (more specific than) the blanket "returns are fixed estimates" disclaimer.

**Date:** 2026-07-05

---

## §11.15 — Employer-plan account on job change

**Answer (confirmed):**
- Each plan-bearing job creates its **own person-owned account** that persists after the job
  ends — contributions stop (the plan descriptor ends) but the balance stays and keeps
  compounding (§5.5). This is exactly what the §11.8 `JobChangeEvent` does: it ends the old
  job's income series AND plan descriptor, but NOT the account.
- **New job's plan funds a new account by default**, with the option to point its
  `fundsAccountId` at an existing person-owned account to keep one pot. Consequence: a
  multi-job career accumulates several dormant-but-compounding old 401(k) accounts in the
  person's account list — realistic, shown via the §10.7 temporal view.
- **Rollover** ("roll old 401(k) into an IRA") is the deferred consolidation path: a one-time
  transfer (§3.2) between two person-owned accounts, optional prompt later. v1 persists
  accounts separately.
- **v1 match is immediately vested (§5.5)** → a job change forfeits nothing (known
  slightly-optimistic simplification; real vesting-forfeiture deferred with equity, §11.16).

**Date:** 2026-07-05

---

## §11.16 — Equity/deferred-comp modeling depth (deferred; shape confirmed)

**Answer:** Shape confirmed — grant attached to an income source, schedule of conditional
payouts `{date, amountOrFormula, condition}`, each payout a one-time transfer (§3.2) into a
person-owned account, value fixed-cents-or-formula, vesting via `checkPreconditions`. Nothing
built in v1. Four clarifications pinned:
1. **v1-immediately-vested = `condition` present but not evaluated.** When built, the
   condition evaluates against employment at the payout date, and forfeiture COMPOSES with the
   §11.8 `JobChangeEvent`: ending an income source (job change / job loss) forfeits that
   source's UNVESTED payouts; already-vested ones persist in the account.
2. **Price-derived branch is blocked on a price-series primitive** that does not exist in v1
   (deferred Monte Carlo, §7). Only the fixed-cents branch is buildable before that.
3. **"Formula over a live series" is the §4.4 child-support pattern generalized** — child
   support derives from a live salary series; price-derived equity derives from a live price
   series. Same mechanism, different referent; future build reuses §4.4 machinery, not a
   parallel one.
4. **Multiple grants per income source allowed** (initial grant + annual refreshers), each
   with its own schedule — not one-per-job.

Confirmed deferred: equity tax treatment (ISO/NSO/RSU, AMT, ordinary-income-at-vest) stays
with the deferred tax model (§5.3). Funding account is person-owned; grant channel is on the
job — same split as retirement plans.

**Date:** 2026-07-05

---

## §11.17 — Mid-year start & YTD contributions

**Answer:** Support mid-year start — "now" is an arbitrary month, NOT snapped to a clean
January boundary (faithful to §4.6; snapping would misdate every event vs. the user's real
life). Own-cycle anchors (§2) are anniversary-based, so mid-year start doesn't disturb most
growth timing.

**Partial-first-year handling (must be correct):**
1. **Contribution caps:** remaining room in the partial first year = full cap − YTD
   contributions; full cap resumes next calendar year. YTD is per-person-aggregate (across all
   the person's 401(k)s, per the §5.4 shared-deferral-limit rule), NOT per-job.
2. **Annual tax (deferred, seam-aware):** the §5.3 `computeTax` seam must tolerate a partial
   first year (v1 stub ≈ 0).
3. **Calendar-anchored escalations (§2 `growthAnchor:"calendar"`):** next one fires at the next
   CALENDAR boundary, which may be <12 months out — same next-boundary timing trap as backdated
   own-cycle streams. Do not assume a full 12 months from "now."

**YTD input:** optional and NUDGED (not mandatory, not silently assumed). If the sim starts
mid-year and a person has a plan-bearing job, nudge for YTD (materially changes this year's
cap) — consistent with the insurance nudge pattern. Absent it, fall back to zero YTD (full
remaining room), FLAGGED as overstating room for anyone who has already contributed (would let
the model defer more than legal → optimistic).

**Two-inputs correction (closes the loop with the SS-earnings gap):** §4.6 rule 4's "YTD
401(k) is the ONLY historical financial input" is corrected — there are exactly TWO permitted
historical financial inputs: (1) YTD 401(k) contributions, (2) the pre-now earnings summary
(added by the SS-earnings gap resolution). Everything else backdated is structural-only.

**Date:** 2026-07-05

---

## GAP (found) — Same-month event determinism tie-break (threatens the byte-identical-replay invariant)

**The gap:** §5's intra-month rule only PARTIALLY orders same-month events (proceeds-
generating before proceeds-consuming — sell before buy). It is silent on same-month events
with no producer/consumer relationship (marriage + child + loan in one month). The
replay-determinism invariant (TEST_PLAN §3 / §6, "replay is byte-identical") requires a
deterministic TOTAL order; without one, replay can vary by hash-map/insertion happenstance and
the invariant fails silently (any single run looks fine). Order can be financially material
even among "neutral" events (a mid-month shortfall cascade can trip differently by order).

**Answer:** Define a two-tier total order for same-month events:
1. **Primary — producer-before-consumer** (§5, already specified): liquidity-adding events
   before liquidity-spending ones.
2. **Tie-break — ledger insertion order:** the order events were appended to the immutable
   append-only ledger (§6), stored as an explicit monotonic sequence number on each event
   record. Stable and total by construction; deterministic across replays.

No user-facing concept — an internal ordering key on the ledger record. Chosen over
"order by event id" (works only if ids are monotonic) and over a fixed event-type precedence
(insertion order is the more honest, already-persisted key).

**Date:** 2026-07-05

---

## GAP (found) — Proportional split with zero total household income (0/0) + shared-shortfall drawdown scope

**The gap:** the default "proportional to income" shared-contribution scheme divides by total
household take-home. When both members have a zero-income month, that is 0/0 — undefined. This
also forces a broader under-specification: §5.1's cascade never said whether a SHARED shortfall
may tap PERSONAL assets, and in what order, in a multi-person household.

**Answer:**
- **Short-circuit the proportional math when total household take-home for the month is ≤ 0.**
  No proportions computed (no 0/0); shared expenses unfunded from income route entirely to the
  shortfall cascade.
- **Shared-shortfall drawdown scope/order (defined once, general):** shared liquid assets →
  shared credit → members' personal liquid assets → members' personal credit →
  hard-infeasibility. Within the personal tiers, deterministic order by owner ledger-insertion
  order then account order (reuses the same-month tie-break key). Conserves money, never an
  impossible move, byte-identical on replay.
- **Even-split degenerate behavior is INTENDED, not a bug.** Under even-split, a zero-income
  partner's half becomes THEIR personal shortfall and cascades on their assets/credit — possibly
  hard-infeasibility for them while the other partner is fine. The spec explicitly flags
  even-split "breaks under income shocks"; surfacing that asymmetric outcome is the point (shows
  why proportional is the more robust default). Model it; do not smooth it over.

**Date:** 2026-07-05

---

## GAP (found) — Future-year rules parameters for a multi-decade projection

**The gap:** rules are year-parameterized but only `US-2026` is authored; a 2026→2066
projection needs tax brackets, contribution limits, SS bend points, COLA, Medicare costs, and
RMD divisors for ~40 unlegislated future years. The spec never says how a rules package answers
for a year it wasn't authored for. Also constrains the Phase-1 seam signature (the engine must
pass forward-projection assumptions into the rules seam).

**Answer:**
- **Index future-year figures FORWARD, do NOT hold flat.** Forced by the nominal-engine
  discipline (§0.4): a limit/bracket held flat for 40 years shrinks in real terms, understating
  contribution room and mis-scaling brackets — the real-vs-nominal error class §0.4 prevents.
- **Indexing basis is per-figure and rules-side; the rate is engine-supplied.** Rules owns
  which figures are CPI-indexed (401k/IRA limits, brackets), wage-indexed (SS bend points/AIME),
  legislated-step (RMD age, catch-up bands), or flat. The engine passes inflation/wage-growth
  assumptions into the seam via context, e.g.
  `contributionLimits(ctx: {year, inflationAssumption, wageGrowthAssumption})`. Authored years
  return the legislated figure; future years return the last-authored figure indexed forward.
- **Known future legislation stays authored** (RMD 73→75 in 2033, SECURE 2.0 catch-up bands).
  Indexing-forward is only the fallback beyond the last known legislative horizon.
- **Heavy disclaimer:** future-year figures are projections. SS forward bend points (§11.11)
  are one instance of this general rule — the two decisions agree.
- **Null jurisdiction unaffected** (no figures, no indexing, zero everything).

**Date:** 2026-07-05

---

## GAP (found) — Retirement solver vs. SS claiming-age co-optimization

**The gap:** the §7 solver searches retirement age on the survival check; SS claiming age is a
separate 62–70 decision variable that materially changes that check. Unstated whether the
solver holds claiming age fixed or searches it too.

**Answer:** Claiming age is a PINNED INPUT to the survival check, NOT a searched dimension. No
2D co-optimization in v1.
- Solver stays 1D (retirement age, with Mode-1/Mode-2 pins); claiming age is just another pin,
  like the other person's age in Mode 2. Keeps §7's "one check, different pins" clean.
- Matches §5.4's "separable from but interacting with the retirement solver."
- User adjusts claiming age independently and re-runs; the tool shows the interaction rather
  than auto-optimizing it away (optimal claiming is longevity/tax-dependent — needs the
  deferred tax model + Monte Carlo to answer well; auto-picking hides a real user decision).
- If wanted later, "suggest optimal claiming age" is a §8 RECOMMENDATION (sweep 62→70, re-run
  `simulate()`, diff survival/terminal wealth) — pure "no new simulation logic," composes in
  without touching the core solver.

**Date:** 2026-07-05

---

## Session summary

**Spec-interrogation session complete.** Resolved all 17 §11 open decisions plus 13 found gaps
(SS-earnings seeding; backdated in-flight obligations; post-deferral non-wage-income
generalization; waterfall configurability + surplus-cash lever; `taxCategory` field +
orthogonality; SS waterfall re-entry point; null-jurisdiction + anchor-repo split; goal fund
account rate + short-horizon-risk flag; two-inputs correction; same-month event determinism
tie-break; zero-income proportional-split 0/0 + shared-shortfall drawdown; future-year rules
indexing; retirement-solver claiming-age pinning).

**Net-new engine work surfaced that isn't in the spec's build steps as written:**
- `CashFlowSeries` step-1 extension also needs: anchor ≠ financial-start (backdated streams),
  in-place history-correction (a third edit op beyond the two override scopes), and correct
  next-anniversary escalation timing for backdated/calendar streams.
- New event type: `JobChangeEvent` (reference-scoped to one income source).
- New fields: `taxCategory` on income series; monotonic ledger sequence number on event records.
- New rules-seam context: engine-supplied inflation/wage-growth assumptions for future-year
  figure indexing; SS benefit, RMD, and contribution-limit seams.
- New must-surface UI honesty flags: pre-65 early-retiree health cost; short-horizon high-risk
  goal; hard-infeasibility (already specced).

**Constraints honored:** no implementation code written; no repos created; `cashFlowSeries.ts`
and the `invariants.test.ts` anchors untouched. Resolutions recorded here; `BUILD_SPEC.md`
itself was NOT edited (per session constraint) — these decisions should be folded into the spec
/ PRD as the next step.

**Date:** 2026-07-05

---
