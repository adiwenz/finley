import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { SimAccount } from "../simAccount";
import { seedEarnings, type EarningsAccumulator } from "../earningsRecord";
import {
  SimLiability,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CREDIT_CARD_APR,
  SYNTHETIC_CARD_CREDIT_LIMIT_CENTS,
  minCreditCardPaymentCents,
  amortizationScheduleCents,
  derivePaymentStatus,
  deriveLoanStatus,
} from "../liability";
import { preciseMonthlyRate } from "../cashFlowSeries";
import type { SimGoal } from "../goal";
import {
  runWaterfall,
  type IncomeSourceMonth,
  type SharedContributionScheme,
  type SurplusDestination,
} from "./waterfall";
import { accumulateEarnings, buildSocialSecuritySources } from "./socialSecurity";
import { buildRmdSources } from "./rmd";
import { buildWithdrawalSources } from "./withdrawal";
import { buildFlows } from "./reportFlows";
import type {
  HouseholdSimInput,
  LiabilityPaymentRecord,
  SimOwnedSeries,
  SimPerson,
  ProjectionMonth,
  ProjectionMonthFlows,
  ProjectionSeries,
  SimProperty,
} from "./simulate.types";

// Re-exported so existing importers (and the engine barrel in index.ts) keep
// resolving the simulator's public types through ./simulate.
export type * from "./simulate.types";

const DEFAULT_START_YEAR = 2026;

function toRealCents(
  nominalCents: Cents,
  annualInflationRate: number,
  month: number,
): Cents {
  const years = month / 12;
  return Math.round(nominalCents / Math.pow(1 + annualInflationRate, years));
}

// ---------------------------------------------------------------------------
// Household simulator — real income/expense series + compounding accounts
// Slice-2 extension — liabilities, shortfall cascade (§5.1), infeasibility flag
// ---------------------------------------------------------------------------

/**
 * The resolved, mutable state a single `simulateHousehold` run threads through
 * its per-month step helpers. Built once by `initSimState`; the two balance Maps
 * are the only things that mutate as the months advance.
 */
interface SimState {
  readonly accounts: readonly SimAccount[];
  /** First liquid account — receives net cash flow and absorbs the first shortfall. */
  readonly liquidAccount: SimAccount | null;
  /** User liabilities plus the synthetic shortfall card, if one was created. */
  readonly liabilities: readonly SimLiability[];
  /** Credit cards (incl. synthetic) sorted ascending by APR — shortfall cascade order. */
  readonly cascadeCards: readonly SimLiability[];
  /** liab.id → exact amortization schedule (amortizing loans only). */
  readonly amortSchedules: ReadonlyMap<string, readonly Cents[]>;
  readonly assetBalances: Map<string, Cents>;
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
  readonly sharedScheme: SharedContributionScheme;
  readonly surplusDestination: SurplusDestination;
  /**
   * Cumulative pre-tax deferral per person per calendar year, keyed `${personId}|${year}`.
   * The §5.4 annual contribution cap is enforced against this running total.
   */
  readonly deferredByPersonYear: Map<string, Cents>;
  /** Every person by id — SS accumulation/claiming reads birthYear + ssClaimingAge. */
  readonly personsById: ReadonlyMap<string, SimPerson>;
  /**
   * Per-person lifetime SS-covered earnings accumulator (§5.4), seeded from the
   * §4.6 pre-now summary. Every month's covered wages are folded in; the record
   * is frozen and handed to the jurisdiction seam at claiming age.
   */
  readonly earningsByPerson: Map<string, EarningsAccumulator>;
  /**
   * The monthly Social Security benefit (nominal cents) computed once at each
   * person's claiming month and held flat thereafter. Absent until claimed; 0
   * when the jurisdiction supplies no benefit seam (v1 null). COLA indexing is
   * deferred — the benefit is held nominal-flat once claimed.
   */
  readonly ssMonthlyBenefitByPerson: Map<string, Cents>;
}

