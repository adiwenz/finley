/**
 * Public type contract of the household simulator. The mutable per-run `SimState` stays
 * private to `./simulate`, which re-exports this file.
 */

import type { Cents } from "../money/money";
import type { SimAccount } from "../plan/simAccount";
import type { SimLiability, PaymentStatus, LoanStatus } from "../liability/liability";
import type { SimCashFlowSeries, TaxCategory } from "../money/cashFlowSeries";
import type { SimGoal } from "../goal/goal";
import type { BudgetLine } from "../budget/budgetLine";
import type { FinancialObligation, ObligationSource } from "./financialObligation";
import type { ResolvedFunding } from "./resolvedFunding";
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
 * What the engine can honestly say about the month a plan fails, carried on that month alone
 * ({@link ProjectionMonth.insolvencyReport}).
 *
 * Both figures are REPORTING-ONLY. Nothing here is a balance, nothing is charged to any card or
 * liability, and no later month is derived from it — the simulation continues from the real,
 * unpaid state, exactly as it would if this report did not exist.
 */
export interface InsolvencyReport {
  /**
   * The deficit nothing could absorb: what the cascade DROPPED rather than charged, once savings
   * were spent and every card had reached its limit. It appears in no balance and in no
   * liability, which is why it has to be stated rather than read off the balance sheet.
   */
  readonly uncoveredCents: Cents;
  /**
   * Illustrative net worth if the uncovered obligations were honoured through equivalent
   * additional borrowing — the month's balance-sheet total with the shortfall charged back to
   * it. This is what makes the contaminated total safe to publish: on its own that total flatters
   * the household by the spending it silently skipped, and subtracting the shortfall is what
   * puts the cost back.
   *
   * Not carried into later months, and not a net worth: {@link ProjectionMonth.netWorthNominalCents}
   * stays `null` from this month on, and this figure never substitutes for it.
   *
   * First-order: where an unfunded obligation was debt PRINCIPAL, honouring it by borrowing
   * would have swapped one liability for another rather than adding one, so this overstates the
   * cost by that share. The error is bounded by a single month's unfunded principal and always
   * conservative.
   */
  readonly debtFundedNetWorthNominalCents: Cents;
}

/**
 * The engine's public output and the chart's data contract: one entry per simulated
 * month, starting at "now" (month 0).
 *
 * Net worth is `null` from the first insolvent month ONWARD — the insolvent month included.
 * Once the shortfall cascade drops unfundable spending the balance sheet is fiction, and that
 * is true of the month the drop happens, not just the ones after it: a month that charged only
 * the sliver of spending credit could absorb keeps its appreciation and amortization while
 * losing most of its cost, so its net worth reads HIGHER than the last solvent month's. The
 * last non-null figure is therefore the last fully funded month. `null` means "insolvent from
 * here", NOT zero (`null >= 0` is `true` in JS); the size of the shortfall that ended the plan
 * is {@link ProjectionMonth.uncoveredCents}.
 */
export interface ProjectionMonth {
  readonly month: number;
  readonly netWorthNominalCents: Cents | null;
  readonly netWorthRealCents: Cents | null;
  /**
   * Present on the FIRST insolvent month and no other — the one month where "how far short did
   * this plan fall, and what would that have cost?" has a defined answer. Absent everywhere
   * else, including on later insolvent months, which have no such answer to give.
   */
  readonly insolvencyReport?: InsolvencyReport;
  readonly accountBalancesCents: Readonly<Record<string, Cents>>;
  /**
   * Post-tax principal, keyed like `accountBalancesCents`; untaxed gain is
   * `balance − basis`. The §4.5 down-payment gate prices a liquidation's capital-gains
   * tax from it.
   */
  readonly accountBasisCents: Readonly<Record<string, Cents>>;
  /** Positive = owed. */
  readonly liabilityBalancesCents: Readonly<Record<string, Cents>>;
  /** The partial-payment / forbearance seam. Empty on {@link ProjectionSeries.opening}. */
  readonly liabilityPaymentRecords: Readonly<Record<string, LiabilityPaymentRecord>>;
  /**
   * From purchase month until sold. Equity is this value minus the matching
   * `liabilityBalancesCents` entry.
   */
  readonly propertyValuesCents: Readonly<Record<string, Cents>>;
  /** True where the shortfall cascade exhausted all available credit. */
  readonly isInsolvent: boolean;
  /**
   * The deficit left over once savings and every card were exhausted — spending the model
   * DROPPED rather than charged to anything, so it appears in no balance and in no liability.
   * Exactly `isInsolvent ? > 0 : 0`. This is the only place the size of the failure is stated;
   * without it a consumer would have to read it off a card that, by definition, could not
   * absorb it. Cards stay at their real limits — none is overdrawn to make this visible.
   */
  readonly uncoveredCents: Cents;
  /** Present on every processed month; absent only on {@link ProjectionSeries.opening}. */
  readonly flows?: ProjectionMonthFlows;
}

