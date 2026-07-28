import type { Cents } from "../money";
import type { SimAccount } from "../simAccount";
import { seedEarnings, type EarningsAccumulator } from "../earningsRecord";
import {
  RevolvingCard,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CREDIT_CARD_APR,
  SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
  type SimLiability,
} from "../liability";
import type { TaxCategory } from "../cashFlowSeries";
import type { BudgetLine } from "../budgetLine";
import type { SimGoal } from "../goal";
import type { SharedContributionScheme, SurplusDestination } from "./waterfall";
import type { HouseholdSimInput, SimPerson, SimProperty } from "./simulate.types";
import type { FundingDraw } from "../ledger/transfers";

/**
 * The resolved, mutable state one `simulateHousehold` run threads through its per-month
 * step helpers. Built once by `initSimState`; the two balance Maps are the only things
 * that mutate as months advance.
 *
 * Engine-INTERNAL: exported so the per-month step modules (liabilitySteps, assetSteps,
 * allocationStep, monthSnapshot) share the exact shape, but deliberately kept OFF the
 * public barrel (index.ts) — like `SimPerson`, a compiled internal shape.
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
   * Per-account cost basis — the post-tax principal booked into each account. Rises with
   * post-tax deposits (surplus sweep, goal funding), falls pro-rata as the account is
   * drawn, drained to 0 when a goal fund is spent/converted. A draw books only its gain
   * (`draw − pro-rata basis`) to tax. Pre-tax accounts keep basis 0 by construction:
   * contributions went in tax-deferred, so the whole withdrawal is taxable. Parallels
   * `assetBalances` in shape and lifecycle.
   */
  readonly basisByAccount: Map<string, Cents>;
  /**
   * Credited return awaiting accrual-taxation, keyed by ACCOUNT id. For every account
   * whose {@link SimAccount.taxProfile} `returnKind` the JURISDICTION marks
   * `taxAtAccrual` (a cash buffer; there may be several), `compoundAssets` records the
   * credited growth plus the jurisdiction-chosen income category, and the NEXT month's
   * waterfall books it through the single tax seam. Keyed per account, not per owner, so
   * two cash accounts held by one person accumulate independently. Compounding runs AFTER
   * that seam, so the figure is necessarily taxed one month on — an accrual lag, not a
   * defer-to-withdrawal leak. Every entry is refreshed each month (and cleared when the
   * jurisdiction defers it), so it never goes stale.
   */
  readonly accruedReturnByAccount: Map<string, { cents: Cents; category: TaxCategory }>;
  /**
   * Authoritative, mutable current balance of each liability — updated in place after
   * each month's payment (advanceLiabilities). This Map, NOT the origination amortization
   * schedule, is the source of truth for what is owed: a lump-sum payoff or (future)
   * capitalization/negative-amortization mutates it directly, and the schedule is only a
   * payment lookup. The `current_balance` seam — never re-derive owed amounts from the
   * static schedule.
   */
  readonly liabilityBalances: Map<string, Cents>;
  /** Owned properties, seeded from the resolved input; only their values move each month. */
  readonly properties: readonly SimProperty[];
  /**
   * Ordered cross-account down-payment / spend draws, resolved per month by
   * {@link import("./fundingDrawStep").applyFundingDraws}, which drains each from its
   * sources in order (reducing balances, returning basis) and reports gain vs. returned
   * principal. Fixed for the whole run.
   */
  readonly fundingDraws: readonly FundingDraw[];
  /** Authoritative, mutable current value of each property — updated by advanceProperties. */
  readonly propertyValues: Map<string, Cents>;
  /** Every person who appears as an income owner or roster member — waterfall pools. */
  readonly personIds: readonly string[];
  /**
   * The funding goals. A goal never moves its own money out — its fund accumulates and
   * stays drawable — so the set is fixed for the whole run.
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
  /** Every person by id — benefit accumulation/claiming reads birthYear + benefitClaimingAge. */
  readonly personsById: ReadonlyMap<string, SimPerson>;
  /**
   * Per-person lifetime covered-earnings accumulator, seeded from the pre-now summary.
   * Every month's covered wages fold in; frozen and handed to the jurisdiction seam at
   * claiming age.
   */
  readonly earningsByPerson: Map<string, EarningsAccumulator>;
  /**
   * The frozen BASE government retirement benefit (nominal cents, eligibility-age
   * dollars), computed once at each person's claiming month and held as an OPAQUE number.
   * Absent until claimed; 0 when the jurisdiction supplies no benefit seam (v1 null). The
   * benefit actually paid each year is this base run through the jurisdiction's COLA seam
   * ({@link Jurisdiction.colaAdjustedBenefitCents}) — NOT held nominal-flat.
   */
  readonly governmentBenefitBaseByPerson: Map<string, Cents>;
  /**
   * Per-person: the latest COMPLETED calendar year folded into the cached base benefit.
   * The base is recomputed only when a newer completed year adds covered earnings — a
   * claim-and-keep-working bump — and is otherwise frozen. Absent until the first base is
   * computed.
   */
  readonly lastComputedThroughYear: Map<string, number>;
}

