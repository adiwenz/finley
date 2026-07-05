# PRD — Financial Life Simulator

**What this document is.** The build plan: scope, milestones, and acceptance criteria, with the
resolved open decisions folded into the build step each one governs. It is deliberately thin and
does **not** restate the architecture.

**Source-of-truth relationship (do not duplicate — reference):**
- **`BUILD_SPEC.md`** — architecture and *what* to build. Authoritative for all design.
- **`ARCHITECTURE.md`** — repo partitioning, open-core split, phased build order.
- **`DECISIONS.md`** — the resolved open decisions + found gaps, with full rationale. This PRD
  inlines each decision's *rule*; `DECISIONS.md` holds the *why*.
- **`TEST_PLAN.md` / `invariants.test.ts`** — what correctness means; the acceptance gate.
- **`CONTEXT.md`** — the domain glossary (ubiquitous language).

> If this PRD and `BUILD_SPEC.md` ever disagree on architecture, the spec wins and this PRD is
> wrong. This PRD only *adds* scope/milestone/acceptance framing and the decision resolutions.

---

## 1. Scope

### In scope (v1)
The pure, event-sourced simulation **engine** and its Phase-2 US **rules**, ending at a minimal
browser UI. Month-by-month nominal net-worth projection, reported in real dollars; a solved
retirement age; goal on-track tracking; a mechanical recommendation engine; US tax/program
**seams** built now with real US-2026 rules in Phase 2.

### Deferred (flagged, not built — see `BUILD_SPEC.md` §1 + `DECISIONS.md`)
Monte Carlo returns; the actual per-account tax *computation* (seams built now); marital asset
division; down-payment assistance sources; means-tested programs (Medicaid/SNAP/ACA subsidies);
unemployment/SSDI/CTC/529/Roth-conversion/FMLA; equity/deferred comp (shape confirmed, §11.16);
match vesting (v1 = immediately vested).

---

## 2. Global rules & resolved conventions (cross-cutting — apply everywhere)

From `BUILD_SPEC.md` §0 (load-bearing) plus session resolutions:
- **Integer cents only**; simulate nominal, report real; **growth happens in exactly one place**
  (compounding); the **ledger is truth**, projection is derived by replay; **no privileged user**;
  **engine purity** (no I/O, jurisdiction only via the seam).
- **Determinism (`DECISIONS.md`: same-month tie-break):** same-month events apply in
  producer-before-consumer order, then **ledger-insertion order** (a monotonic sequence number on
  each event record). Required for byte-identical replay.
- **Two-input historical past (`DECISIONS.md`: two-inputs correction):** the past is structural
  only, with **exactly two** permitted historical financial inputs — YTD 401(k) contributions and
  the pre-now earnings summary. No past net-worth curve; financial accumulation starts at "now."
- **Mid-year start (`§11.17`):** "now" is an arbitrary month, never snapped to January.
- **Waterfall is fixed (`DECISIONS.md`: waterfall configurability):** structure is non-configurable
  plumbing; exactly **four** exposed levers — per-person 401(k) %, shared-contribution scheme
  (proportional default / even), goal priority order, and **surplus-cash destination**
  (idle-in-liquid default / swept-to-investment).
- **Non-wage income placement (`DECISIONS.md`: post-deferral generalization):** pre-tax deferral
  is taken **only** off wage income carrying a `planDescriptor`; all other income (SS, alimony/
  child-support received, rental, dividends) enters the waterfall **post-deferral by default**.
- **Tax seams (`BUILD_SPEC.md` §5.3 + `DECISIONS.md`):** `computeTax()` chokepoint;
  `taxTreatment` on `Account`; `taxCategory` on income `CashFlowSeries` (orthogonal to waterfall
  placement — placement reads `planDescriptor`, taxation reads `taxCategory`); routed withdrawals.
  All ignored by v1's stub, built now.
- **Honesty flags (must-surface, §10.6):** hard-infeasibility; "estimates exclude taxes"; not-a-
  licensed-advisor; support/alimony jurisdiction disclaimer; pre-65 early-retiree health cost;
  short-horizon high-risk goal.

---

## 3. Milestones