/**
 * Per-month cash *flows*, the companion to {@link ProjectionMonth}'s stock balances.
 * Built from the same sources and obligations the waterfall consumed, so it cannot
 * disagree with the sim.
 */
export interface ProjectionMonthFlows {
  /**
   * Gross income bucketed by {@link TaxCategory} — the rollup of {@link incomeSources}.
   * A category is a tax classification, not a source: two jobs share one `wages` bucket.
   */
  readonly incomeByCategoryCents: Readonly<Record<string, Cents>>;
  /**
   * The liquid-buffer drawdown gets its own `savingsDrawdown` source: spending charged
   * against cash creates no taxable withdrawal, so "living off savings" would otherwise
   * read as zero income. Not taxable, so absent from `incomeByCategoryCents` and
   * `totalIncomeCents`.
   *
   * Savings interest DOES appear in the rollups: its allocation gross is 0, but it is real
   * taxable cash, reported via {@link ProjectionIncomeSource.cashInflowCents}.
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
   * Employee payroll tax (US: FICA) charged this month, summed across persons — the
   * reconciled annual liability accrued this month, not per-employer paycheck withholding. A
   * SEPARATE line from {@link taxCents} — its base is pre-deferral gross and it applies to
   * earned income only — already deducted from take-home, so after-tax gross is
   * `totalIncomeCents − taxCents − payrollTaxCents`. 0 when the jurisdiction charges none.
   */
  readonly payrollTaxCents: Cents;
  /**
   * The jurisdiction owns the split — US tax is not linearly separable by category — so
   * the engine carries it rather than synthesizing one. Always present: `{}` in a zero-tax
   * month, otherwise Σ equals `taxCents`.
   */
  readonly taxByCategoryCents: Readonly<Record<string, Cents>>;
  /**
   * Keyed by each source's reporting id (`sourceId` from {@link incomeSources}, falling
   * back to its tax category). Apportioned per person by taxable weight so earners in
   * different brackets never cross-subsidise, at the average rather than marginal rate
   * (disclosed as `taxAttributionProportional`). Always present: `{}` in a zero-tax month,
   * otherwise Σ === `taxCents` (runtime-enforced) and Σ within a category === that
   * category's `taxByCategoryCents` entry.
   */
  readonly taxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * Keyed like {@link taxBySourceCents}; a source that deferred nothing is absent, as is
   * the whole map when none did. Already folded into {@link
   * ProjectionIncomeSource.netCashFlowCents}; this is only for a per-source view.
   */
  readonly deferralBySourceCents?: Readonly<Record<string, Cents>>;
  /**
   * Payroll tax (FICA) per income SOURCE, mirroring {@link taxBySourceCents} but for {@link
   * payrollTaxCents} — the share of the person-level payroll-tax charge attributed to this
   * income source, distinguishable from a partner's or another job's. Already folded into
   * {@link ProjectionIncomeSource.netCashFlowCents}. `{}` in a month with no payroll tax,
   * otherwise Σ === `payrollTaxCents`.
   */
  readonly payrollTaxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * The month's taxable base, per owner by tax category, **including gains this month's
   * funding draws already realized** — what a FURTHER draw would be taxed on top of. The
   * §4.5 affordability gate prices a would-be sale over the same base the simulation will;
   * the pre-funding base under-prices the second of two same-month draws.
   *
   * `{}` for an owner with no taxable income. Optional: the simulator attaches it after
   * `buildFlows`, so flows synthesised without it are still valid.
   */
  readonly taxableByOwnerAfterFundingCents?: Readonly<
    Readonly<Record<string, Readonly<Record<string, Cents>>>>
  >;
  /**
   * Per-account balances (and their matching {@link accountBasisAfterFundingCents}) at the
   * post-explicit-draw, pre-decumulation seam — the state a newly authored money-out event,
   * last in ledger order, actually resolves against. Since the reorder, explicit draws run
   * before decumulation, so end-of-month `accountBalancesCents` is TOO LATE for the gate:
   * decumulation and this month's compounding have both moved it. Reading these instead is
   * what keeps the gate's shortfall equal to the sim's — a candidate whose source
   * decumulation would later drain still sees the full balance it draws from first.
   *
   * Keyed like `accountBalancesCents`. Optional: attached after `buildFlows`, absent on the
   * `opening` snapshot (where the gate already reads pre-decumulation balances directly).
   */
  readonly accountBalancesAfterFundingCents?: Readonly<Record<string, Cents>>;
  /** Basis companion to {@link accountBalancesAfterFundingCents}; untaxed gain is `balance − basis`. */
  readonly accountBasisAfterFundingCents?: Readonly<Record<string, Cents>>;
  /** Authored budget lines + health + any event-created expenses. */
  readonly expensesCents: Cents;
  /** Mortgages, loans, card minimums. */
  readonly liabilityPaymentsCents: Cents;
  /**
   * Keyed by the line's obligation id (`line:<id>`, minted by {@link
   * import("./financialObligation").obligationBudgetLineId}) and reported as authored: span
   * and dated overrides applied, price growth accrued.
   *
   * NOT rationed by the waterfall in a tight month — the simulator never skips spending,
   * an uncovered obligation cascades onto credit — so a line reported below its amount
   * would describe money that was in fact spent. Empty when no expense lines are authored.
   */
  readonly lineMonthlyCents: Readonly<Record<string, Cents>>;
  /**
   * Everything this month must fund — budget lines, the health line, event-created expenses,
   * and each liability's scheduled payment — the same {@link FinancialObligation} list that
   * drove the waterfall, ordered for reporting by priority. `lineMonthlyCents` is its
   * budget-line slice and `expensesCents` / `liabilityPaymentsCents` its rollups, all derived
   * from this list, so none can drift.
   */
  readonly obligations: readonly FinancialObligation[];
  /**
   * Σ `obligations`, and exactly `expensesCents + liabilityPaymentsCents` (pinned by an engine
   * invariant test).
   */
  readonly totalObligationsCents: Cents;
  /**
   * Per-line funding attribution: which sources paid each obligation this month and how much, in
   * the order the cascade consumed them. A DERIVED interpretation the priority order imposes on a
   * fungible pool (see CONTEXT.md, "Funding attribution"), not a ledger fact — surfaced, never
   * presented as authored. One record per obligation, automatic or explicit — an explicit draw's
   * sources are the accounts it named, never income — with Σ `fundedCents` reconciling with the
   * month's actual account and liability movements.
   */
  readonly resolvedFunding: readonly ResolvedFunding[];
}

