/**
 * Liability — amortizing loan or revolving credit account (§3).
 *
 * Amortizing liabilities (mortgage, auto, studentLoan): the monthly payment
 * is COMPUTED from current balance/rate/term, not entered as an expense line.
 * Uses nominal monthly rate (APR / 12) to match published amortization tables.
 *
 * Credit cards: revolving balance, APR, credit limit, minimum payment
 * (greater of 2% of balance or $25). If no credit card is entered, the
 * simulator uses a synthetic 22% APR card as the shortfall sink (§5.1).
 */

import type { Cents } from "./money";
import type { SimOneTimeTransfer } from "./simAccount";

export type LiabilityKind = "mortgage" | "auto" | "studentLoan" | "creditCard";

/**
 * How a single scheduled payment was serviced this month — the payment-record
 * seam for future partial-payment / negative-amortization work.
 *
 * v1-seam: only `full` is reachable today. The projection always applies the
 * exact scheduled (payoff-capped) payment, so no payment ever comes in short.
 * `partial` and `missed` exist so that when a future underpayment channel lands
 * (e.g. a forbearance or missed-payment event), the model already has a place to
 * record the outcome — no data-shape migration required. See derivePaymentStatus.
 */
export type PaymentStatus = "full" | "partial" | "missed";

/**
 * The servicing state of a loan for a given month — the loan-record seam.
 *
 * v1-seam: only `current` is reachable today (every payment is `full`). Room is
 * deliberately left in the enum for future states such as `forbearance` and
 * `default`; those are NOT populated yet. Delinquency here is derived fresh each
 * month from that month's payment status — there is no arrearage/past-due memory
 * (that state is explicitly deferred). See deriveLoanStatus.
 */
export type LoanStatus = "current" | "delinquent";

/**
 * Classify a payment by comparing what was actually applied against what the
 * engine intended to charge this month. `expectedCents` is the payoff-capped
 * scheduled payment (the figure the projection decided to charge), NOT the raw
 * amortization-table level payment — so a legitimately-smaller final payoff
 * payment (applied === expected) reads as `full`, not `partial`.
 *
 * v1-seam: today the call site passes the same figure for both arguments, so the
 * result is always `full`. The two-argument shape is the seam: a future channel
 * that applies less than expected will surface `partial`/`missed` with no change
 * to this function.
 */
export function derivePaymentStatus(
  amountAppliedCents: Cents,
  expectedCents: Cents,
): PaymentStatus {
  if (expectedCents <= 0 || amountAppliedCents >= expectedCents) return "full";
  if (amountAppliedCents <= 0) return "missed";
  return "partial";
}

/**
 * The loan's servicing status for a month, derived purely from that month's
 * payment status. No cross-month state: a `full` payment is `current`; anything
 * short is `delinquent`. Recovers to `current` the next month a full payment lands.
 */
export function deriveLoanStatus(paymentStatus: PaymentStatus): LoanStatus {
  return paymentStatus === "full" ? "current" : "delinquent";
}

/**
 * Amortizing monthly payment using nominal monthly rate (APR / 12).
 * Matches the convention used in published mortgage/loan amortization tables.
 */
export function computeAmortizingPaymentCents(
  principalCents: Cents,
  apr: number,
  termMonths: number,
): Cents {
  if (termMonths <= 0) return 0;
  // Round the level payment UP to the cent so it always fully amortizes within
  // the term (a rounded-down payment leaves a residual that spills into an extra
  // month). The final payment is smaller — the projection caps it to the
  // remaining balance. This matches how lenders build amortization schedules.
  if (apr === 0) return Math.ceil(principalCents / termMonths);
  const r = apr / 12;
  const factor = Math.pow(1 + r, termMonths);
  return Math.ceil((principalCents * r * factor) / (factor - 1));
}

/**
 * Full amortization schedule: the exact payment for each of the `termMonths`
 * months. Every month charges the level payment (computeAmortizingPaymentCents)
 * except the final month, whose payment is reduced to exactly retire the
 * remaining balance — so the schedule ALWAYS pays the loan off to exactly 0,
 * with no rounding residual.
 *
 * This is the amortization analogue of splitAnnualToMonths: rather than applying
 * one rounded figure N times (which drifts), it returns the exact per-month
 * breakdown that lands on the target. The difference is that each month accrues
 * interest on the running balance, so the correction lands in the final payment
 * instead of being spread cumulatively.
 *
 * The interest accrual here (`round(bal * (1 + r))`) mirrors the projection loop
 * exactly, so the schedule matches what a simulation actually charges.
 */
