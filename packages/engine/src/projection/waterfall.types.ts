import type { Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";
import type { IncomeSourceCategory } from "./simulate.types";
import type { SimGoal } from "../goal";

/** The 401(k)-style plan a job carries — presence makes it deferral-eligible. */
export interface PlanDescriptor {
  /** Fraction of THIS job's gross deferred pre-tax (0..1). */
  readonly deferralFraction: number;
  /** Person-owned account the deferral (and any match) funds. */
  readonly fundAccountId: string;
  /**
   * Fraction of the amount actually deferred (0.5 = a 50% match). Employer money: never out
   * of take-home, and does NOT share the employee-deferral cap.
   */
  readonly employerMatchFraction?: number;
}

/** One income source's contribution to a single month (resolved from a series). */
export interface IncomeSourceMonth {
  readonly ownerId: string;
  /**
   * Cash this source injects INTO the allocation waterfall. The whole payment for wages,
   * benefit, RMD, and draws; 0 for an accrued-interest booking, whose cash already sits in
   * the balance (re-placing it would double-credit the account). Distinct from the realized
   * cash reported — see {@link cashInflowCents}.
   */
  readonly waterfallInflowCents: Cents;
  readonly taxCategory: TaxCategory;
  /**
   * Reporting provenance: it never affects allocation or how much tax is owed, only how
   * results are keyed and named. `sourceId` is a stable machine key (job id, draw's account
   * id, `benefit:<person>`) naming *which* job or account a flow came from — it keys
   * {@link WaterfallResult.taxBySourceCents} and the flow view
   * ({@link import("./reportFlows").buildFlows}); `label` is its human name. Absent →
   * keyed/named by tax category.
   */
  readonly sourceId?: string;
  readonly label?: string;
  /** Present → eligible for pre-tax deferral (step 1). Absent → post-deferral. */
  readonly planDescriptor?: PlanDescriptor;
  /**
   * The taxable base when it is NOT the full gross: a returned-basis fund withdrawal books
   * only its **gain** (the whole gross still pays out as take-home), and an accrued-interest
   * booking books its interest here with `waterfallInflowCents` 0. Absent → the full gross
   * is taxable (wages, benefit, RMD, pre-tax draws).
   */
  readonly taxableCents?: Cents;
  /**
   * The realized cash this source pays the household, for the cash-flow report. Differs from
   * `waterfallInflowCents` only for an accrued-interest booking, where this is the interest
   * — money genuinely received — and the waterfall inflow is 0. Absent → defaults to
   * `waterfallInflowCents`.
   */
  readonly cashInflowCents?: Cents;
  /**
   * OVERRIDES the tax-category axis for display/grouping
   * ({@link import("./simulate.types").ProjectionIncomeSource.category}). Savings interest
   * sets `"savingsInterest"` so the UI groups it without parsing source ids, even though it
   * is taxed as `ordinaryIncome` (where it still buckets in the taxable rollup). Absent →
   * reports under its {@link taxCategory}.
   */
  readonly reportCategory?: IncomeSourceCategory;
}

/** Lever 2: how much each person contributes to shared obligations (step 3). */
export type SharedContributionScheme = "proportional" | "even";

/** Lever 4: where leftover cash lands once every goal is funded. */
export type SurplusDestination =
  | { readonly kind: "idle" }
  | { readonly kind: "swept"; readonly accountId: string };

export interface WaterfallInput {
  readonly personIds: readonly string[];
  readonly incomeSources: readonly IncomeSourceMonth[];
  /** Shared obligations this month: expenses + scheduled liability payments. */
  readonly sharedObligationCents: Cents;
  readonly sharedScheme: SharedContributionScheme;
  readonly surplusDestination: SurplusDestination;
  readonly goals: readonly SimGoal[];
  /**
   * Standing account-contribution lines for this month, already in waterfall priority order
   * and post-tax. A COMMITTED outflow: the full amount always lands (from the discretionary
   * pool after dated goal paces, before `asap` goals), and whatever the pool cannot cover is
   * borrowed — so an unaffordable contribution makes the plan unfinanceable rather than
   * being silently shrunk to fit. Absent → none.
   */
  readonly contributions?: readonly { readonly accountId: string; readonly monthlyCents: Cents }[];
  /**
   * The absolute month being allocated (0 = "now"). Sets each dated goal's
   * `monthsRemaining = targetDate − nowMonth` for the sinking-fund pace. Absent → 0.
   */
  readonly nowMonth?: number;
  /**
   * A goal fund account's monthly growth rate, for the growth-aware pace. Absent (or
   * returning 0) → a flat even spread over the months remaining.
   */
  readonly goalFundMonthlyRate?: (accountId: string) => number;
  /** Current (beginning-of-step) balance of any account — goal need is target − this. */
  readonly accountBalanceCents: (accountId: string) => Cents;
  /** The default liquid account — the `idle` surplus destination. Null if none. */
  readonly liquidAccountId: string | null;
  /**
   * seam 1: per-{@link TaxCategory} taxable amounts in → tax owed out. Called once per
   * person with that person's full map, so the jurisdiction (not the waterfall) decides
   * how each category is taxed.
   */
  readonly computeTaxCents: (taxableByCategory: Partial<Record<TaxCategory, Cents>>) => Cents;
  /**
   * The per-{@link TaxCategory} breakdown of the SAME tax `computeTaxCents` returns.
   * REQUIRED — every jurisdiction owns its attribution; a zero-tax one returns `{}`,
   * otherwise Σ per person MUST equal that person's `computeTaxCents` (runtime-enforced —
   * see {@link assertTaxAttributionReconciles}). Additive only: take-home still uses the
   * scalar total.
   */
  readonly computeTaxByCategoryCents: (
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
  ) => Partial<Record<TaxCategory, Cents>>;
  /**
   * A person's REMAINING annual deferral room this month (limit minus what they have
   * already deferred this year). `Infinity` = uncapped.
   */
  readonly remainingDeferralRoomCents: (personId: string) => number;
}

export interface WaterfallResult {
  readonly taxCents: Cents;
  /**
   * Household tax per {@link TaxCategory}, summed across persons. `{}` in a zero-tax month,
   * otherwise Σ === `taxCents`.
   */
  readonly taxByCategoryCents: Partial<Record<TaxCategory, Cents>>;
  /**
   * Tax per income SOURCE, keyed by each source's reporting id (`sourceId`, falling back to
   * its tax category). Each category's tax is apportioned across its sources by taxable
   * weight, PER PERSON (so two earners in different brackets never cross-subsidise), then
   * summed to the household. `{}` in a zero-tax month, otherwise Σ === `taxCents` (enforced
   * — see {@link assertTaxAttributionReconciles}) and Σ within a category === that
   * category's `taxByCategoryCents`. Attribution is proportional (average-rate), not
   * marginal — disclosed as `taxAttributionProportional`.
   */
  readonly taxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * Pre-tax deferral per income SOURCE (keyed like {@link taxBySourceCents}), summed across
   * the household, so a consumer can compute a source's take-home (gross − deferral − tax).
   * A source that defers nothing is absent. Σ === Σ `deferredByPersonCents`.
   */
  readonly deferralBySourceCents: Readonly<Record<string, Cents>>;
  /** Amount actually deferred per person — the caller updates its annual accumulator. */
  readonly deferredByPersonCents: ReadonlyMap<string, Cents>;
  /** Net deposit to add to each account this month (deferrals, match, goals, surplus). */
  readonly accountDepositsCents: ReadonlyMap<string, Cents>;
  /** Household cash shortfall to route through the cascade (0 if none). */
  readonly shortfallCents: Cents;
}