/**
 * The display/grouping axis, NOT the tax axis. Usually the source's own {@link
 * TaxCategory}, plus two members carrying provenance a tax category cannot express:
 *   - `"savingsDrawdown"` — spending down the cash buffer; not taxable income.
 *   - `"savingsInterest"` — IS taxable (buckets as `ordinaryIncome`) but reported under a
 *     distinct provenance so the UI can group it without parsing source ids.
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
   * Realized cash this source paid the household, pre-tax and pre-deferral. Unrealized
   * appreciation books no source at all, so a brokerage's paper gain never inflates cash
   * flow.
   */
  readonly cashInflowCents: Cents;
  /**
   * `cashInflowCents` minus this source's pre-tax deferral and the tax it bore — the
   * single source of truth for take-home; re-deriving it in the app dropped
   * savings-interest tax, credited outside the waterfall. SIGNED and unclamped: deductions
   * exceeding inflow report a negative net; clamp at render if a stacked band needs
   * nonnegative. Σ across a month's sources is the household's net cash flow.
   */
  readonly netCashFlowCents: Cents;
}

/**
 * The obligation that stopped a {@link ProjectionSeries}, and the funding gap that stopped it.
 * Presentation-only: nothing here is a balance or a later month's input — it exists so the chart
 * can name the failed purchase and the size of its shortfall. All figures are net of the
 * capital-gains tax liquidating the named sources would owe, exactly as the sim would have priced
 * it.
 */