export function amortizationScheduleCents(
  principalCents: Cents,
  apr: number,
  termMonths: number,
): Cents[] {
  if (termMonths <= 0) return [];
  const level = computeAmortizingPaymentCents(principalCents, apr, termMonths);
  const r = apr / 12;
  const schedule: Cents[] = [];
  let bal = principalCents;
  for (let m = 0; m < termMonths; m++) {
    const owed = Math.round(bal * (1 + r)); // balance after this month's interest
    const payment = Math.min(level, owed); // final month: pay exactly what's owed
    schedule.push(payment);
    bal = owed - payment; // reaches exactly 0 on the last payment
  }
  return schedule;
}

/** Minimum credit card payment: greater of 2% of balance or $25. Returns 0 if balance is 0. */
export function minCreditCardPaymentCents(balanceCents: Cents): Cents {
  if (balanceCents <= 0) return 0;
  return Math.max(Math.round(balanceCents * 0.02), 2500);
}

/** APR of the synthetic credit card used when no real card is entered (§5.1). */
export const SYNTHETIC_CREDIT_CARD_APR = 0.22;

/**
 * Default credit limit of the synthetic shortfall card (§5.1: "~22% APR, optional
 * default limit"). Finite by design: an unlimited card can never be exhausted, so
 * the §5.1 terminal HARD-INFEASIBILITY flag (`isInsolvent`) would never fire and a
 * plan financing itself on unbounded revolving debt would read as solvent (#36).
 * $50,000 is a plausible aggregate unsecured revolving limit — enough to absorb a
 * genuine month-to-month cash crunch, low enough that a plan borrowing to stay
 * afloat indefinitely runs out of credit and is flagged, which is the point.
 */
export const SYNTHETIC_CARD_CREDIT_LIMIT_CENTS: Cents = 50_000_00;

/** ID used in liabilityBalancesCents for the synthetic credit card. */
export const SYNTHETIC_CARD_ID = "synthetic-credit-card";

/**
 * The behaviour shared by every liability, independent of kind: identity, the
 * owed balance/rate/origination, one-time principal adjustments, and the
 * polymorphic monthly-payment hook the simulator drives.
 *
 * A liability is genuinely one of two things — an {@link AmortizingLoan} that
 * pays down over a fixed term, or a {@link RevolvingCard} that never amortizes
 * and carries a credit limit. Modelling them as separate classes off this base
 * removes the states that cannot exist (a card with a term, a loan with a limit,
 * a liability with neither) and lets the sim loop iterate a heterogeneous list
 * and call one polymorphic method instead of branching on kind.
 */
abstract class SimLiabilityBase {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: LiabilityKind;
  /** Amount owed when the loan originates (positive = owed). */
  readonly openingBalanceCents: Cents;
  /**
   * Absolute simulation month the loan originates (§4.3). Before it the balance
   * is 0; at it the balance is the opening balance; after it the loan amortizes.
   * Defaults to 0 (present from simulation start).
   */
  readonly startMonth: number;
  readonly apr: number;
  readonly liquid: false = false;

  /**
   * One-time principal adjustments against this liability — the future
   * DebtPayoffEvent (§4.3) lands here as a lump-sum payment. Applied by the
   * projection in step 10, before that month's interest accrues. Mirrors
   * Account's one-time-transfer primitive (§3.2). See addTransfer for the sign
   * convention. v1-seam: the paired cash outflow (this is money leaving a liquid
   * account) is the caller's responsibility — the engine only moves the owed
   * balance, so net-worth conservation requires attaching an Account outflow too.
   */
  private transfers: SimOneTimeTransfer[] = [];