Build order is `BUILD_SPEC.md` §1 (1–11), gated per step by the invariant suite. Each milestone
lists its **goal**, the **decisions folded in**, and its **acceptance** (the `TEST_PLAN.md`
invariants that must go green). **Do not reorder** — later steps assume earlier invariants.

### Phase 0 — Walking skeleton (all three repos)
Trivial `engine` → null jurisdiction → bare `app`. Proves packaging, API boundary, dependency
direction while each repo is ~50 lines. **Acceptance:** the three-repo wiring runs end-to-end.

---

### M1 — Extend `CashFlowSeries` (Phase 1)
**Goal:** add `baselineUnit`, `growthAnchor`, `endMonth`, `resetAnchor` to the passing foundation.
**Decisions folded in:**
- `taxCategory` field added now (v1-ignored): `wages|socialSecurity|ordinaryIncome|capitalGains|
  taxExempt`; default `wages`.
- **History correction** (`§11.10`): a THIRD edit op — in-place edit of a closed historical
  segment's value, no new segment, boundaries stay event-owned.
- **Backdated-stream support** (`DECISIONS.md`: backdated obligations): **anchor ≠ financial-start**
  (growth clock in the past, produces nothing before "now"); next own-cycle escalation fires at the
  next **anniversary** (may be <12mo); same for `calendar` anchors at the next calendar boundary.
**Acceptance:** existing green tests stay green; `endMonth truncates`; cumulative-rounding
invariants hold after the new ops. **Do not modify `cashFlowSeries.ts`'s existing behavior or the
anchors.**

### M2 — `Account` (Phase 1)
**Goal:** asset (compounding) + liability (amortizing), credit cards (APR/limit/min-payment),
rate-as-segments (§3.1), one-time transfers (§3.2).
**Decisions folded in:**
- **`liquid` (`§11.1`):** checking/savings/brokerage = liquid; 401k/Roth/HSA = not.
- **Credit-card minimum (`§11.2`):** greater of 2% of balance or $25 (user cards + synthetic
  default card).
- `taxTreatment` present (v1-ignored).
**Acceptance:** **ANCHOR — mortgage amortization $200k@6%/360mo** (pinned, do not edit); rate is a
segment series not a scalar; one-time transfers never compound and conserve money.

### M3 — `Person` / `Household` / `Property` + `ownerId` (Phase 1)
**Goal:** entities + time-bounded membership; add `ownerId` to accounts/series (default single
person; refactor changes no output).
**Decisions folded in:**
- **Property appreciation (`§11.9`):** default `inflationLinked` growth, user-overridable per
  property (not held flat).
**Acceptance:** property equity = value − mortgage contributes to net worth every month; ownerId
refactor is output-preserving.

### M4 — `FinancialState` (Phase 1)
**Goal:** container: household, accounts, active series, properties, goals, programs, earnings
records. **Acceptance:** net worth = Σassets − Σliabilities holds every month.

### M5 — Events (base + subclasses) (Phase 1)
**Goal:** `apply`/`checkPreconditions`/source-tagging; `Relationship`, `Child`, `Separation`,
`HomePurchase`, `Refinance`, `HomeSale`, `Loan`, `DebtPayoff`, **`JobChangeEvent`** (new).
**Decisions folded in:**
- **`JobChangeEvent` (`§11.8`):** reference-scoped to one income source; ends its series + plan
  descriptor, starts a new series (`resetAnchor:true`) + optional new plan descriptor; must not
  touch a person's other concurrent jobs. Same-employer raise stays a plain override.
- **Home-purchase (`§11.6`):** down-payment hard block from liquid/sourced funds (credit is NOT a
  source); DTI soft warning at **28% front / 36% back**.
- **Home-sale (`§11.7`):** **7%** selling-cost default (editable); underwater (negative proceeds)
  funds from liquid then the §5.1 cascade.
- **Backdated obligations decomposition:** child/house/spouse enter via structure-at-origin +
  value-entered-at-now (see `DECISIONS.md`).
**Acceptance:** separation tagging isolation; buy ends no budget item; sale/refinance target one
property; intra-month sell-then-buy funds the down payment; refinance keeps history.