/** Build the run's static config and opening balances (the pre-loop setup). */
export function initSimState(input: HouseholdSimInput): SimState {
  const assetBalances = new Map<string, Cents>();
  const basisByAccount = new Map<string, Cents>();
  for (const acc of input.accounts) {
    assetBalances.set(acc.id, acc.openingBalanceCents);
    // A pre-tax account has zero basis by definition (contributions were never taxed),
    // so its whole balance is taxable on the way out. Others open with unknown basis;
    // assume basis == opening balance (no embedded gain). That understates tax for an
    // already-appreciated portfolio — the cost disclosed as
    // MODEL_ASSUMPTIONS["postTaxOpeningBasis"] (assumptions.ts).
    basisByAccount.set(acc.id, acc.taxProfile.contributionsPreTax ? 0 : acc.openingBalanceCents);
  }

  const properties: SimProperty[] = [...(input.properties ?? [])];
  const propertyValues = new Map<string, Cents>();
  for (const p of properties) {
    // A property bought later opens at 0; advanceProperties opens it at its startMonth.
    // One present from the start (startMonth ≤ 0) opens here.
    propertyValues.set(p.id, p.startMonth <= 0 ? p.openingValueCents : 0);
  }

  const userLiabilities = input.liabilities ?? [];

  // Synthetic 22% card absorbs shortfalls when no real cards are entered. Folded into
  // `liabilities` so every step treats it as an ordinary card — no special-casing
  // downstream. Exists ONLY when there are no user cards, so it never collides with a
  // real card in the cascade ordering. Its limit is finite so the cascade can genuinely
  // exhaust: a plan financed on unbounded revolving debt must eventually trip the
  // terminal hard-infeasibility flag (`isInsolvent`) rather than read solvent forever.
  const syntheticCard = userLiabilities.some((l) => l instanceof RevolvingCard)
    ? null
    : new RevolvingCard({
        id: SYNTHETIC_CARD_ID,
        ownerId: "household",
        openingBalanceCents: 0,
        apr: SYNTHETIC_CREDIT_CARD_APR,
        creditLimitCents: SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
      });
  const liabilities = syntheticCard ? [...userLiabilities, syntheticCard] : [...userLiabilities];

  const liabilityBalances = new Map<string, Cents>();
  for (const liab of liabilities) {
    // A loan originating later starts at 0; advanceLiabilities opens it at its
    // startMonth. Loans present from the start (startMonth ≤ 0) open here.
    liabilityBalances.set(liab.id, liab.startMonth <= 0 ? liab.openingBalanceCents : 0);
  }

  const cascadeCards = liabilities
    .filter((l): l is RevolvingCard => l instanceof RevolvingCard)
    .sort((a, b) => a.apr - b.apr);

  // Everyone who can hold a cash pool in the waterfall: roster members plus any income
  // owner — an income series can be owned by someone not in `persons`.
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
    personsById,
    earningsByPerson,
    governmentBenefitBaseByPerson: new Map<string, Cents>(),
    lastComputedThroughYear: new Map<string, number>(),
  };
}