  constructor(params: {
    id: string;
    ownerId: string;
    kind: LiabilityKind;
    openingBalanceCents: Cents;
    startMonth?: number;
    apr: number;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.kind = params.kind;
    this.openingBalanceCents = params.openingBalanceCents;
    this.startMonth = params.startMonth ?? 0;
    this.apr = params.apr;
  }

  /**
   * This month's payment given the current balance — the polymorphic seam that
   * replaces the old isCreditCard() branch in the sim loop. Both kinds cap the
   * payment at the payoff amount (balance + this month's interest) so a small
   * balance is never over-charged; a paid-off (≤ 0) balance pays nothing.
   */
  abstract monthlyPaymentCents(balanceCents: Cents, month: number): Cents;

  /** Balance grown by exactly this month's interest — the payoff-cap ceiling. */
  protected owedWithInterestCents(balanceCents: Cents): Cents {
    return Math.round(balanceCents * (1 + this.apr / 12));
  }

  /**
   * Schedule a one-time principal adjustment at `month`. Sign convention matches
   * Account.addTransfer: the amount is ADDED to the owed balance, so a lump-sum
   * PAYMENT is a NEGATIVE amountCents (a new draw would be positive), and a
   * proportionalFraction of -0.5 settles half the balance.
   */
  addTransfer(transfer: SimOneTimeTransfer): void {
    this.transfers.push(transfer);
    this.transfers.sort((a, b) => a.month - b.month);
  }

  /** All one-time transfers scheduled at exactly `month`. */
  getTransfersAt(month: number): SimOneTimeTransfer[] {
    return this.transfers.filter((t) => t.month === month);
  }
}

/**
 * A term loan (mortgage, auto, student loan) that amortizes to exactly 0 over a
 * fixed term. The exact per-month schedule is computed once at origination
 * (amortizationScheduleCents); the monthly payment is a lookup into it, capped
 * at the actual payoff so a lump-sum paydown that drops the balance below the
 * schedule's trajectory retires the loan early rather than over-charging (§4.3).
 */
export class AmortizingLoan extends SimLiabilityBase {
  readonly kind: Exclude<LiabilityKind, "creditCard">;
  readonly termMonths: number;
  /** Exact payment for each month of the term (final payment reduced to the payoff). */
  private readonly schedule: readonly Cents[];

  constructor(params: {
    id: string;
    ownerId: string;
    kind: Exclude<LiabilityKind, "creditCard">;
    openingBalanceCents: Cents;
    startMonth?: number;
    apr: number;
    termMonths: number;
  }) {
    super(params);
    this.kind = params.kind;
    this.termMonths = params.termMonths;
    this.schedule = amortizationScheduleCents(
      params.openingBalanceCents,
      params.apr,
      params.termMonths,
    );
  }

  monthlyPaymentCents(balanceCents: Cents, month: number): Cents {
    if (balanceCents <= 0) return 0;
    // The schedule counts from origination, so the first payment (index 0) falls
    // on startMonth+1; past the term it reads undefined → 0 (loan already retired).
    const scheduled = this.schedule[month - this.startMonth - 1] ?? 0;
    return Math.min(scheduled, this.owedWithInterestCents(balanceCents));
  }
}

/**
 * A revolving credit account (credit card) that never amortizes: a balance, an
 * APR, and a credit limit (null = unbounded). The monthly payment is the
 * balance-driven minimum (minCreditCardPaymentCents), capped at the payoff so a
 * near-zero balance is retired rather than over-charged. The synthetic shortfall
 * card (§5.1) is one of these, constructed with a finite default limit.
 */
export class RevolvingCard extends SimLiabilityBase {
  readonly kind = "creditCard";
  /** Credit limit in cents; null = unbounded. */
  readonly creditLimitCents: Cents | null;

  constructor(params: {
    id: string;
    ownerId: string;
    openingBalanceCents: Cents;
    startMonth?: number;
    apr: number;
    creditLimitCents?: Cents;
  }) {
    super({ ...params, kind: "creditCard" });
    this.creditLimitCents = params.creditLimitCents ?? null;
  }

  monthlyPaymentCents(balanceCents: Cents, _month: number): Cents {
    if (balanceCents <= 0) return 0;
    return Math.min(
      minCreditCardPaymentCents(balanceCents),
      this.owedWithInterestCents(balanceCents),
    );
  }
}

/** A liability in the simulator is exactly one of the two kinds. */
export type SimLiability = AmortizingLoan | RevolvingCard;