### M6 — `Simulator` (Phase 1)
**Goal:** the fixed monthly pipeline; shortfall cascade (§5.1); goal-aware allocation (§5.2);
multi-income.
**Decisions folded in:**
- **Waterfall fixed + 4 levers**; **surplus-cash lever** (idle-in-liquid default) is the backstop
  destination when the goal priority list is exhausted.
- **Post-deferral non-wage placement**; **SS/non-wage re-entry** is post-deferral but **pre-tax**
  ("post-deferral" ≠ "post-tax" — joins the taxable pool feeding `computeTax`, then the net lands
  in the personal cash pool).
- **Overflow (`§11.14`):** cap at limit, redirect to **next in the user's goal priority order**
  (not hardcoded brokerage); capped deferral re-enters as **taxable** cash following that order.
- **Zero-income 0/0 (`DECISIONS.md`):** short-circuit proportional math when household take-home
  ≤ 0; shared-shortfall drawdown = shared liquid → shared credit → members' personal liquid →
  personal credit → hard-infeasibility (deterministic by owner insertion order). Even-split's
  zero-income-partner personal shortfall is intended, not smoothed.
- **Determinism tie-break** (see §2).
**Acceptance:** no impossible move; shortfalls route through the cascade (never a silent negative);
credit-covered shortfall conserves money; growth in exactly one place; compound once per month.

### M7 — Undo / cascade (Phase 1)
**Goal:** Strategy A (replay validation) then Strategy B (reference-scoped `computeDependents`).
**Acceptance:** replay is byte-identical; remove-then-readd is identity; no in-place mutation;
reference-scoped cascade removes only causally-dependent artifacts.

### M8 — `findRetirementAge` (Phase 1)
**Goal:** one survival check + one binary search on **real** net worth; Modes 1/2 fall out.
**Decisions folded in:**
- **Mode 1 headline (`§11.5`)**; per-person Mode 2 on click.
- **Near-month-0 verdict (`§11.3`):** horizon goals with target < 12 months → immediate
  feasibility-verdict branch (asset-ratio path, no divide-by-zero); one-time goals always use the
  projection path.
- **Claiming-age pinned (`DECISIONS.md`):** solver stays 1D; SS claiming age is a pinned input,
  not a searched dimension.
**Acceptance:** solve mode == target mode at the same age; month-0 goal uses the asset-ratio path.

---

### Phase 2 — `rules` (US-2026) = M9
### M9 — Government programs (Phase 2, engine-side seams in Phase 1)
**Goal:** general `GovernmentProgram` concept; Social Security, Medicare, RMDs, contribution
limits. Engine-side seams (EarningsRecord accumulation, seam signatures, RMD routing, future-year
indexing context) are Phase 1; the *formulas/figures* are Phase 2 `rules`.
**Decisions folded in:**
- **SS split (`DECISIONS.md`):** engine accumulates `EarningsRecord` (+ pre-now earnings seed);
  `rules` computes the benefit via `socialSecurityMonthlyBenefitCents(record, ctx)`. SS carries
  `taxCategory:"socialSecurity"`, enters post-deferral, partially taxed — not as wages.
- **SS fidelity (`§11.11`):** full AIME→PIA bend-point + 35-year indexing (forced by the
  cent-pinned anchor); claiming age **62–70, default 67**, user-configurable; "estimate" applies to
  the *forward* projection, not the formula.
- **Medicare/health (`§11.12`):** health is a plain `category:"health"` budget item; job-change/
  early-retirement → **nudge** (pre-filled ~$1,200/mo/person self-funded); Medicare at 65 = a
  visible attributed stepped segment (~$500/mo/person residual); honesty flag if pre-65 retirement
  isn't reflected. Pre-65 cost is UNSUBSIDIZED in v1 (conservative).
- **RMDs (`§11.13`):** birth-year age **73 (1951–59) / 75 (1960+)**; rules-side seam; **preTax
  accounts only**; binds as **max(desired, required)** — not additive; taxed and routed to taxable.
- **Contribution limits (`§11.14`):** structured caps (deferral shared across a person's jobs;
  total-additions; separate IRA; age-banded catch-up); dollar values live in `rules`, indexed;
  overflow → next priority destination.