export interface BlockedObligation {
  /** The blocking obligation's {@link FinancialObligation.id}. */
  readonly obligationId: string;
  /** The authoring event that spawned it (a home purchase), for naming and artifact suppression. */
  readonly sourceEventId?: string;
  readonly label: string;
  /** The month it was scheduled for — equals {@link ProjectionSeries.blockedAtMonth}. */
  readonly month: number;
  readonly requiredCents: Cents;
  /** What the named sources could actually deliver, net of tax. */
  readonly availableCents: Cents;
  /** `requiredCents − availableCents`, always > 0. */
  readonly shortfallCents: Cents;
  /**
   * Where a presentation-only blocked marker sits: the blocked month's genuine net worth dropped
   * by the shortfall, so the missing capital reads as a visible gap. NOT a net worth and never a
   * simulation input — the household did NOT lose this money; the marker communicates the size of
   * the funding failure, nothing more. `null` when the blocked month has no stated net worth (it
   * was also insolvent), where the offset has no anchor. Computed by the engine, like the
   * insolvency counterfactual, so the app draws it without making the financial claim.
   */
  readonly markerNetWorthCents: Cents | null;
}

export interface ProjectionSeries {
  /**
   * The household as it stands NOW, before any flow runs — no income, compounding, or draws
   * applied. Split out of {@link months} so every entry there is a real, processed month:
   * this is the point the net-worth chart draws as "today", one month before {@link
   * months}[0]'s end-of-month-0.
   */
  readonly opening: ProjectionMonth;
  /**
   * Every entry is a fully processed, end-of-month snapshot with `months[i].month === i`;
   * `months[0..11]` all belong to calendar year 0, so year 0 accrues a full 12 flow-months.
   * TRUNCATED when {@link status} is `"blocked"`: the last entry is the blocked month and
   * nothing after it is simulated.
   */
  readonly months: readonly ProjectionMonth[];
  /**
   * A statement about the SIMULATION, not the plan's health. `"ran-to-horizon"` does NOT mean
   * healthy — an insolvent-but-unblocked plan reports it too, since insolvency keeps simulating
   * (net worth nulled). `"blocked"` means an explicitly-funded obligation could not be funded, so
   * the projection stopped rather than mint an asset it could not pay for.
   */
  readonly status: "ran-to-horizon" | "blocked";
  /**
   * The index of the last emitted month (`months.length - 1`). Equals {@link blockedAtMonth} when
   * blocked — the blocked month IS emitted — so a consumer never has to special-case truncation.
   */
  readonly simulatedThroughMonth: number;
  /** Present iff `status === "blocked"`: the month the blocking obligation was scheduled for. */
  readonly blockedAtMonth?: number;
  /** Present iff `status === "blocked"`: the obligation that stopped the projection. */
  readonly blockingObligation?: BlockedObligation;
  /**
   * Present iff `status === "blocked"`: every authoring event whose funding draw was omitted at the
   * blocked month — {@link blockingObligation}'s `sourceEventId` FIRST, then each later same-month
   * event whose draw was skipped because resolution stopped. Each one's artifacts (a property, its
   * mortgage) were suppressed, since none of their money moved.
   *
   * Distinct from {@link blockingObligation}, which names the single obligation that fell short and
   * states its gap. A skipped event was never priced against its sources, so nothing here claims it
   * was unaffordable — only that it did not happen. An array, not a `Set`, to stay serializable
   * across the engine's output seam like every other field here.
   */
  readonly omittedSourceEventIds?: readonly string[];
}

