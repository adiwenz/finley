/**
 * Liability — amortizing loan or revolving credit account.
 *
 * For amortizing kinds (mortgage, auto, studentLoan) the monthly payment is COMPUTED
 * from balance/rate/term, not entered as an expense line. With no card entered, the
 * simulator uses a synthetic card as the shortfall sink.
 */

import type { Cents } from "../money/money";
import type { SimOneTimeTransfer } from "../plan/simAccount";

export type LiabilityKind = "mortgage" | "auto" | "studentLoan" | "creditCard";

const LIABILITY_KIND_LABELS: Readonly<Record<LiabilityKind, string>> = {
  mortgage: "Mortgage",
  auto: "Auto loan",
  studentLoan: "Student loan",
  creditCard: "Credit card",
};

export function liabilityKindLabel(kind: LiabilityKind): string {
  return LIABILITY_KIND_LABELS[kind];
}

/**
 * v1-seam: only `full` is reachable — the projection always applies the exact scheduled
 * (payoff-capped) payment. `partial`/`missed` pre-exist so a future underpayment channel
 * needs no data-shape migration.
 */
export type PaymentStatus = "full" | "partial" | "missed";

/** v1-seam: only `current` is reachable; room is left for future `forbearance`/`default`. */
export type LoanStatus = "current" | "delinquent";

/**
 * `expectedCents` is the payoff-capped scheduled payment, NOT the raw amortization-table
 * level payment — so a legitimately smaller final payoff payment reads as `full`, not
 * `partial`.
 *
 * v1-seam: the call site passes the same figure for both arguments, so the result is
 * always `full`.
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
 * Derived purely from that month's payment status — no arrearage or past-due memory, so
 * a loan recovers the month a full payment lands.
 */
export function deriveLoanStatus(paymentStatus: PaymentStatus): LoanStatus {
  return paymentStatus === "full" ? "current" : "delinquent";
}

/**
 * Amortizing monthly payment using nominal monthly rate (APR / 12), the convention of
 * published mortgage/loan amortization tables.
 */
export function computeAmortizingPaymentCents(
  principalCents: Cents,
  apr: number,
  termMonths: number,
): Cents {
  if (termMonths <= 0) return 0;
  // Rounded UP so it fully amortizes within the term; rounding down leaves a residual
  // that spills into an extra month. The final payment is capped to the balance.
  if (apr === 0) return Math.ceil(principalCents / termMonths);
  const r = apr / 12;
  const factor = Math.pow(1 + r, termMonths);
  return Math.ceil((principalCents * r * factor) / (factor - 1));
}

/**
 * The level payment every month, reduced in the final month, so the schedule ALWAYS pays
 * off to exactly 0 with no rounding residual. The accrual (`round(bal * (1 + r))`) mirrors
 * the projection loop, so the schedule matches what a simulation charges.
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
    const owed = Math.round(bal * (1 + r));
    const payment = Math.min(level, owed); // final month: pay exactly what's owed
    schedule.push(payment);
    bal = owed - payment;
  }
  return schedule;
}

/** The greater of 2% of the balance or a $25 floor. */
export function minCreditCardPaymentCents(balanceCents: Cents): Cents {
  if (balanceCents <= 0) return 0;
  return Math.max(Math.round(balanceCents * 0.02), 2500);
}

export const SYNTHETIC_CREDIT_CARD_APR = 0.22;

/**
 * Finite by design: an unlimited card can never be exhausted, so `isInsolvent` would never
 * fire. $50,000 is a plausible aggregate unsecured revolving limit — enough to absorb a
 * real month-to-month crunch, low enough that indefinite borrowing runs out and is flagged.
 */
export const SYNTHETIC_CARD_CREDIT_LIMIT_CENTS: Cents = 50_000_00;

/** Key for the synthetic card in `liabilityBalancesCents`. */
export const SYNTHETIC_CARD_ID = "synthetic-credit-card";

/**
 * Separate {@link AmortizingLoan} and {@link RevolvingCard} subclasses remove the
 * impossible states (a card with a term, a loan with a limit, a liability with neither) and
 * let the sim loop call one method instead of branching on kind.
 */
abstract class SimLiabilityBase {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: LiabilityKind;
  /** Positive = owed. */
  readonly openingBalanceCents: Cents;
  /**
   * Absolute simulation month of origination: balance 0 before it, the opening balance at
   * it, amortizing after. Defaults to 0, present from simulation start.
   */
  readonly startMonth: number;
  readonly apr: number;
  readonly liquid: false = false;

  /**
   * Applied by the projection in step 10, before that month's interest accrues; see
   * addTransfer for the sign convention. v1-seam: the engine only moves the owed balance,
   * so net-worth conservation needs the caller to attach the paired Account outflow.
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
   * Both kinds cap the payment at the payoff amount (balance + this month's interest); a
   * balance ≤ 0 pays nothing.
   */
  abstract monthlyPaymentCents(balanceCents: Cents, month: number): Cents;

  /** Balance grown by exactly this month's interest — the payoff-cap ceiling. */
  protected owedWithInterestCents(balanceCents: Cents): Cents {
    return Math.round(balanceCents * (1 + this.apr / 12));
  }

  /**
   * Sign convention matches Account.addTransfer: the amount is ADDED to the owed balance,
   * so a lump-sum PAYMENT is NEGATIVE (a new draw positive), and proportionalFraction -0.5
   * settles half.
   */
  addTransfer(transfer: SimOneTimeTransfer): void {
    this.transfers.push(transfer);
    this.transfers.sort((a, b) => a.month - b.month);
  }

  getTransfersAt(month: number): SimOneTimeTransfer[] {
    return this.transfers.filter((t) => t.month === month);
  }
}

/**
 * The schedule is computed once at origination and the monthly payment is a lookup into it,
 * capped at the actual payoff so a lump-sum paydown retires the loan early.
 */
export class AmortizingLoan extends SimLiabilityBase {
  readonly kind: Exclude<LiabilityKind, "creditCard">;
  readonly termMonths: number;
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
    // The schedule counts from origination: index 0 is startMonth+1. Past the term it
    // reads undefined → 0 (loan already retired).
    const scheduled = this.schedule[month - this.startMonth - 1] ?? 0;
    return Math.min(scheduled, this.owedWithInterestCents(balanceCents));
  }
}

/** Never amortizes; pays the balance-driven minimum. The synthetic shortfall card is one. */
export class RevolvingCard extends SimLiabilityBase {
  readonly kind = "creditCard";
  /** null = no limit entered — funding treats this as zero usable headroom, never as unbounded. */
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

export type SimLiability = AmortizingLoan | RevolvingCard;
