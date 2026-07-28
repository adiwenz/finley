/**
 * Public type contract of the household simulator. The mutable per-run `SimState` stays
 * private to `./simulate`, which re-exports this file.
 */

import type { Cents } from "../money";
import type { SimAccount } from "../simAccount";
import type { SimLiability, PaymentStatus, LoanStatus } from "../liability";
import type { SimCashFlowSeries, TaxCategory } from "../cashFlowSeries";
import type { SimGoal } from "../goal";
import type { BudgetLine } from "../budgetLine";
import type { SpendingItem, SpendingSource } from "./spendingItems";
import type { FundingDraw } from "../ledger/transfers";
import type {
  PlanDescriptor,
  SharedContributionScheme,
  SurplusDestination,
} from "./waterfall";

/**
 * One entry per liability with a payment due; paid-off, not-yet-originated, and
 * origination-month liabilities have none (they still appear in
 * `liabilityBalancesCents`).
 *
 * v1-seam: paymentStatus is always `full` and loanStatus always `current` today.
 */
export interface LiabilityPaymentRecord {
  readonly paymentStatus: PaymentStatus;
  readonly amountAppliedCents: Cents;
  readonly loanStatus: LoanStatus;
}

/**
 * The engine's public output and the chart's data contract: one entry per simulated
 * month, starting at "now" (month 0).
 *
 * Net worth is `null` for every month AFTER the first insolvent one — once the shortfall
 * cascade drops unfundable spending, later balances are fiction. The first insolvent
 * month keeps its real (negative) value. Treat `null` as "insolvent from here", NOT as
 * zero (`null >= 0` is `true` in JS).
 */
export interface ProjectionMonth {
  readonly month: number;
  readonly netWorthNominalCents: Cents | null;
  readonly netWorthRealCents: Cents | null;
  readonly accountBalancesCents: Readonly<Record<string, Cents>>;
  /**
   * Post-tax principal, keyed like `accountBalancesCents`; an account's untaxed gain is
   * `balance − basis`. The §4.5 down-payment gate reads it to price the capital-gains tax
   * a liquidation would owe.
   */
  readonly accountBasisCents: Readonly<Record<string, Cents>>;
  /** Positive = owed. */
  readonly liabilityBalancesCents: Readonly<Record<string, Cents>>;
  /** The partial-payment / forbearance seam. Empty at month 0. */
  readonly liabilityPaymentRecords: Readonly<Record<string, LiabilityPaymentRecord>>;
  /**
   * From purchase month until sold. Equity is this value minus the matching
   * `liabilityBalancesCents` entry.
   */
  readonly propertyValuesCents: Readonly<Record<string, Cents>>;
  /** True where the shortfall cascade exhausted all available credit. */
  readonly isInsolvent: boolean;
  /** Absent on month 0 (no flows are processed at "now"). */
  readonly flows?: ProjectionMonthFlows;
}

/**
 * Per-month cash *flows*, the companion to {@link ProjectionMonth}'s stock balances.
 * Populated from the same income sources and obligations the waterfall consumed, so it
 * can never disagree with the sim.
 */
