/**
 * SimAccount — the simulator's compiled asset with a rate-segment series and
 * one-time transfers. Engine-internal, produced by compiling the authoring
 * {@link import("./account").Account}; the API never constructs it directly.
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
import { preciseMonthlyRate, type TaxCategory } from "./cashFlowSeries";

/**
 * A neutral, structured description of an account's tax *behavior* (§5.3 seam 2) —
 * the engine's mechanics need behavior, never a jurisdiction's branded vehicle
 * name. The jurisdiction owns the tax *consequence*; the account only states, in
 * engine terms, what kind of flow a withdrawal produces and how contributions /
 * forced-distributions behave.
 */
export interface SimAccountTaxProfile {
  /** The {@link TaxCategory} that withdrawals from this account produce. */
  readonly withdrawalCategory: TaxCategory;
  /** Whether contributions reduce current taxable income (tax-deferred in). */
  readonly contributionsPreTax: boolean;
  /** Whether the account is subject to jurisdiction forced distributions (RMD-like). */
  readonly forcedDistributionEligible: boolean;
  /**
   * When set, the account's periodic RETURN is currently-taxable income of this
   * category — bank interest on a cash buffer, taxed in the year it is credited
   * (§#94) — booked at accrual, NOT deferred as an unrealized gain taxed at
   * withdrawal. Absent (the default) → the return is deferred: a brokerage books
   * its gain at withdrawal against cost basis, a pre-tax account books the whole
   * draw, a genuine tax-exempt vehicle books nothing. This is engine-neutral
   * BEHAVIOR — the jurisdiction still owns the rate on {@link returnTaxCategory}.
   */
  readonly returnTaxCategory?: TaxCategory;
}

/**
 * The two account tax profiles the plan→projection mapping instantiates today
 * (see `projectionBase.ts`) — exported so the mapping and tests share one neutral
 * definition rather than re-deriving the behavior-preserving map by hand.
 *
 * {@link CAPITAL_GAINS_TAX_PROFILE} is a brokerage / goal fund (post-tax in,
 * capital-gains out, no forced draw); {@link PRE_TAX_TAX_PROFILE} is a
 * tax-deferred retirement account (tax-deferred in, ordinary-income out,
 * forced-distribution eligible). {@link CASH_INTEREST_TAX_PROFILE} is the cash
 * buffer / savings account — its RETURN is taxable interest booked at accrual,
 * which is precisely why its withdrawal is tax-free. {@link TAX_EXEMPT_TAX_PROFILE}
 * is a genuine tax-exempt vehicle (post-tax in, tax-free out, growth never taxed).
 */
export const CAPITAL_GAINS_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "capitalGains",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
};

export const PRE_TAX_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "ordinaryIncome",
  contributionsPreTax: true,
  forcedDistributionEligible: true,
};

/**
 * The cash buffer / savings profile (§#94): post-tax in, and its return is bank
 * interest — currently-taxable ordinary income booked in the year it is credited,
 * whether or not the buffer is ever withdrawn. That accrual taxation is exactly why
 * the withdrawal itself is tax-free. Distinct from {@link TAX_EXEMPT_TAX_PROFILE},
 * whose growth is genuinely never taxed (a Roth-like vehicle).
 */
export const CASH_INTEREST_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "taxExempt",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
  returnTaxCategory: "ordinaryIncome",
};

export const TAX_EXEMPT_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "taxExempt",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
};

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
export interface SimOneTimeTransfer {
  readonly month: number;
  readonly amountCents?: Cents;
  readonly proportionalFraction?: number;
}

export class SimAccount {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: "asset";
  /** liquid=true: eligible to receive net cash flow from the allocation waterfall. */
  readonly liquid: boolean;
  /** Neutral tax behavior for withdrawal routing / forced distributions (§5.3 seam 2). */
  readonly taxProfile: SimAccountTaxProfile;
  readonly openingBalanceCents: Cents;

  private rateSegments: RateSegment[];
  private transfers: SimOneTimeTransfer[] = [];

  constructor(params: {
    id: string;
    ownerId: string;
    liquid: boolean;
    taxProfile: SimAccountTaxProfile;
    openingBalanceCents: Cents;
    initialAnnualRate: number;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.kind = "asset";
    this.liquid = params.liquid;
    this.taxProfile = params.taxProfile;
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

  /**
   * The whole return-rate schedule, one entry per segment, ascending by
   * `startMonth`. An account whose rate is changed mid-run (a glide path, a rate
   * cut) carries more than one — reporting only `getRateAt(0)` would hide the rest.
   */
  rateSchedule(): readonly { startMonth: number; annualRate: number }[] {
    return this.rateSegments.map((s) => ({ startMonth: s.startMonth, annualRate: s.annualRate }));
  }

  /** Precise monthly compounding rate for the given absolute month. */
  getMonthlyRateAt(month: number): number {
    return preciseMonthlyRate(this.getRateAt(month));
  }

  addTransfer(transfer: SimOneTimeTransfer): void {
    this.transfers.push(transfer);
    this.transfers.sort((a, b) => a.month - b.month);
  }

  /**
   * A copy of this account with extra one-time transfers attached — used at the
   * simulation boundary to fold in ledger-derived payoff outflows without
   * reconstructing the account from a subset of its state (§5). Preserves the
   * full rate-segment history and any existing transfers.
   */
  withAdditionalTransfers(transfers: readonly SimOneTimeTransfer[]): SimAccount {
    const clone = new SimAccount({
      id: this.id,
      ownerId: this.ownerId,
      liquid: this.liquid,
      taxProfile: this.taxProfile,
      openingBalanceCents: this.openingBalanceCents,
      initialAnnualRate: this.rateSegments[0].annualRate,
    });
    clone.rateSegments = this.rateSegments.map((s) => ({ ...s }));
    clone.transfers = [...this.transfers, ...transfers].sort((a, b) => a.month - b.month);
    return clone;
  }

  /** All one-time transfers scheduled at exactly `month`. */
  getTransfersAt(month: number): SimOneTimeTransfer[] {
    return this.transfers.filter((t) => t.month === month);
  }
}
