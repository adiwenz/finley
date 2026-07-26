import type { Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";
import type { IncomeSourceCategory } from "./simulate.types";
import type { SimGoal } from "../goal";

/** The 401(k)-style plan a job carries (§5.5) — presence makes it deferral-eligible. */
export interface PlanDescriptor {
  /** Fraction of THIS job's gross deferred pre-tax (0..1) — the exposed % lever. */
  readonly deferralFraction: number;
  /** Person-owned account the deferral (and any match) funds (§5.5). */
  readonly fundAccountId: string;
  /**
   * Employer match as a fraction of the amount actually deferred (e.g. 0.5 = a
   * 50% match). Employer money — it never comes out of take-home and does NOT
   * share the employee-deferral cap (§5.4).
   */
  readonly employerMatchFraction?: number;
}

/** One income source's contribution to a single month (resolved from a series). */
export interface IncomeSourceMonth {
  readonly ownerId: string;
  /**
   * The cash this source injects INTO the allocation waterfall this month — what still
   * needs placing (covering obligations, funding goals, idling as surplus). For wages,
   * benefit, RMD, and account draws this is the whole payment; for an accrued-interest
   * booking it is 0, because the cash is already sitting in the account balance and
   * re-placing it would double-credit the account. Distinct from the household's realized
   * cash for reporting — see {@link cashInflowCents}.
   */
  readonly waterfallInflowCents: Cents;
  readonly taxCategory: TaxCategory;
  /**
   * Reporting provenance (issue #99), consumed ONLY by the diagnostic flow view
   * ({@link import("./reportFlows").buildFlows}), never by the waterfall's allocation
   * or tax math. `sourceId` is a stable machine key (a job's id, a draw's account id,
   * `benefit:<person>`) so per-source reporting can name *which* job or account a flow
   * came from instead of collapsing it into a tax bucket; `label` is its human name.
   * Absent → the flow view falls back to keying/naming the source by its tax category.
   */
  readonly sourceId?: string;
  readonly label?: string;
  /** Present → eligible for pre-tax deferral (§5.0 step 1). Absent → post-deferral. */
  readonly planDescriptor?: PlanDescriptor;
  /**
   * The taxable base this source contributes, when it is NOT the full gross. Two
   * uses, both #94:
   *  - a returned-basis fund withdrawal books only its **gain** here (< gross) — the
   *    whole gross is still paid out as take-home, only the taxable base shrinks;
   *  - an accrued-interest booking (savings, Commit 2) books its interest here with
   *    `waterfallInflowCents` 0 — the interest is taxed without re-injecting cash the balance
   *    already holds (so the waterfall allocates nothing for it), yet it still reports
   *    as real household cash via {@link cashInflowCents}.
   * Absent → the full gross is taxable (wages, benefit, RMD, pre-tax draws).
   */
  readonly taxableCents?: Cents;
  /**
   * The **realized cash this source pays into the household**, for the cash-flow report
   * ({@link import("./reportFlows").buildFlows}) — distinct from `waterfallInflowCents`, which is the
   * cash the ALLOCATION waterfall must place. They differ only for an accrued-interest
   * booking: its `waterfallInflowCents` is 0 (the balance already holds the cash — allocating it
   * again would double-credit the account) while its `cashInflowCents` is the interest,
   * because it genuinely is money the household received. Absent → defaults to `waterfallInflowCents`
   * (wages, benefit, RMD, and returned-basis draws all pay their whole gross as cash).
   */
  readonly cashInflowCents?: Cents;
  /**
   * Explicit reporting provenance that OVERRIDES the tax-category axis for display/grouping
   * ({@link import("./simulate.types").ProjectionIncomeSource.category}), when the two
   * differ. Savings-account interest sets this to `"savingsInterest"` so the UI can group it
   * as "Savings interest" without parsing source ids, even though it is taxed as
   * `ordinaryIncome` (which is where it still buckets in the taxable rollup). Absent → the
   * source reports under its {@link taxCategory}.
   */
  readonly reportCategory?: IncomeSourceCategory;
}

/** Lever 2: how much each person contributes to shared obligations (§5.0 step 3). */
export type SharedContributionScheme = "proportional" | "even";

/** Lever 4: where leftover cash lands once every goal is funded (§5.0 RESOLVED). */
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
   * Standing account-contribution budget lines resolved for this month (§12/§15) —
   * "put $X into this account", already in waterfall priority order and post-tax. A
   * COMMITTED outflow: the full amount always lands in the account (funded from the
   * discretionary pool after dated goal paces, before `asap` goals), and the part the pool
   * cannot cover is borrowed — a shortfall that the §5.1 cascade meets from savings then
   * credit, so an unaffordable contribution makes the plan unfinanceable like unaffordable
   * spending (it is NOT silently shrunk to fit). Absent → none.
   */
  readonly contributions?: readonly { readonly accountId: string; readonly monthlyCents: Cents }[];
  /**
   * The absolute month being allocated (0 = "now"). Sets each dated goal's
   * `monthsRemaining = targetDate − nowMonth` for the #26 sinking-fund pace. Absent
   * → 0.
   */
  readonly nowMonth?: number;
  /**
   * A goal fund account's monthly growth rate, for the growth-aware #26 pace. Absent
   * (or returning 0) → a flat even spread over the months remaining.
   */
  readonly goalFundMonthlyRate?: (accountId: string) => number;
  /** Current (beginning-of-step) balance of any account — goal need is target − this. */
  readonly accountBalanceCents: (accountId: string) => Cents;
  /** The default liquid account — the `idle` surplus destination. Null if none. */
  readonly liquidAccountId: string | null;
  /**
   * §5.3 seam 1: per-{@link TaxCategory} taxable amounts in → tax owed out. Called
   * once per person with that person's full taxable-by-category map, so the
   * jurisdiction (not the waterfall) decides how each category is taxed.
   */
  readonly computeTaxCents: (taxableByCategory: Partial<Record<TaxCategory, Cents>>) => Cents;
  /**
   * §5.3 seam (issue #110): the per-{@link TaxCategory} breakdown of the SAME tax
   * `computeTaxCents` returns. REQUIRED — every jurisdiction owns its attribution; a
   * zero-tax jurisdiction returns `{}`, a tax-charging one returns a map whose Σ per person
   * equals that person's `computeTaxCents`. Called once per person and the per-person maps
   * are summed into one household map, so the household breakdown sums to the household
   * `taxCents` (enforced at runtime — see {@link assertTaxAttributionReconciles}). Additive
   * only: take-home still uses the scalar total.
   */
  readonly computeTaxByCategoryCents: (
    taxableByCategory: Partial<Record<TaxCategory, Cents>>,
  ) => Partial<Record<TaxCategory, Cents>>;
  /**
   * §5.4 seam: a person's REMAINING annual deferral room this month (limit minus
   * what they have already deferred this year). `Infinity` = uncapped.
   */
  readonly remainingDeferralRoomCents: (personId: string) => number;
}