export interface ProjectionMonthFlows {
  /**
   * Gross income bucketed by {@link TaxCategory} — the rollup of {@link incomeSources}.
   * A category is a tax classification, not a source: two jobs share one `wages` bucket.
   */
  readonly incomeByCategoryCents: Readonly<Record<string, Cents>>;
  /**
   * The liquid-buffer drawdown gets its own `savingsDrawdown` source: spending charged
   * straight against cash creates no taxable withdrawal, so "living off savings" would
   * otherwise read as zero income. Not taxable, so absent from `incomeByCategoryCents`
   * and `totalIncomeCents`.
   *
   * Savings interest DOES appear here and in the rollups: its allocation gross is 0 (the
   * cash is already in the balance), but it is real taxable household cash, reported via
   * {@link ProjectionIncomeSource.cashInflowCents}.
   */
  readonly incomeSources: readonly ProjectionIncomeSource[];
  /**
   * Σ `incomeByCategoryCents` — realized taxable income: includes savings interest,
   * excludes the savings drawdown.
   */
  readonly totalIncomeCents: Cents;
  /** 0 before any claim. */
  readonly governmentRetirementBenefitCents: Cents;
  /**
   * Charged through the jurisdiction seam, summed across every person. Already deducted
   * from take-home, so `totalIncomeCents − taxCents` is the household's after-tax gross.
   */
  readonly taxCents: Cents;
  /**
   * The jurisdiction owns the attribution method — US tax is not linearly separable by
   * category — so the engine carries its split rather than synthesizing one. Always
   * present: `{}` in a zero-tax month, otherwise Σ equals `taxCents`.
   */
  readonly taxByCategoryCents: Readonly<Record<string, Cents>>;
  /**
   * Keyed by each source's reporting id (the `sourceId` from {@link incomeSources},
   * falling back to its tax category). Apportioned per person by taxable weight so
   * earners in different brackets never cross-subsidise, at the average rather than
   * marginal rate (disclosed as `taxAttributionProportional`). Always present: `{}` in a
   * zero-tax month, otherwise Σ === `taxCents` (runtime-enforced) and Σ within a category
   * === that category's `taxByCategoryCents` entry.
   */
  readonly taxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * Keyed like {@link taxBySourceCents}; a source that deferred nothing is absent, as is
   * the whole map when none did. Already folded into {@link
   * ProjectionIncomeSource.netCashFlowCents}; this remains only for a per-source view.
   */
  readonly deferralBySourceCents?: Readonly<Record<string, Cents>>;
  /**
   * The month's taxable base, per owner by tax category, **including gains this month's
   * funding draws already realized** — what a FURTHER draw would be taxed on top of. The
   * §4.5 affordability gate reads it so it prices a would-be sale over the same base the
   * simulation will; the pre-funding base would under-price the second of two same-month
   * draws.
   *
   * `{}` for an owner with no taxable income. Optional because the simulator attaches it
   * after `buildFlows`, so flows synthesised without it are still valid.
   */
  readonly taxableByOwnerAfterFundingCents?: Readonly<
    Readonly<Record<string, Readonly<Record<string, Cents>>>>
  >;
  /** General + health + any authored lines. */
  readonly expensesCents: Cents;
  /** Mortgages, loans, card minimums. */
  readonly liabilityPaymentsCents: Cents;
  /**
   * Keyed by the line's `allocations()` id (`line:<id>`, so author line ↔ resolved line ↔
   * reported line) and reported as authored: span and dated overrides applied, price
   * growth accrued.
   *
   * NOT rationed by the waterfall in a tight month — the simulator never skips spending,
   * an uncovered obligation cascades onto credit — so a line reported below its amount
   * would describe money that was in fact spent. Empty on the scalar path.
   */
  readonly lineMonthlyCents: Readonly<Record<string, Cents>>;
  /**
   * **Everything this month cost, itemized** — budget lines, the health line,
   * event-created expenses, and each liability's scheduled payment.
   *
   * `lineMonthlyCents` is its budget-line slice and `expensesCents` /
   * `liabilityPaymentsCents` its rollups, all derived from these items, so none can
   * drift.
   */
  readonly spendingItems: readonly SpendingItem[];
  /**
   * Σ `spendingItems`, and exactly `expensesCents + liabilityPaymentsCents` (pinned by
   * an engine invariant test).
   */
  readonly totalSpendingCents: Cents;
}

/**
 * The display/grouping axis, NOT the tax axis. Usually the source's own {@link
 * TaxCategory}, plus two members carrying provenance a tax category cannot express:
 *   - `"savingsDrawdown"` — spending down the cash buffer; not taxable income, so it has
 *     no tax category of its own.
 *   - `"savingsInterest"` — IS taxable (it buckets as `ordinaryIncome`) but reported
 *     under a distinct provenance so the UI can group it without parsing source ids.
 */
export type IncomeSourceCategory = TaxCategory | "savingsDrawdown" | "savingsInterest";

/**
 * `sourceId` is a stable machine key (a job's id, an account's id, `benefit:<person>`,
 * the fixed savings-drawdown id) so a chart can keep a band's identity across months;
 * `label` is its human name.
 */
export interface ProjectionIncomeSource {
  readonly sourceId: string;
  readonly label: string;
  readonly category: IncomeSourceCategory;
  /**
   * Which member this source pays; labels name the kind of income, not the earner, so
   * two people's benefits are otherwise indistinguishable. Absent on household-level
   * sources (the savings drawdown).
   */
  readonly ownerId?: string;
  /**
   * **Realized cash this source paid the household**, pre-tax and pre-deferral.
   * Unrealized appreciation books no source at all, so a brokerage's paper gain never
   * inflates cash flow.
   */
  readonly cashInflowCents: Cents;
  /**
   * `cashInflowCents` minus this source's pre-tax deferral and the tax it bore — the
   * single source of truth for take-home. Re-deriving it in the app silently drifted from
   * the sim (it dropped savings-interest tax, credited outside the waterfall). SIGNED and
   * unclamped: a source whose deductions exceed its inflow reports a genuinely negative
   * net; clamp at render if a stacked band needs nonnegative. Σ across a month's sources
   * is the household's net cash flow.
   */
  readonly netCashFlowCents: Cents;
}

export interface ProjectionSeries {
  readonly months: readonly ProjectionMonth[];
}

