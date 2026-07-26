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

/**
 * The resolved, mutable state a single `simulateHousehold` run threads through
 * its per-month step helpers. Built once by `initSimState`; the two balance Maps
 * are the only things that mutate as the months advance.
 *
 * Engine-INTERNAL: exported so the per-month step modules (liabilitySteps,
 * assetSteps, allocationStep, goalSteps, monthSnapshot) can share the exact
 * shape, but deliberately kept OFF the public engine barrel (index.ts) — exactly
 * like `SimPerson` since the #72 hinge, this is a compiled internal shape.
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
   * Per-account cost basis (§#94) — the post-tax principal booked into each account.
   * Rises with post-tax deposits (surplus sweep, goal funding), falls pro-rata as the
   * account is drawn, and is drained to 0 when a goal fund is spent/converted. A draw
   * books only its gain (`draw − pro-rata basis`) to tax. Pre-tax accounts keep basis
   * 0 by construction: their contributions were tax-deferred going in, so the whole
   * withdrawal is taxable. Parallels `assetBalances` in shape and lifecycle.
   */
  readonly basisByAccount: Map<string, Cents>;
  /**
   * Credited return awaiting accrual-taxation, keyed by ACCOUNT id (§#94 Commit 2). For
   * every account whose {@link SimAccount.taxProfile} declares a `returnKind` that the
   * JURISDICTION marks `taxAtAccrual` — a cash buffer, and there may be several —
   * `compoundAssets` records the credited growth here together with the jurisdiction-
   * chosen income category; the NEXT month's waterfall books each through the single
   * §5.3 seam. Keyed per account (not per owner) so two cash accounts held by one person
   * accumulate independently rather than overwriting each other. Compounding runs AFTER
   * that seam, so the figure is necessarily taxed one month on — an accrual lag, not the
   * old defer-to-withdrawal leak. Each account's entry is refreshed every month (and
   * cleared when the jurisdiction defers it), so it never carries stale.
   */
  readonly accruedReturnByAccount: Map<string, { cents: Cents; category: TaxCategory }>;
  /**
   * The authoritative, mutable current balance of each liability — updated in
   * place after each month's payment is applied (advanceLiabilities). This Map,
   * NOT the origination amortization schedule, is the source of truth for what
   * is owed: a lump-sum payoff or (future) capitalization/negative-amortization
   * mutates it directly, and the schedule serves only as a payment lookup. This
   * is the `current_balance` seam — do not re-derive owed amounts from the
   * static schedule.
   */
  readonly liabilityBalances: Map<string, Cents>;
  /**
   * Mutable so a `convertToEquity` goal can synthesize its home-equity holding when
   * it matures (fireGoalDispositions) — the down-payment fund leaves the accounts and
   * reappears here as an illiquid property (§5.2, #28).
   */
  properties: SimProperty[];
  /** Authoritative, mutable current value of each property — updated by advanceProperties. */
  readonly propertyValues: Map<string, Cents>;
  /** Every person who appears as an income owner or roster member — waterfall pools. */
  readonly personIds: readonly string[];
  /**
   * The funding goals. Mutable: a goal is dropped once its disposition has fired at
   * maturity (fireGoalDispositions), so a spent / converted fund is never re-funded,
   * re-earmarked, or drawn thereafter (§5.2, #28).
   */
  goals: SimGoal[];
  /** Standing account-contribution budget lines (§12) — resolved & funded each month. */
  readonly contributionLines: readonly BudgetLine[];
  readonly sharedScheme: SharedContributionScheme;
  readonly surplusDestination: SurplusDestination;
  /**
   * Cumulative pre-tax deferral per person per calendar year, keyed `${personId}|${year}`.
   * The §5.4 annual contribution cap is enforced against this running total.
   */
  readonly deferredByPersonYear: Map<string, Cents>;
  /** Every person by id — benefit accumulation/claiming reads birthYear + benefitClaimingAge. */
  readonly personsById: ReadonlyMap<string, SimPerson>;
  /**
   * Per-person lifetime covered-earnings accumulator (§5.4), seeded from the
   * §4.6 pre-now summary. Every month's covered wages are folded in; the record
   * is frozen and handed to the jurisdiction seam at claiming age.
   */
  readonly earningsByPerson: Map<string, EarningsAccumulator>;
  /**
   * The frozen BASE government retirement benefit (nominal cents, eligibility-age
   * dollars) computed once at each person's claiming month and held as an OPAQUE
   * number. Absent until claimed; 0 when the jurisdiction supplies no benefit seam
   * (v1 null). The benefit actually paid each year is this base run through the
   * jurisdiction's COLA seam ({@link Jurisdiction.colaAdjustedBenefitCents}), so it
   * is NOT held nominal-flat — it grows with the annual cost-of-living adjustment.
   */
  readonly governmentBenefitBaseByPerson: Map<string, Cents>;
  /**
   * Per-person marker: the latest COMPLETED calendar year already folded into the
   * cached base benefit (§5.4, Phase 5). The base is recomputed only when a newer
   * completed year has added covered earnings — a claim-and-keep-working bump —
   * and is otherwise frozen. Absent until the first base is computed.
   */
  readonly lastComputedThroughYear: Map<string, number>;
}