- **Null jurisdiction + anchor-repo (`DECISIONS.md`):** null jurisdiction returns 0 for all
  programs; the **cent-pinned SS benefit anchor + monotonicity tests live in the `rules` repo**,
  not the engine (engine can only test accumulation + the null path).
- **Future-year indexing (`DECISIONS.md`):** future figures are **indexed forward** (not held
  flat); per-figure basis is rules-side, rate is engine-supplied via seam context; known future
  legislation stays authored.
**Acceptance (rules repo has its own anchors):** SS is engine-accumulated / rules-computed; SS
enters post-deferral and is partially taxed; **ANCHOR (rules) — known earnings → expected benefit
to the cent** (the single most important external-truth anchor); SS claiming monotonicity; Medicare
step; RMDs force taxable withdrawals.

---

### Phase 3 — `app` = M10–M11
### M10 — Recommendation engine (Phase 3)
**Goal:** re-run `simulate()` against candidate changes, diff on-track numbers; structured `change`
payloads; Apply via the ordinary override path (tagged `appliedRecommendationId`, undoable);
"increase income" display-only.
**Decisions folded in:**
- **Stale previews (`§11.4`):** live-regenerate (recompute on any plan change).
- **Near-month-0 verdict (`§8.6`):** immediate feasibility verdict, not an Apply-able set.
- Optional later: "suggest optimal SS claiming age" is a recommendation (sweep 62→70, diff), not a
  solver change.
**Acceptance:** apply/un-apply is identity; preview matches realized effect; every lever is gated
on whether it can act.

### M11 — Minimal browser UI (Phase 3)
**Goal:** two authoring surfaces (Budget/Accounts value edits; life-event timeline), the three
anti-deception rules, progressive depth, temporal entity views (§10.7), snapshot/scrubber (§10.8),
must-surface properties.
**Decisions folded in:**
- **Snapshot (`§11.10`):** end-of-month (events-applied) convention; edit-scope = scrubber position
  **from "now" forward only**; pre-now scrubbing is **view-only** (no financial curve).
- **Nudges** (insurance at job-change/retirement; end-housing-item on purchase; YTD 401(k) on
  mid-year start) — never silent value changes.
- **Honesty flags** surfaced (see §2).
- **Applied-adjustments panel** separate from the life-event timeline.
**Acceptance:** value edits never silently author events; one label = one structural change; dual-
location un-apply.

---

## 4. Acceptance gate (per `HANDOFF.md` / `TEST_PLAN.md`)

- **The invariant suite staying green is the gate** each milestone must pass before commit
  (todos may shrink; a FAIL blocks).
- **Run the full invariant suite every loop iteration**, not just per-component unit tests.
- **Known-value anchors are pinned by hand** and never edited by the implementing loop
  (engine: mortgage/salary/compounding; rules: the SS benefit anchor).
- **Loop per-issue, then checkpoint** for human review before the next — an early wrong assumption
  compounds through everything after it.
- **Commit per-milestone**, not one batch (bisectable history).

---

## 5. Traceability

| Decision (`DECISIONS.md`) | Milestone |
|---|---|
| §11.1 liquid · §11.2 credit-card min | M2 |
| §11.9 property appreciation | M3 |
| §11.6 DTI · §11.7 sale cost · §11.8 JobChangeEvent · backdated obligations | M5 |
| waterfall/levers · surplus cash · post-deferral · taxCategory · SS re-entry · determinism · zero-income | M6, M1 (fields) |
| §11.5 Mode 1 · §11.3 near-0 · claiming-pinned | M8 |
| §11.11 SS · §11.12 Medicare · §11.13 RMD · §11.14 limits · SS split · null/anchor · future-year indexing · two-inputs | M9 |
| §11.4 stale previews · §8.6 verdict | M10 |
| §11.10 snapshot/history-correction · nudges · honesty flags | M11, M1 (history-correction) |
| §11.15 plan account on job change · §11.16 equity (deferred) · goal-fund rate + short-horizon flag | M5/M6 (accounts), deferred |

Full rationale for every row is in `DECISIONS.md`.
