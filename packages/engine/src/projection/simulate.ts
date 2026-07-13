import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { Account } from "../account";
import {
  Liability,
  SYNTHETIC_CARD_ID,
  SYNTHETIC_CREDIT_CARD_APR,
  minCreditCardPaymentCents,
  amortizationScheduleCents,
  derivePaymentStatus,
  deriveLoanStatus,
  type PaymentStatus,
  type LoanStatus,
} from "../liability";
import { CashFlowSeries, preciseMonthlyRate } from "../cashFlowSeries";

/**
 * The projection series — the engine's public output and the chart's data
 * contract (§10.6). One entry per simulated month, starting at the "now"
 * marker (month 0); there is no pre-"now" financial curve (§4.6).
 *
 * Simulate in nominal dollars, report in real dollars (§0.4): every point
 * carries both `netWorthNominalCents` and `netWorthRealCents`, so the chart can
 * draw the real and nominal curves without recomputing the conversion.
 */
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

export interface ProjectionMonth {
  readonly month: number;
  readonly netWorthNominalCents: Cents;
  readonly netWorthRealCents: Cents;
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
}

export interface ProjectionSeries {
  readonly months: readonly ProjectionMonth[];
}

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

/** A person in the household. */
export interface Person {
  readonly id: string;
  readonly name: string;
}

/** An income or expense series tied to an owner. */
export interface OwnedSeries {
  readonly series: CashFlowSeries;
  readonly ownerId: string;
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
  readonly startYear?: number;
  readonly persons: readonly Person[];
  /**
   * Asset accounts. The first liquid account receives net cash flow each month
   * (simplified Slice-1/2 allocation; full waterfall comes in Slice 5a, issue #7).
   */
  readonly accounts: readonly Account[];
  readonly incomeSeries: readonly OwnedSeries[];
  readonly expenseSeries: readonly OwnedSeries[];
  /**
   * Liabilities (mortgages, auto loans, student loans, credit cards).
   * Amortizing payments are computed from opening balance/rate/term (§3);
   * credit card minimum payments are computed each month from the current balance.
   * If no credit cards are provided, a synthetic 22% APR card absorbs shortfalls (§5.1).
   */
  readonly liabilities?: readonly Liability[];
  /**
   * Owned properties (§4.1). Each is an appreciating asset stock whose value
   * feeds net worth; the associated mortgage is an ordinary entry in `liabilities`.
   */
  readonly properties?: readonly SimProperty[];
}

/**
 * The resolved, mutable state a single `simulateHousehold` run threads through
 * its per-month step helpers. Built once by `initSimState`; the two balance Maps
 * are the only things that mutate as the months advance.
 */
interface SimState {
  readonly accounts: readonly Account[];
  /** First liquid account — receives net cash flow and absorbs the first shortfall. */
  readonly liquidAccount: Account | null;
  /** User liabilities plus the synthetic shortfall card, if one was created. */
  readonly liabilities: readonly Liability[];
  /** Credit cards (incl. synthetic) sorted ascending by APR — shortfall cascade order. */
  readonly cascadeCards: readonly Liability[];
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
  readonly properties: readonly SimProperty[];
  /** Authoritative, mutable current value of each property — updated by advanceProperties. */
  readonly propertyValues: Map<string, Cents>;
}

/** Build the run's static config and opening balances (the pre-loop setup). */
function initSimState(input: HouseholdSimInput): SimState {
  const assetBalances = new Map<string, Cents>();
  for (const acc of input.accounts) {
    assetBalances.set(acc.id, acc.openingBalanceCents);
  }

  const properties = input.properties ?? [];
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
  // it never collides with a real card in the cascade ordering.
  const syntheticCard = userLiabilities.some((l) => l.isCreditCard())
    ? null
    : new Liability({
        id: SYNTHETIC_CARD_ID,
        ownerId: "household",
        kind: "creditCard",
        openingBalanceCents: 0,
        apr: SYNTHETIC_CREDIT_CARD_APR,
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
  };
}

/** Σ of a set of series at `month` — reused for both income (step 1) and expenses (step 3). */
function sumMonthlySeries(series: readonly OwnedSeries[], month: number): Cents {
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

/** Step 6: deposit net cash flow into the first liquid account (pre-waterfall simplification). */
function depositNetFlow(state: SimState, netFlowCents: Cents): void {
  if (state.liquidAccount === null) return;
  const prev = state.assetBalances.get(state.liquidAccount.id) ?? 0;
  state.assetBalances.set(state.liquidAccount.id, prev + netFlowCents);
}

/**
 * Step 7: §5.1 shortfall cascade. If the liquid account went negative, zero it and
 * route the deficit onto credit cards lowest-APR-first (a null limit = the synthetic
 * card = unlimited). Returns true when credit is exhausted and the plan is infeasible.
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

/** Step 11: snapshot net worth = Σassets + Σproperties − Σliabilities; real = nominal / (1+infl)^yrs (§0.4). */
function snapshotMonth(
  state: SimState,
  month: number,
  annualInflationRate: number,
  isInsolvent: boolean,
  liabilityPaymentRecords: Record<string, LiabilityPaymentRecord>,
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
    netWorthNominalCents: nominalNetWorth,
    netWorthRealCents: toRealCents(nominalNetWorth, annualInflationRate, month),
    accountBalancesCents,
    liabilityBalancesCents,
    liabilityPaymentRecords,
    propertyValuesCents,
    isInsolvent,
  };
}

/**
 * Household simulator. Fixed pipeline per month (§5), each step a named helper:
 *  1–3. Gross income, tax (jurisdiction seam), expenses  → sumMonthlySeries
 *  4–5. Liability payments → net flow                     → computeLiabilityPayments
 *  6–7. Deposit, then §5.1 shortfall cascade              → depositNetFlow / applyShortfallCascade
 *  8–9. Asset one-time transfers, then compounding        → applyAssetTransfers / compoundAssets
 *   10. Liability transfers, interest, payments           → advanceLiabilities
 *  10b. Property appreciation                             → advanceProperties
 *   11. Snapshot                                          → snapshotMonth
 * Month 0 is the opening snapshot only — no month is processed before "now" (§4.6).
 */
export function simulateHousehold(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const state = initSimState(input);
  const months: ProjectionMonth[] = [];

  for (let month = 0; month <= input.horizonMonths; month++) {
    let isInsolvent = false;
    let paymentRecords: Record<string, LiabilityPaymentRecord> = {};

    if (month > 0) {
      const ctx: JurisdictionContext = { year: startYear + Math.floor(month / 12) };

      const grossIncomeCents = sumMonthlySeries(input.incomeSeries, month);
      const taxCents = jurisdiction.computeTaxCents(Math.max(0, grossIncomeCents), ctx);
      const expenseCents = sumMonthlySeries(input.expenseSeries, month);

      const payments = computeLiabilityPayments(state, month);
      const totalPaymentsCents = [...payments.values()].reduce((s, v) => s + v, 0);
      const netFlowCents = grossIncomeCents - taxCents - expenseCents - totalPaymentsCents;

      depositNetFlow(state, netFlowCents);
      isInsolvent = applyShortfallCascade(state, month);

      applyAssetTransfers(state, month);
      compoundAssets(state, month);
      advanceLiabilities(state, month, payments);
      advanceProperties(state, month);
      paymentRecords = buildLiabilityPaymentRecords(payments);
    }

    months.push(
      snapshotMonth(state, month, input.annualInflationRate, isInsolvent, paymentRecords),
    );
  }

  return { months };
}