/**
 * A person as the *simulator* consumes it — narrower than the authoring {@link
 * import("../plan/person").Person} (which carries the jobs). {@link
 * import("../compile/compilePerson")} does the compiling.
 */
export interface SimPerson {
  readonly id: string;
  readonly name: string;
  /**
   * Present → the simulator accumulates lifetime earnings and, at {@link
   * benefitClaimingAge}, begins a derived government retirement benefit stream. Absent →
   * no benefit.
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
  /**
   * The months this person's money belongs to THIS household — `startMonth` inclusive,
   * `endMonthExclusive` the separation month (or `Infinity` while they are still a member).
   * Absent means unbounded, which is what a person with no membership record (every
   * single-earner plan) gets.
   *
   * Carried across the sim boundary because a wage is not the only thing membership governs.
   * The income series were already clipped to this window upstream, so the simulator never had
   * to ask — but a government benefit is derived INSIDE the sim from the earnings record, and
   * so arrives with no window attached. Without this it was paid to the household forever: a
   * partner who separated at 50 still contributed their Social Security from 67 to the end of
   * the projection, inflating net worth and pulling the solved retirement age earlier.
   */
  readonly membership?: {
    readonly startMonth: number;
    readonly endMonthExclusive: number;
  };
}

/**
 * Is this person's money the household's in `month`? Absent membership is unbounded — the
 * single-earner case, and every fixture that states a roster without a timeline.
 */
export function isHouseholdMemberAt(person: SimPerson, month: number): boolean {
  // Not named `window` — the purity guard reads that as the browser global, and it is right to.
  const bounds = person.membership;
  if (bounds === undefined) return true;
  return month >= bounds.startMonth && month < bounds.endMonthExclusive;
}

export interface SimOwnedSeries {
  readonly series: SimCashFlowSeries;
  readonly ownerId: string;
  /**
   * "Income", "Expenses", "Healthcare", or a budget line's label. Diagnostic only.
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
   * The authoring id of the {@link import("../budget/budgetLine").BudgetLine} an EXPENSE series
   * was compiled from; a health or event series carries none. Keys {@link
   * ProjectionMonthFlows.lineMonthlyCents} and nothing else. Carries no priority: a tight
   * month is absorbed by savings and credit, not by starving low-priority lines.
   */
  readonly lineId?: string;
  /**
   * Which authoring model an EXPENSE series came from, how to categorize it, and whether
   * it is editable as a line. Read only by {@link
   * import("./financialObligation").buildObligations}. Absent on income series.
   */
  readonly obligationSource?: ObligationSource;
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
  /**
   * The authoring event that acquired it — matched against a blocked obligation's
   * {@link BlockedObligation.sourceEventId} to suppress origination of a purchase that could not
   * be funded. Absent on properties built outside the event pipeline (raw engine tests).
   */
  readonly causedByEventId?: string;
  /**
   * The financing mortgage this property secures, if any — suppressed alongside the property when
   * the purchase blocks, so a stranded home leaves neither a phantom asset nor a phantom loan.
   */
  readonly mortgageLiabilityId?: string | null;
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
   * Explicitly-funded obligations: each drains its ordered `orderedAccountIds` for `amountCents`
   * at `month`, taking as much as each holds before moving on — the split is balance-dependent,
   * so it resolves here rather than at authoring time.
   */
  readonly fundingDraws?: readonly FinancialObligation[];
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