export interface WaterfallResult {
  readonly taxCents: Cents;
  /**
   * §5.3 (issue #110): this month's household tax broken out per {@link TaxCategory} —
   * the tax analog of `incomeByCategoryCents`, summed across every person. Always present
   * (the breakdown seam is required); `{}` in a zero-tax month, otherwise Σ === `taxCents`.
   */
  readonly taxByCategoryCents: Partial<Record<TaxCategory, Cents>>;
  /**
   * §5.3 (issue #110 follow-up): this month's tax broken out per income SOURCE — the
   * finer sibling of {@link taxByCategoryCents}, keyed by each source's reporting id
   * (`sourceId`, falling back to its tax category) so a chart can name *which job* bore
   * the tax instead of collapsing every paycheck into one `wages` band. Each category's
   * tax is apportioned across the sources in that category by their taxable weight, PER
   * PERSON (so two earners in different brackets never cross-subsidise), then summed to
   * the household. Always present; `{}` in a zero-tax month, otherwise Σ === `taxCents`
   * (enforced — see {@link assertTaxAttributionReconciles}) and Σ within a category ===
   * that category's `taxByCategoryCents`. Attribution is proportional (average-rate), not
   * marginal — the caveat disclosed as `taxAttributionProportional`.
   */
  readonly taxBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * This month's pre-tax deferral broken out per income SOURCE (same keying as
   * {@link taxBySourceCents}), summed across the household. Lets a consumer compute a
   * source's take-home (gross − deferral − tax) — e.g. an income chart that compares
   * spendable income against the month's obligations. Always present (deferral is
   * jurisdiction-independent); a source that defers nothing is simply absent. Σ ===
   * Σ `deferredByPersonCents`.
   */
  readonly deferralBySourceCents: Readonly<Record<string, Cents>>;
  /** Amount actually deferred per person — the caller updates its annual accumulator. */
  readonly deferredByPersonCents: ReadonlyMap<string, Cents>;
  /** Net deposit to add to each account this month (deferrals, match, goals, surplus). */
  readonly accountDepositsCents: ReadonlyMap<string, Cents>;
  /** Household cash shortfall to route through the §5.1 cascade (0 if none). */
  readonly shortfallCents: Cents;
}
