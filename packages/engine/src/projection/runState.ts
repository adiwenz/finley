import type { Cents } from "../money/money";
import type { SimAccount } from "../plan/simAccount";
import { seedEarnings, type EarningsAccumulator } from "../job/earningsRecord";
import {
  RevolvingCard,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CREDIT_CARD_APR,
  SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
  type SimLiability,
} from "../liability/liability";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { SourceTaxable, TaxableByCategory } from "./taxAttribution";
import type { BudgetLine } from "../budget/budgetLine";
import type { SimGoal } from "../goal/goal";
import type { SharedContributionScheme, SurplusDestination } from "./waterfall";
import type { HouseholdSimInput, SimPerson, SimProperty } from "./simulate.types";
import { PRE_NOW_MONTH, isPreExisting } from "./nowMarker";
import type { FinancialObligation } from "./financialObligation";

/**
 * The resolved, mutable state one `simulateHousehold` run threads through its per-month
 * step helpers. Engine-INTERNAL: exported so the step modules share the exact shape, but
 * kept OFF the public barrel (index.ts).
 */
export interface SimState {
  readonly accounts: readonly SimAccount[];
  /** First liquid account — receives net cash flow and absorbs the first shortfall. */
  readonly liquidAccount: SimAccount | null;
  /** User liabilities plus the synthetic shortfall card, if one was created. */
  readonly liabilities: readonly SimLiability[];
  /** Credit cards (incl. synthetic) sorted ascending by APR — shortfall cascade order. */
  readonly cascadeCards: readonly RevolvingCard[];
  readonly assetBalances: Map<string, Cents>;
  /**
   * Per-account post-tax principal. Rises with post-tax deposits, falls pro-rata as the
   * account is drawn, drained to 0 when a goal fund is spent/converted. A draw books only
   * its gain (`draw − pro-rata basis`) to tax. Pre-tax accounts keep basis 0: contributions
   * went in tax-deferred, so the whole withdrawal is taxable.
   */
  readonly basisByAccount: Map<string, Cents>;
  /**
   * Credited return awaiting accrual-taxation, keyed by ACCOUNT id — not by owner, so two
   * cash accounts held by one person accumulate independently. Where the jurisdiction
   * marks an account's `returnKind` `taxAtAccrual`, `compoundAssets` records the credited
   * growth and its category, and the NEXT month's waterfall books it through the tax seam.
   * Compounding runs after that seam, so the figure is taxed one month on — an accrual lag,
   * not a defer-to-withdrawal leak. Every entry is refreshed each month (and cleared when
   * the jurisdiction defers it), so it never goes stale.
   */
  readonly accruedReturnByAccount: Map<string, { cents: Cents; category: TaxCategory }>;
  /**
   * Authoritative current balance of each liability, updated in place by
   * advanceLiabilities. This Map, NOT the origination amortization schedule, is what is
   * owed: a lump-sum payoff or (future) capitalization mutates it directly; the schedule
   * is only a payment lookup.
   */
  readonly liabilityBalances: Map<string, Cents>;
  readonly properties: readonly SimProperty[];
  /**
   * Explicitly-funded obligations — ordered cross-account down-payment / spend draws, resolved
   * per month by {@link import("./fundingDrawStep").resolveFundingDraws}. Fixed for the whole run.
   */
  readonly fundingDraws: readonly FinancialObligation[];
  /** Authoritative current value of each property — updated by advanceProperties. */
  readonly propertyValues: Map<string, Cents>;
  /** Every person who appears as an income owner or roster member — waterfall pools. */
  readonly personIds: readonly string[];
  /**
   * A goal never moves its own money out — its fund accumulates and stays drawable — so
   * the set is fixed for the whole run.
   */
  readonly goals: readonly SimGoal[];
  /** Standing account-contribution budget lines — resolved & funded each month. */
  readonly contributionLines: readonly BudgetLine[];
  readonly sharedScheme: SharedContributionScheme;
  readonly surplusDestination: SurplusDestination;
  /**
   * Cumulative pre-tax deferral per person per calendar year, keyed `${personId}|${year}`.
   * The annual contribution cap is enforced against this running total.
   */
  readonly deferredByPersonYear: Map<string, Cents>;
  /**
   * Cumulative PRE-deferral earned gross by category, per person per calendar year, keyed
   * `${personId}|${year}`. The payroll-tax seam is charged on the difference this makes each
   * month, so a capped component (OASDI wage base) binds on the year-to-date total. Resets
   * naturally each January as the key's year rolls over.
   */
  readonly earnedByPersonYear: Map<string, TaxableByCategory>;
  /**
   * Cumulative deferral + employer match per PLAN per calendar year, keyed
   * `${planKey}|${year}`. The combined deposit limit is enforced against this running total —
   * per plan, unlike {@link deferredByPersonYear}, since each plan carries its own room.
   */
  readonly combinedDepositsByPlanYear: Map<string, Cents>;
  /**
   * Cumulative taxable income by category, per person per calendar year, keyed
   * `${personId}|${year}` — every dollar of wages, RMD, benefit, interest accrual, or
   * realized investment gain that becomes taxable THIS person's income, folded in the month
   * it occurs. Federal income tax is never charged against this running total mid-year (see
   * {@link Jurisdiction.computeTaxCents}'s ANNUAL contract): the December settlement step
   * reads the complete year's total once, at year-end, and that single read is the ONLY
   * consumer. Resets naturally each January as the key's year rolls over, mirroring {@link
   * earnedByPersonYear}.
   */
  readonly taxableIncomeByPersonYear: Map<string, TaxableByCategory>;
  /**
   * The per-SOURCE breakdown behind {@link taxableIncomeByPersonYear}, keyed the same way
   * (`${personId}|${year}`) — a sourceKey → running `{category, taxableCents}` map, summed
   * across every month the source contributed. The December settlement reads this alongside
   * the category total to apportion its per-category bill back to the sources that produced
   * it (job, draw, benefit), the same average-rate weighting {@link
   * import("./taxAttribution").attributeTaxToSources} already uses for payroll tax monthly.
   */
  readonly taxableBySourceByPersonYear: Map<string, Map<string, SourceTaxable>>;
  /** Benefit accumulation/claiming reads birthYear + benefitClaimingAge. */
  readonly personsById: ReadonlyMap<string, SimPerson>;
  /**
   * Per-person lifetime covered earnings, seeded from the pre-now summary. Every month's
   * covered wages fold in; handed to the jurisdiction seam at claiming age.
   */
  readonly earningsByPerson: Map<string, EarningsAccumulator>;
  /**
   * The BASE government retirement benefit (nominal cents, eligibility-age dollars),
   * computed at each person's claiming month and held as an OPAQUE number. Absent until
   * claimed; 0 when the jurisdiction supplies no benefit seam. The benefit actually paid
   * each year is this base run through {@link Jurisdiction.colaAdjustedBenefitCents} —
   * NOT held nominal-flat.
   */
  readonly governmentBenefitBaseByPerson: Map<string, Cents>;
  /**
   * The latest COMPLETED calendar year folded into the cached base benefit. The base is
   * recomputed only when a newer completed year adds covered earnings — a
   * claim-and-keep-working bump. Absent until the first base is computed.
   */
  readonly lastComputedThroughYear: Map<string, number>;
}