/** Build the run's static config and opening balances (the pre-loop setup). */
function initSimState(input: HouseholdSimInput): SimState {
  const assetBalances = new Map<string, Cents>();
  for (const acc of input.accounts) {
    assetBalances.set(acc.id, acc.openingBalanceCents);
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
  const syntheticCard = userLiabilities.some((l) => l.isCreditCard())
    ? null
    : new SimLiability({
        id: SYNTHETIC_CARD_ID,
        ownerId: "household",
        kind: "creditCard",
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
    .filter((l) => l.isCreditCard())
    .sort((a, b) => a.apr - b.apr);

  // Precompute the exact amortization schedule for each amortizing loan. Each
  // schedule retires its loan to exactly 0 over the term (final payment adjusted
  // down), so the monthly payment becomes a lookup instead of a recomputation.
  // Amortizing balances are touched in advanceLiabilities by both scheduled
  // payments and one-time transfers (Liability.addTransfer). A lump-sum transfer
  // drops the balance below the schedule's assumed trajectory, so the schedule is
  // a safe upper bound, not ground truth: computeLiabilityPayments caps each
  // payment at the actual payoff so the loop never withdraws more than is owed.
  // TODO(design): decide recast (lower payment, same term) vs. shorten-term
  // (same payment, earlier payoff) when a lump sum lands. Capping at payoff
  // yields shorten-term for free — the default behavior of most real loans.
  const amortSchedules = new Map<string, Cents[]>();
  for (const liab of liabilities) {
    if (!liab.isCreditCard() && liab.termMonths !== null) {
      amortSchedules.set(
        liab.id,
        amortizationScheduleCents(liab.openingBalanceCents, liab.apr, liab.termMonths),
      );
    }
  }

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
    amortSchedules,
    assetBalances,
    liabilityBalances,
    properties,
    propertyValues,
    personIds,
    goals: [...(input.goals ?? [])],
    sharedScheme: input.sharedScheme ?? "proportional",
    surplusDestination: input.surplusDestination ?? { kind: "idle" },
    deferredByPersonYear: new Map<string, Cents>(),
    personsById,
    earningsByPerson,
    ssMonthlyBenefitByPerson: new Map<string, Cents>(),
  };
}

/** Σ of a set of series at `month` — reused for both income (step 1) and expenses (step 3). */
function sumMonthlySeries(series: readonly SimOwnedSeries[], month: number): Cents {
  let total = 0;
  for (const s of series) total += s.series.getMonthlyCents(month);
  return total;
}

/**
 * Step 4: this month's payment for every liability, computed on beginning-of-month
 * balances. Returned so advanceLiabilities applies the exact same figure — keeping
 * the cash outflow (step 5) and the balance update consistent.
 *
 * Both kinds cap the payment at the payoff amount (balance + this month's interest)
 * so a small balance is never over-charged. For amortizing loans the cap is a no-op
 * on an untouched loan (the schedule never exceeds the balance) but becomes
 * load-bearing once a one-time payment drives the balance below the schedule.
 */
function computeLiabilityPayments(state: SimState, month: number): Map<string, Cents> {
  const payments = new Map<string, Cents>();
  for (const liab of state.liabilities) {
    const bal = state.liabilityBalances.get(liab.id) ?? 0;
    if (bal <= 0) continue;
    const owedWithInterest = Math.round(bal * (1 + liab.apr / 12));
    if (liab.isCreditCard()) {
      // Revolving balance: minimum payment.
      payments.set(liab.id, Math.min(minCreditCardPaymentCents(bal), owedWithInterest));
    } else {
      // Amortizing loan: the schedule counts from origination, so the first
      // payment (index 0) falls on startMonth+1 (past the term → 0). A loan not
      // yet originated has a 0 balance and was skipped above.
      const scheduled = state.amortSchedules.get(liab.id)?.[month - liab.startMonth - 1] ?? 0;
      payments.set(liab.id, Math.min(scheduled, owedWithInterest));
    }
  }
  return payments;
}

/**
 * Build this month's per-liability payment records from the computed payments.
 * One entry per liability with a payment due (exactly the `payments` map, which
 * already skips paid-off / not-yet-originated / origination-month liabilities).
 *
 * v1-seam: `amountApplied` and `expected` are the same figure today — the
 * payoff-capped payment the engine both intends to charge and actually applies —
 * so every record is `full` / `current`. When a future underpayment channel
 * applies less than expected, it passes a smaller `amountApplied` here and
 * `partial`/`missed`/`delinquent` surface automatically (see derivePaymentStatus).
 */
function buildLiabilityPaymentRecords(
  payments: ReadonlyMap<string, Cents>,
): Record<string, LiabilityPaymentRecord> {
  const records: Record<string, LiabilityPaymentRecord> = {};
  for (const [id, appliedCents] of payments) {
    const expectedCents = appliedCents;
    const paymentStatus = derivePaymentStatus(appliedCents, expectedCents);
    records[id] = {
      paymentStatus,
      amountAppliedCents: appliedCents,
      loanStatus: deriveLoanStatus(paymentStatus),
    };
  }
  return records;
}

/** This month's income sources for the waterfall — one per active income series. */
function buildIncomeSources(
  incomeSeries: readonly SimOwnedSeries[],
  month: number,
): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  for (const s of incomeSeries) {
    const grossCents = s.series.getMonthlyCents(month);
    if (grossCents === 0 && s.planDescriptor === undefined) continue;
    sources.push({
      ownerId: s.ownerId,
      grossCents,
      taxCategory: s.series.taxCategory ?? "ordinaryIncome",
      planDescriptor: s.planDescriptor,
    });
  }
  return sources;
}

/**
 * Step 3/6: route this month's income through the §5.0 allocation waterfall.
 * Applies the waterfall's per-account deposits (pre-tax deferrals + match, goal
 * funding, and the surplus destination) to the asset balances, then charges any
 * uncovered obligation as a deficit on the first liquid account so the §5.1
 * cascade (called next) drains liquid assets before reaching for credit.
 *
 * Returns the tax charged this month (already reflected in take-home). The
 * per-person annual deferral accumulator is updated so §5.4 caps hold across the year.
 */
function allocateMonth(
  state: SimState,
  incomeSources: readonly IncomeSourceMonth[],
  ctx: JurisdictionContext,
  jurisdiction: Jurisdiction,
  sharedObligationCents: Cents,
): void {
  // The deferral cap is per person, not per household: the annual limit (with any
  // age-banded catch-up, §5.4) depends on the individual's age this year. Resolve
  // it lazily inside the room callback so each person's birth year drives their
  // own catch-up; a person with no birth year gets the base limit (age omitted).
  const deferralLimit = jurisdiction.retirementDeferralLimitCents;

  const result = runWaterfall({
    personIds: state.personIds,
    incomeSources,
    sharedObligationCents,
    sharedScheme: state.sharedScheme,
    surplusDestination: state.surplusDestination,
    goals: state.goals,
    accountBalanceCents: (id) => state.assetBalances.get(id) ?? 0,
    liquidAccountId: state.liquidAccount?.id ?? null,
    computeTaxCents: (taxableByCategory) => jurisdiction.computeTaxCents(taxableByCategory, ctx),
    remainingDeferralRoomCents: (pid) => {
      if (deferralLimit === undefined) return Infinity;
      const birthYear = state.personsById.get(pid)?.birthYear;
      const age = birthYear === undefined ? undefined : ctx.year - birthYear;
      const limit = deferralLimit({ year: ctx.year, age });
      const used = state.deferredByPersonYear.get(`${pid}|${ctx.year}`) ?? 0;
      return Math.max(0, limit - used);
    },
  });

  for (const [id, amount] of result.accountDepositsCents) {
    state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) + amount);
  }

  if (result.shortfallCents > 0 && state.liquidAccount !== null) {
    const id = state.liquidAccount.id;
    state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) - result.shortfallCents);
  }

  for (const [pid, amount] of result.deferredByPersonCents) {
    const key = `${pid}|${ctx.year}`;
    state.deferredByPersonYear.set(key, (state.deferredByPersonYear.get(key) ?? 0) + amount);
  }
}

