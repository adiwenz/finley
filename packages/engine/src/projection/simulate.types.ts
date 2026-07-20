/**
 * Public type contract of the household simulator (see `./simulate`). These are
 * the shapes callers hand in (`HouseholdSimInput` and its parts) and get back
 * (`ProjectionSeries` and its per-month rows) — the chart's data contract (§10.6)
 * and the engine's public API. The mutable per-run `SimState` is deliberately NOT
 * here: it stays private to `./simulate` alongside the code that builds it.
 *
 * `simulate.ts` re-exports everything in this file, so importers can continue to
 * import these types from `./simulate` (or the engine barrel) unchanged.
 */

import type { Cents } from "../money";
import type { SimAccount } from "../simAccount";
import type { SimLiability, PaymentStatus, LoanStatus } from "../liability";
import type { SimCashFlowSeries } from "../cashFlowSeries";
import type { SimGoal } from "../goal";
import type {
  PlanDescriptor,
  SharedContributionScheme,
  SurplusDestination,
} from "./waterfall";

/**
 * How one liability's scheduled payment was serviced in a single month — the
 * payment-record seam (see PaymentStatus / LoanStatus). One entry is emitted per
 * liability that had a payment due that month; paid-off, not-yet-originated, and
 * origination-month liabilities have no entry (they still appear in
 * liabilityBalancesCents). `amountAppliedCents` is the payment actually run
 * against the balance in advanceLiabilities.
 *
 * v1-seam: paymentStatus is always `full` and loanStatus always `current` today.
 */
export interface LiabilityPaymentRecord {
  readonly paymentStatus: PaymentStatus;
  readonly amountAppliedCents: Cents;
  readonly loanStatus: LoanStatus;
}

/**
 * The projection series — the engine's public output and the chart's data
 * contract (§10.6). One entry per simulated month, starting at the "now"
 * marker (month 0); there is no pre-"now" financial curve (§4.6).
 *
 * Simulate in nominal dollars, report in real dollars (§0.4): every point
 * carries both `netWorthNominalCents` and `netWorthRealCents`, so the chart can
 * draw the real and nominal curves without recomputing the conversion.
 *
 * Net worth is `null` for every month AFTER the first insolvent one (§5.1). Once
 * the shortfall cascade drops unfundable spending, the model has no fidelity past
 * that point — every later balance is fiction — so it reports "unknown" rather than
 * a misleadingly flat number. The first insolvent month keeps its real (negative)
 * value: it is the honest terminal point where the money runs out. Consumers must
 * treat `null` as "insolvent from here", NOT as zero (`null >= 0` is `true` in JS).
 */
export interface ProjectionMonth {
  readonly month: number;
  readonly netWorthNominalCents: Cents | null;
  readonly netWorthRealCents: Cents | null;
  readonly accountBalancesCents: Readonly<Record<string, Cents>>;
  /** Balance owed on each liability at this month (positive = owed). */
  readonly liabilityBalancesCents: Readonly<Record<string, Cents>>;
  /**
   * Per-liability payment record for this month, keyed by liability id — the
   * partial-payment / forbearance seam. Only liabilities with a payment due this
   * month appear (see LiabilityPaymentRecord). Empty at month 0 (no month is
   * processed before "now", §4.6).
   */
  readonly liabilityPaymentRecords: Readonly<Record<string, LiabilityPaymentRecord>>;
  /**
   * Value of each owned property at this month (positive = asset), keyed by
   * property id. A property appears from its purchase month and drops out once
   * sold; its value contributes to net worth, and equity = value − the associated
   * mortgage balance in `liabilityBalancesCents` (§4.1).
   */
  readonly propertyValuesCents: Readonly<Record<string, Cents>>;
  /**
   * True in any month where the §5.1 shortfall cascade exhausted all available
   * credit and could not cover the deficit. Once true, the plan is unfinanceable
   * from this month forward without structural changes.
   */
  readonly isInsolvent: boolean;
  /**
   * The month's cash flows (income by category, expenses, liability payments) — a
   * diagnostic companion to the stock balances above, for inspection surfaces. See
   * {@link ProjectionMonthFlows}. Absent on month 0 (no flows are processed at "now").
   */
  readonly flows?: ProjectionMonthFlows;
}

/**
 * Per-month cash *flows* (rates), the diagnostic companion to the stock balances
 * on {@link ProjectionMonth}. Not needed to draw the net-worth curve — the balances
 * already encode it — so it is optional and exists for inspection surfaces (the
 * debug panel, §10) that want to see the income/expense movements the month applied,
 * not just the resulting balances. Populated straight from the same income sources
 * and obligations the waterfall consumed, so it can never disagree with the sim.
 *
 * Absent on month 0 (the flow-free opening snapshot, §4.6).
 */
export interface ProjectionMonthFlows {
  /**
   * Gross income this month bucketed by {@link TaxCategory} (`wages`,
   * `ordinaryIncome`, `governmentRetirementBenefit`, …) — the authoritative
   * breakdown of every income source the waterfall saw, including the derived
   * government retirement benefit and RMD draws.
   */
  readonly incomeByCategoryCents: Readonly<Record<string, Cents>>;
  /** Σ of `incomeByCategoryCents` — total gross income this month. */
  readonly totalIncomeCents: Cents;
  /** The government-retirement-benefit slice of income this month (0 before any claim). Convenience view. */
  readonly governmentRetirementBenefitCents: Cents;
  /** Non-liability expenses this month (general + health + any authored lines). */
  readonly expensesCents: Cents;
  /** Scheduled liability payments this month (mortgages, loans, card minimums). */
  readonly liabilityPaymentsCents: Cents;
}