export function initSimState(input: HouseholdSimInput): SimState {
  const assetBalances = new Map<string, Cents>();
  const basisByAccount = new Map<string, Cents>();
  for (const acc of input.accounts) {
    assetBalances.set(acc.id, acc.openingBalanceCents);
    // A pre-tax account has zero basis by definition. Others open with unknown basis;
    // assuming basis == opening balance understates tax for an already-appreciated
    // portfolio — disclosed as MODEL_ASSUMPTIONS["postTaxOpeningBasis"].
    basisByAccount.set(acc.id, acc.taxProfile.contributionsPreTax ? 0 : acc.openingBalanceCents);
  }

  const properties: SimProperty[] = [...(input.properties ?? [])];
  const propertyValues = new Map<string, Cents>();
  for (const p of properties) {
    // A Year-0 purchase (startMonth 0) is a flow DURING month 0, not part of "now", so it
    // opens at 0 here and advanceProperties originates it at month 0.
    propertyValues.set(p.id, isPreExisting(p.startMonth) ? p.openingValueCents : 0);
  }

  const userLiabilities = input.liabilities ?? [];

  // Absorbs shortfalls when no real cards are entered, folded into `liabilities` so every
  // step treats it as an ordinary card. Its limit is finite so the cascade can exhaust: a
  // plan financed on unbounded revolving debt would read solvent forever instead of
  // tripping `isInsolvent`.
  const syntheticCard = userLiabilities.some((l) => l instanceof RevolvingCard)
    ? null
    : new RevolvingCard({
        id: SYNTHETIC_CARD_ID,
        ownerId: "household",
        openingBalanceCents: 0,
        apr: SYNTHETIC_CREDIT_CARD_APR,
        creditLimitCents: SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
        // Pre-existing, so the shortfall cascade can borrow onto it in month 0 — now a real
        // processed month. A `startMonth` of 0 would make the cascade skip it and
        // `advanceLiabilities` re-originate it that month, leaving a month-0 shortfall
        // uncovered and the plan falsely insolvent at the start.
        startMonth: PRE_NOW_MONTH,
      });
  const liabilities = syntheticCard ? [...userLiabilities, syntheticCard] : [...userLiabilities];

  const liabilityBalances = new Map<string, Cents>();
  for (const liab of liabilities) {
    // A liability originated at month 0 (a Year-0 mortgage or loan) is a flow during that
    // processed month, so advanceLiabilities opens it there and it stays out of the opening
    // snapshot. Only the pre-existing synthetic shortfall card seeds a balance here.
    liabilityBalances.set(liab.id, isPreExisting(liab.startMonth) ? liab.openingBalanceCents : 0);
  }

  const cascadeCards = liabilities
    .filter((l): l is RevolvingCard => l instanceof RevolvingCard)
    .sort((a, b) => a.apr - b.apr);

  // Roster members plus any income owner — an income series can be owned by someone not
  // in `persons`.
  const personIds: string[] = [];
  const seen = new Set<string>();
  for (const id of [
    ...input.persons.map((p) => p.id),
    ...input.incomeSeries.map((s) => s.ownerId),
  ]) {
    if (!seen.has(id)) {
      seen.add(id);
      personIds.push(id);
    }
  }

  const personsById = new Map<string, SimPerson>();
  for (const p of input.persons) personsById.set(p.id, p);

  const earningsByPerson = new Map<string, EarningsAccumulator>();
  for (const p of input.persons) {
    earningsByPerson.set(p.id, seedEarnings(p.priorEarningsCents));
  }

  return {
    accounts: input.accounts,
    liquidAccount: input.accounts.find((a) => a.liquid) ?? null,
    liabilities,
    cascadeCards,
    assetBalances,
    basisByAccount,
    accruedReturnByAccount: new Map<string, { cents: Cents; category: TaxCategory }>(),
    liabilityBalances,
    properties,
    propertyValues,
    fundingDraws: input.fundingDraws ?? [],
    personIds,
    goals: [...(input.goals ?? [])],
    contributionLines: input.contributionLines ?? [],
    sharedScheme: input.sharedScheme ?? "proportional",
    surplusDestination: input.surplusDestination ?? { kind: "idle" },
    deferredByPersonYear: new Map<string, Cents>(),
    earnedByPersonYear: new Map<string, TaxableByCategory>(),
    combinedDepositsByPlanYear: new Map<string, Cents>(),
    taxableIncomeByPersonYear: new Map<string, TaxableByCategory>(),
    taxableBySourceByPersonYear: new Map<string, Map<string, SourceTaxable>>(),
    personsById,
    earningsByPerson,
    governmentBenefitBaseByPerson: new Map<string, Cents>(),
    lastComputedThroughYear: new Map<string, number>(),
  };
}