/**
 * Step 7: §5.1 shortfall cascade. If the liquid account went negative, zero it and
 * route the deficit onto credit cards lowest-APR-first, each up to its limit (a null
 * limit is unbounded; the synthetic shortfall card carries a finite default limit, so
 * it too can be exhausted — #36). Returns true when every card's credit is used up and
 * a deficit remains: the plan is infeasible this month (`isInsolvent`).
 */
function applyShortfallCascade(state: SimState, month: number): boolean {
  if (state.liquidAccount === null) return false;
  const liquidBal = state.assetBalances.get(state.liquidAccount.id) ?? 0;
  if (liquidBal >= 0) return false;

  let deficit = -liquidBal;
  state.assetBalances.set(state.liquidAccount.id, 0);
  for (const card of state.cascadeCards) {
    if (deficit <= 0) break;
    // A card that hasn't originated yet (opened in advanceLiabilities at its
    // startMonth) can't absorb a shortfall — borrowing onto it would be lost.
    if (month <= card.startMonth) continue;
    const currentBal = state.liabilityBalances.get(card.id) ?? 0;
    const limit = card.creditLimitCents;
    const available = limit === null ? deficit : Math.max(0, limit - currentBal);
    const borrow = Math.min(deficit, available);
    state.liabilityBalances.set(card.id, currentBal + borrow);
    deficit -= borrow;
  }
  return deficit > 0;
}