/** Build the run's static config and opening balances (the pre-loop setup). */
export function initSimState(input: HouseholdSimInput): SimState {
  const assetBalances = new Map<string, Cents>();
  const basisByAccount = new Map<string, Cents>();
  for (const acc of input.accounts) {
    assetBalances.set(acc.id, acc.openingBalanceCents);
    // Opening basis (§#94): a pre-tax account has zero basis by definition (its
    // contributions were never taxed), so its whole balance is taxable on the way
    // out. Every other account opens with unknown basis; assume basis == opening
    // balance (no embedded gain) — the friendly default. It understates tax for a
    // user modelling an already-appreciated portfolio, which is the documented cost
    // disclosed to the app as MODEL_ASSUMPTIONS["postTaxOpeningBasis"] (assumptions.ts).
    basisByAccount.set(acc.id, acc.taxProfile.contributionsPreTax ? 0 : acc.openingBalanceCents);
  }

  const properties: SimProperty[] = [...(input.properties ?? [])];
  const propertyValues = new Map<string, Cents>();
  for (const p of properties) {
    // A property bought later opens at 0; advanceProperties opens it at its
    // startMonth. One present from the start (startMonth ≤ 0) opens here.
    propertyValues.set(p.id, p.startMonth <= 0 ? p.openingValueCents : 0);
  }

  const userLiabilities = input.liabilities ?? [];

  // Synthetic 22% card absorbs shortfalls when no real cards are entered (§5.1).
  // Folded into `liabilities` so every step treats it as an ordinary card — no
  // special-casing downstream. It exists ONLY when there are no user cards, so
  // it never collides with a real card in the cascade ordering. Its limit is
  // finite (SYNTHETIC_CARD_CREDIT_LIMIT_CENTS) so the cascade can genuinely
  // exhaust: a plan financed on unbounded revolving debt must eventually trip
  // the §5.1 terminal HARD-INFEASIBILITY flag (`isInsolvent`) rather than read
  // as solvent forever (#36).
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
    // A loan that originates later starts at 0; advanceLiabilities opens it at
    // its startMonth. Loans present from the start (startMonth ≤ 0) open here.
    liabilityBalances.set(liab.id, liab.startMonth <= 0 ? liab.openingBalanceCents : 0);
  }

  const cascadeCards = liabilities
    .filter((l): l is RevolvingCard => l instanceof RevolvingCard)
    .sort((a, b) => a.apr - b.apr);

  // Everyone who can hold a cash pool in the waterfall: roster members plus any
  // income owner (an income series can be owned by someone not in `persons`).
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
