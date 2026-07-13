/**
 * Account — asset or liability with a rate-segment series and one-time transfers.
 *
 * §3.1: The rate is NOT a fixed scalar; use addRateChange to model "moved to a
 * conservative allocation at month M." The compounding step in the simulator
 * applies preciseMonthlyRate(rateAt(m)) once per month, unconditionally.
 *
 * §3.2: One-time transfers (influx / outflow) are first-class actions. They move
 * money at their month; they never apply growth — the compounding step (§0.2)
 * starts from the post-transfer balance.
 *
 * Liabilities (mortgage, auto, student loan, credit card) are Slice 2 (#3).
 */

import type { Cents } from "./money";
import { preciseMonthlyRate } from "./cashFlowSeries";

/** v1-seam: distinguishes how withdrawals/contributions are taxed. */
export type TaxTreatment = "preTax" | "roth" | "taxable";

/** Contiguous rate period. Rate changes create new segments from that month forward. */
interface RateSegment {
  startMonth: number;
  annualRate: number;
}

/**
 * A one-time transfer applied to an account at the given month.
 *
 * Fixed: amountCents > 0 = influx, < 0 = outflow.
 * Proportional: proportionalFraction of the account's balance at that month
 *   (e.g., -0.2 applies a 20% loss — useful for modelling a market crash).
 * Both may be combined; total applied = amountCents + round(balance * fraction).
 */
export interface OneTimeTransfer {
  readonly month: number;
  readonly amountCents?: Cents;
  readonly proportionalFraction?: number;
}

export class Account {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: "asset";
  /** liquid=true: eligible to receive net cash flow from the allocation waterfall. */
  readonly liquid: boolean;
  /** v1-seam: tax treatment for future withdrawal routing. */
  readonly taxTreatment: TaxTreatment;
  readonly openingBalanceCents: Cents;

  private rateSegments: RateSegment[];
  private transfers: OneTimeTransfer[] = [];

  constructor(params: {
    id: string;
    ownerId: string;
    liquid: boolean;
    taxTreatment: TaxTreatment;
    openingBalanceCents: Cents;
    initialAnnualRate: number;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.kind = "asset";
    this.liquid = params.liquid;
    this.taxTreatment = params.taxTreatment;
    this.openingBalanceCents = params.openingBalanceCents;
    this.rateSegments = [{ startMonth: 0, annualRate: params.initialAnnualRate }];
  }

  /** Override the annual return rate from `month` forward. */
  addRateChange(month: number, newAnnualRate: number): void {
    this.rateSegments = this.rateSegments.filter((s) => s.startMonth < month);
    this.rateSegments.push({ startMonth: month, annualRate: newAnnualRate });
    this.rateSegments.sort((a, b) => a.startMonth - b.startMonth);
  }

  /** The annual return rate in effect at `month`. */
  getRateAt(month: number): number {
    let rate = this.rateSegments[0].annualRate;
    for (const seg of this.rateSegments) {
      if (seg.startMonth <= month) rate = seg.annualRate;
      else break;
    }
    return rate;
  }

  /** Precise monthly compounding rate for the given absolute month. */
  getMonthlyRateAt(month: number): number {
    return preciseMonthlyRate(this.getRateAt(month));
  }

  addTransfer(transfer: OneTimeTransfer): void {
    this.transfers.push(transfer);
    this.transfers.sort((a, b) => a.month - b.month);
  }

  /**
   * A copy of this account with extra one-time transfers attached — used at the
   * simulation boundary to fold in ledger-derived payoff outflows without
   * reconstructing the account from a subset of its state (§5). Preserves the
   * full rate-segment history and any existing transfers.
   */
  withAdditionalTransfers(transfers: readonly OneTimeTransfer[]): Account {
    const clone = new Account({
      id: this.id,
      ownerId: this.ownerId,
      liquid: this.liquid,
      taxTreatment: this.taxTreatment,
      openingBalanceCents: this.openingBalanceCents,
      initialAnnualRate: this.rateSegments[0].annualRate,
    });
    clone.rateSegments = this.rateSegments.map((s) => ({ ...s }));
    clone.transfers = [...this.transfers, ...transfers].sort((a, b) => a.month - b.month);
    return clone;
  }

  /** All one-time transfers scheduled at exactly `month`. */
  getTransfersAt(month: number): OneTimeTransfer[] {
    return this.transfers.filter((t) => t.month === month);
  }
}