/** Step 8: one-time transfers to asset accounts (§3.2). Fixed + proportional; neither grows. */
function applyAssetTransfers(state: SimState, month: number): void {
  for (const acc of state.accounts) {
    for (const t of acc.getTransfersAt(month)) {
      const prev = state.assetBalances.get(acc.id) ?? 0;
      const fixed = t.amountCents ?? 0;
      const proportional = Math.round(prev * (t.proportionalFraction ?? 0));
      state.assetBalances.set(acc.id, prev + fixed + proportional);
    }
  }
}

/** Step 9: compound every asset account exactly once at preciseMonthlyRate(rateAt(m)) (§0.2). */
function compoundAssets(state: SimState, month: number): void {
  for (const acc of state.accounts) {
    const bal = state.assetBalances.get(acc.id) ?? 0;
    state.assetBalances.set(acc.id, Math.round(bal * (1 + acc.getMonthlyRateAt(month))));
  }
}

/**
 * Step 10: advance every liability. One-time principal adjustments (lump-sum
 * payments — the future DebtPayoffEvent, §4.3) land FIRST, before interest — the
 * liability analogue of step 8 preceding step 9 for assets — so a lump sum reduces
 * the interest charged that month. Then accrue interest and apply the pre-computed
 * `payments` figure.
 *
 * A transfer only moves the owed balance; the paired cash outflow (from a liquid
 * account) is the caller's responsibility, exactly as with asset-to-asset transfers
 * (§3.2) — the engine does not auto-fund it, so pairing a Liability payoff with an
 * Account outflow is what keeps net worth conserved. A lump sum can drive the balance
 * below the precomputed schedule; the payoff cap in computeLiabilityPayments keeps
 * that safe and yields shorten-term behavior (loan retires early, payment unchanged).
 */