export interface ProjectionSeries {
  readonly months: readonly ProjectionMonth[];
}

/**
 * A person as the *simulator* consumes it — the compiled, engine-facing shape,
 * deliberately narrower than the standing {@link import("../person").Person}
 * authoring model (which carries jobs + `retirementTargetAge`). Here earnings
 * arrive pre-computed as {@link priorEarningsCents}; the standing model compiles
 * into this via {@link import("../compilePerson")}.
 */
export interface SimPerson {
  readonly id: string;
  readonly name: string;
  /**
   * Birth year (§5.4). Present → the simulator accumulates this person's
   * lifetime {@link EarningsRecord} and, at their {@link benefitClaimingAge}, begins a
   * derived Social Security income stream via the jurisdiction seam. Absent → no
   * SS is modelled for them (the record is only useful with an age to claim at).
   */
  readonly birthYear?: number;
  /**
   * Pinned Social Security claiming age (62–70, §5.4). A decision variable, never
   * searched by the retirement solver. Defaults to 67 (full retirement age) when
   * {@link birthYear} is set. Ignored without a birth year.
   */
  readonly benefitClaimingAge?: number;
  /**
   * Pre-"now" SS-covered earnings summary (§4.6), keyed by calendar year — the one
   * historical financial input. Seeds the {@link EarningsRecord} so a mid-career
   * person has a benefit basis before the projection's own earnings accumulate.
   */
  readonly priorEarningsCents?: Readonly<Record<number, Cents>>;
}

/** An income or expense series tied to an owner. */
export interface SimOwnedSeries {
  readonly series: SimCashFlowSeries;
  readonly ownerId: string;
  /**
   * Retirement-plan descriptor (§5.5) for an income source that funds a
   * person-owned account. Presence makes the source eligible for pre-tax deferral
   * in the §5.0 waterfall (step 1); absence means it enters post-deferral. Only
   * meaningful on income series.
   */
  readonly planDescriptor?: PlanDescriptor;
}

/**
 * A property as the simulator consumes it: an appreciating asset stock (§4.1).
 * Value opens at `openingValueCents` at `startMonth`, then compounds monthly at
 * `preciseMonthlyRate(appreciationAnnualRate)` (0 for a flat/`fixed` property).
 * It contributes to net worth through `endMonth` inclusive (a sale month), then
 * drops to 0. Growth-mode → annual-rate resolution happens at the sim boundary.
 */
export interface SimProperty {
  readonly id: string;
  readonly ownerId: string;
  readonly startMonth: number;
  readonly endMonth: number | null;
  readonly openingValueCents: Cents;
  readonly appreciationAnnualRate: number;
}

export interface HouseholdSimInput {
  readonly horizonMonths: number;
  readonly annualInflationRate: number;
  /**
   * The cost-of-living rate applied to government retirement benefits (§5.4). When
   * unset the benefit COLA is COUPLED to {@link annualInflationRate} (general CPI);
   * setting it DECOUPLES the two (e.g. a benefit indexed below general inflation).
   * Optional so no existing input needs editing.
   */
  readonly benefitColaRate?: number;
  readonly startYear?: number;
  readonly persons: readonly SimPerson[];
  /**
   * Asset accounts. Net cash flow is routed through the §5.0 waterfall; leftover
   * surplus idles in the first liquid account by default (see `surplusDestination`).
   * Every account a goal or the surplus destination targets must be one of these —
   * a deposit to an unknown account id would not be counted toward net worth.
   */
  readonly accounts: readonly SimAccount[];
  readonly incomeSeries: readonly SimOwnedSeries[];
  readonly expenseSeries: readonly SimOwnedSeries[];
  /**
   * Liabilities (mortgages, auto loans, student loans, credit cards).
   * Amortizing payments are computed from opening balance/rate/term (§3);
   * credit card minimum payments are computed each month from the current balance.
   * If no credit cards are provided, a synthetic 22% APR card absorbs shortfalls (§5.1).
   */
  readonly liabilities?: readonly SimLiability[];
  /**
   * Owned properties (§4.1). Each is an appreciating asset stock whose value
   * feeds net worth; the associated mortgage is an ordinary entry in `liabilities`.
   */
  readonly properties?: readonly SimProperty[];
  /**
   * Funding goals — prioritized destinations in the §5.0 waterfall (§5.2). Shared
   * goals draw from the household pool; personal goals from their owner's leftover.
   * Retirement is just the highest-priority horizon goal. Defaults to none.
   */
  readonly goals?: readonly SimGoal[];
  /**
   * Lever 2 (§5.0): how partners split shared obligations. Defaults to
   * `"proportional"` (to take-home) — the robust default that degrades gracefully
   * under unequal or zero incomes.
   */
  readonly sharedScheme?: SharedContributionScheme;
  /**
   * Lever 4 (§5.0): where leftover cash lands once every goal is funded. Defaults
   * to `{ kind: "idle" }` — surplus idles in the first liquid account.
   */
  readonly surplusDestination?: SurplusDestination;
}