/**
 * A person as the *simulator* consumes it — narrower than the authoring {@link
 * import("../person").Person} (which carries jobs + `retirementTargetAge`). {@link
 * import("../compilePerson")} does the compiling.
 */
export interface SimPerson {
  readonly id: string;
  readonly name: string;
  /**
   * Present → the simulator accumulates lifetime earnings and, at {@link
   * benefitClaimingAge}, begins a derived government retirement benefit stream. Absent →
   * no benefit is modelled.
   */
  readonly birthYear?: number;
  /**
   * Pinned (62–70) — a decision variable, never searched by the retirement solver.
   * Defaults to 67 (full retirement age) when {@link birthYear} is set; ignored without
   * one.
   */
  readonly benefitClaimingAge?: number;
  /**
   * Pre-"now" covered earnings by calendar year — the one historical financial input, so
   * a mid-career person has a benefit basis before the projection accrues its own.
   */
  readonly priorEarningsCents?: Readonly<Record<number, Cents>>;
}

export interface SimOwnedSeries {
  readonly series: SimCashFlowSeries;
  readonly ownerId: string;
  /**
   * "Income", "Expenses", "Healthcare", or a budget line's label. Diagnostic only;
   * without it a report can only number series positionally.
   */
  readonly label?: string;
  /**
   * Used as the `sourceId` of this stream's reported income flow. Absent → the flow view
   * keys the source by owner.
   */
  readonly sourceId?: string;
  /**
   * Presence makes the source eligible for pre-tax deferral in waterfall step 1; absence
   * means it enters post-deferral. Meaningful on income series only.
   */
  readonly planDescriptor?: PlanDescriptor;
  /**
   * The authoring id of the {@link import("../budgetLine").BudgetLine} an EXPENSE series
   * was compiled from; a scalar/health series carries none. It keys {@link
   * ProjectionMonthFlows.lineMonthlyCents} and nothing else reads it. It carries no
   * priority: a tight month is absorbed by savings and credit, not by starving
   * low-priority lines.
   */
  readonly lineId?: string;
  /**
   * Which authoring model an EXPENSE series came from, how to categorize it, and whether
   * it is editable as a line. Read only by {@link
   * import("./spendingItems").buildSpendingItems}. Absent on income series.
   */
  readonly spendingSource?: SpendingSource;
}

/**
 * An appreciating asset stock. Value opens at `openingValueCents` at `startMonth`,
 * compounds monthly at `preciseMonthlyRate(appreciationAnnualRate)` (0 for a
 * flat/`fixed` property), contributes to net worth through `endMonth` inclusive (a sale
 * month), then drops to 0. Growth mode resolves to an annual rate at the sim boundary.
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
   * Unset → COUPLED to {@link annualInflationRate}. Set it for a benefit indexed away
   * from general inflation.
   */
  readonly benefitColaRate?: number;
  readonly startYear?: number;
  readonly persons: readonly SimPerson[];
  /**
   * Every account a goal or the surplus destination targets must be listed here — a
   * deposit to an unknown account id would not count toward net worth.
   */
  readonly accounts: readonly SimAccount[];
  readonly incomeSeries: readonly SimOwnedSeries[];
  readonly expenseSeries: readonly SimOwnedSeries[];
  /**
   * Amortizing payments are computed from opening balance/rate/term; credit-card
   * minimums are recomputed each month from the current balance. With no credit cards
   * provided, a synthetic 22% APR card absorbs shortfalls.
   */
  readonly liabilities?: readonly SimLiability[];
  /**
   * Appreciating asset stocks feeding net worth. The associated mortgage is an ordinary
   * entry in `liabilities`.
   */
  readonly properties?: readonly SimProperty[];
  /**
   * Each `amountCents` drains from its `sourceIds` in order at `month`, taking as much as
   * each holds before moving on — the split is balance-dependent, so it resolves here
   * rather than at authoring time.
   */
  readonly fundingDraws?: readonly FundingDraw[];
  /**
   * Prioritized waterfall destinations. Shared goals draw from the household pool,
   * personal goals from their owner's leftover. Retirement is just the highest-priority
   * horizon goal.
   */
  readonly goals?: readonly SimGoal[];
  /**
   * Standing "put $X into this account each month" lines, funded from discretionary
   * alongside goals so a recurring contribution accumulates instead of idling. Expense
   * lines arrive precompiled in `expenseSeries`.
   */
  readonly contributionLines?: readonly BudgetLine[];
  /**
   * Lever 2: how partners split shared obligations. Defaults to `"proportional"` (to
   * take-home), which degrades gracefully under unequal or zero incomes.
   */
  readonly sharedScheme?: SharedContributionScheme;
  /**
   * Lever 4: where leftover cash lands once every goal is funded. Defaults to `{ kind:
   * "idle" }` — the first liquid account.
   */
  readonly surplusDestination?: SurplusDestination;
}