function advanceLiabilities(
  state: SimState,
  month: number,
  payments: ReadonlyMap<string, Cents>,
): void {
  for (const liab of state.liabilities) {
    if (month < liab.startMonth) continue; // not originated yet — stays at 0
    if (month === liab.startMonth) {
      // Origination: the balance appears with no interest or payment this month,
      // mirroring an account's opening balance at month 0.
      state.liabilityBalances.set(liab.id, liab.openingBalanceCents);
      continue;
    }
    let bal = state.liabilityBalances.get(liab.id) ?? 0;
    for (const t of liab.getTransfersAt(month)) {
      const fixed = t.amountCents ?? 0;
      const proportional = Math.round(bal * (t.proportionalFraction ?? 0));
      bal = Math.max(0, bal + fixed + proportional);
    }
    if (bal <= 0) {
      state.liabilityBalances.set(liab.id, 0);
      continue;
    }
    bal = Math.round(bal * (1 + liab.apr / 12));
    state.liabilityBalances.set(liab.id, Math.max(0, bal - (payments.get(liab.id) ?? 0)));
  }
}

/**
 * Advance every property's value one month. A property not yet purchased stays
 * at 0; at its purchase month it opens at `openingValueCents` with no appreciation
 * (mirroring an account opening or a loan origination); after a sale (`endMonth`)
 * its value is 0 and stops contributing to net worth; otherwise it appreciates
 * once at `preciseMonthlyRate(appreciationAnnualRate)`. Runs after the liability
 * step so a same-month sale (future) settles consistently.
 */
function advanceProperties(state: SimState, month: number): void {
  for (const p of state.properties) {
    if (month < p.startMonth) continue; // not purchased yet — stays at 0
    if (p.endMonth !== null && month > p.endMonth) {
      state.propertyValues.set(p.id, 0); // sold — value gone
      continue;
    }
    if (month === p.startMonth) {
      state.propertyValues.set(p.id, p.openingValueCents);
      continue;
    }
    const value = state.propertyValues.get(p.id) ?? 0;
    state.propertyValues.set(
      p.id,
      Math.round(value * (1 + preciseMonthlyRate(p.appreciationAnnualRate))),
    );
  }
}

/**
 * Fire each goal's disposition at its maturity (§5.2, #28). Runs at the END of the
 * target month — AFTER that month's snapshot has already recorded the fund AT its
 * target (so a goals surface reads the goal as achieved on its date) — and takes
 * effect from the next month forward:
 *  - `spend` — the accumulated fund is consumed by the event and LEAVES net worth
 *    (the balance is zeroed with no offsetting asset; a vacation / wedding).
 *  - `convertToEquity` — the fund is transferred out of the liquid accounts and
 *    reappears as an illiquid home-equity holding (a property opening at the fund's
 *    matured value, appreciating at that fund's own rate). Net worth is unchanged at
 *    the swap (§4.5), and the equity drops out of the drawable retirement nest egg
 *    for free — it is no longer a `SimAccount`, so the decumulation liquidation loop
 *    never sees it (a fuller property+mortgage model needs purchase/mortgage terms a
 *    GoalPlan does not carry — future work).
 *  - `retain` / `drawDown` — nothing fires; the money stays where it is.
 *
 * A fired goal is removed from `state.goals`, so its fund is never re-funded by the
 * waterfall, re-earmarked, or drawn again. "asap" goals have no fixed maturity month
 * and so never fire here (they are measured at the horizon end elsewhere).
 */
function fireGoalDispositions(state: SimState, month: number): void {
  const fired = new Set<string>();
  for (const goal of state.goals) {
    if (goal.targetDate !== month) continue; // fires once, at the numeric target month
    if (goal.disposition !== "spend" && goal.disposition !== "convertToEquity") continue;
    const maturedCents = Math.max(0, state.assetBalances.get(goal.fundAccountId) ?? 0);
    state.assetBalances.set(goal.fundAccountId, 0);
    if (goal.disposition === "convertToEquity" && maturedCents > 0) {
      const fundAccount = state.accounts.find((a) => a.id === goal.fundAccountId);
      state.properties.push({
        id: `goal-equity-${goal.id}`,
        ownerId: fundAccount?.ownerId ?? goal.ownerId ?? "household",
        startMonth: month + 1, // opens next month at its matured value (see advanceProperties)
        endMonth: null,
        openingValueCents: maturedCents,
        appreciationAnnualRate: fundAccount ? fundAccount.getRateAt(month) : 0,
      });
      state.propertyValues.set(`goal-equity-${goal.id}`, maturedCents);
    }
    fired.add(goal.id);
  }
  if (fired.size > 0) state.goals = state.goals.filter((g) => !fired.has(g.id));
}

/**
 * Step 11: snapshot net worth = Σassets + Σproperties − Σliabilities; real = nominal
 * / (1+infl)^yrs (§0.4). When `netWorthTerminated` (a PRIOR month already went
 * insolvent, §5.1) both net-worth figures are reported as `null` — the model can no
 * longer say what net worth is once unfunded spending has been dropped. The balances
 * themselves are still emitted (diagnostic), only the aggregate net worth is nulled.
 */
function snapshotMonth(
  state: SimState,
  month: number,
  annualInflationRate: number,
  isInsolvent: boolean,
  netWorthTerminated: boolean,
  liabilityPaymentRecords: Record<string, LiabilityPaymentRecord>,
  flows: ProjectionMonthFlows | undefined,
): ProjectionMonth {
  let nominalNetWorth: Cents = 0;

  const accountBalancesCents: Record<string, Cents> = {};
  for (const acc of state.accounts) {
    const bal = state.assetBalances.get(acc.id) ?? 0;
    accountBalancesCents[acc.id] = bal;
    nominalNetWorth += bal;
  }

  const liabilityBalancesCents: Record<string, Cents> = {};
  for (const liab of state.liabilities) {
    const bal = state.liabilityBalances.get(liab.id) ?? 0;
    liabilityBalancesCents[liab.id] = bal;
    nominalNetWorth -= bal;
  }

  const propertyValuesCents: Record<string, Cents> = {};
  for (const p of state.properties) {
    const value = state.propertyValues.get(p.id) ?? 0;
    propertyValuesCents[p.id] = value;
    nominalNetWorth += value;
  }

  return {
    month,
    netWorthNominalCents: netWorthTerminated ? null : nominalNetWorth,
    netWorthRealCents: netWorthTerminated
      ? null
      : toRealCents(nominalNetWorth, annualInflationRate, month),
    accountBalancesCents,
    liabilityBalancesCents,
    liabilityPaymentRecords,
    propertyValuesCents,
    isInsolvent,
    ...(flows !== undefined ? { flows } : {}),
  };
}

/**
 * Household simulator. Fixed pipeline per month (§5), each step a named helper:
 *   3–6. §5.0 allocation waterfall: per-source pre-tax deferrals, tax seam,
 *        take-home pools, shared/personal goals, surplus — plus the deficit charge
 *        that feeds the cascade                            → allocateMonth
 *     7. §5.1 shortfall cascade                            → applyShortfallCascade
 *  8–9. Asset one-time transfers, then compounding        → applyAssetTransfers / compoundAssets
 *   10. Liability transfers, interest, payments           → advanceLiabilities
 *  10b. Property appreciation                             → advanceProperties
 *   11. Snapshot                                          → snapshotMonth
 * Expenses and liability payments are the month's shared obligations; the tax
 * chokepoint (§5.3) lives inside the waterfall and nowhere else.
 * Month 0 is the opening snapshot only — no month is processed before "now" (§4.6).
 */
export function simulateHousehold(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const state = initSimState(input);
  const months: ProjectionMonth[] = [];
  // Insolvency is terminal for net-worth reporting (§5.1): once any month exhausts
  // all credit, every LATER month reports net worth as null. Tracks whether a prior
  // month already tripped it — the first insolvent month itself still reports its
  // (honest, negative) value; only the months after it are nulled.
  let priorInsolvency = false;

  for (let month = 0; month <= input.horizonMonths; month++) {
    let isInsolvent = false;
    let paymentRecords: Record<string, LiabilityPaymentRecord> = {};
    let flows: ProjectionMonthFlows | undefined;

    if (month > 0) {
      // Calendar year for this month's flows. NOTE (documented simplification):
      // because month 0 is the flow-free opening snapshot above and years bucket by
      // floor(month/12), the FIRST calendar year accrues only 11 flow-months — a
      // $5k/mo salary contributes $55k (not $60k) to year 0's SS earnings record,
      // and one month of expenses/compounding is likewise absent. The engine tracks
      // integer years only and does not model what month of the year "now" is, so a
      // mid-year start would in reality leave even fewer months; 11 is neither that
      // nor a full 12. Impact is ~0.1% (e.g. the graph's SS is ~$34/yr below the
      // panel's full-first-year closed form). Modelling a start month-of-year so the
      // first partial year is exact — and the two SS numbers agree — is tracked in
      // GH #34; do NOT "fix" it by making month 0 earn (that redefines "now").
      const year = startYear + Math.floor(month / 12);
      const ctx: JurisdictionContext = { year };

      // Fold this month's covered wages into each person's SS earnings record
      // before assembling income, so a claim landing this month sees them (§5.4).
      accumulateEarnings(state.earningsByPerson, input.incomeSeries, month, year);
      // RMDs (§5.4) force this year's required draw out of pre-tax accounts BEFORE
      // the waterfall runs and re-enter it here as taxable ordinary income, so the
      // withdrawal is taxed once at the single chokepoint and lands in the surplus.
      const nonWithdrawalSources = [
        ...buildIncomeSources(input.incomeSeries, month),
        ...buildSocialSecuritySources(state, jurisdiction, month, startYear, input.annualInflationRate),
        ...buildRmdSources(state, jurisdiction, month, startYear),
      ];

      const expenseCents = sumMonthlySeries(input.expenseSeries, month);
      const payments = computeLiabilityPayments(state, month);
      const totalPaymentsCents = [...payments.values()].reduce((s, v) => s + v, 0);

      // Decumulation (§7, #35): when non-withdrawal income can't cover the month's
      // obligations, liquidate investment accounts BEFORE the waterfall — same seam
      // as RMD/SS — so the shortfall is funded by selling assets (taxed once at the
      // chokepoint) instead of landing on the synthetic credit card. RMD income is
      // already counted here, so the desired draw never double-withdraws (#32).
      const incomeSources = [
        ...nonWithdrawalSources,
        ...buildWithdrawalSources(
          state,
          jurisdiction,
          month,
          nonWithdrawalSources,
          expenseCents + totalPaymentsCents,
          ctx,
        ),
      ];

      allocateMonth(state, incomeSources, ctx, jurisdiction, expenseCents + totalPaymentsCents);
      isInsolvent = applyShortfallCascade(state, month);

      applyAssetTransfers(state, month);
      compoundAssets(state, month);
      advanceLiabilities(state, month, payments);
      advanceProperties(state, month);
      paymentRecords = buildLiabilityPaymentRecords(payments);
      flows = buildFlows(incomeSources, expenseCents, totalPaymentsCents);
    }

    months.push(
      snapshotMonth(
        state,
        month,
        input.annualInflationRate,
        isInsolvent,
        priorInsolvency,
        paymentRecords,
        flows,
      ),
    );
    if (isInsolvent) priorInsolvency = true;

    // Fire any goal maturing THIS month after its snapshot, so the fund reads as
    // achieved on its target date and the disposition (spend leaves net worth /
    // convertToEquity swaps to illiquid equity) takes hold from next month (§5.2, #28).
    fireGoalDispositions(state, month);
  }

  return { months };
}
