/**
 * SimAccount — the simulator's compiled asset: a rate-segment series plus one-time
 * transfers. Engine-internal, compiled from the authoring
 * {@link import("./account").Account}; the API never constructs it directly.
 *
 * The rate is NOT a fixed scalar — addRateChange models "moved to a conservative
 * allocation at month M"; compounding applies preciseMonthlyRate(rateAt(m)) once per
 * month, unconditionally. One-time transfers move money at their month and never grow:
 * compounding starts from the post-transfer balance.
 *
 * Liabilities (mortgage, auto, student loan, credit card) are modeled separately.
 */

import type { Cents } from "./money";
import { preciseMonthlyRate, type TaxCategory } from "./cashFlowSeries";

/**
 * The neutral KIND of return an account produces — an economic fact, not a tax rule.
 * "interest": a currently-taxable cash yield (bank / money-market balance).
 * "appreciation": an unrealized capital gain. The JURISDICTION owns whether/when/how it
 * is taxed ({@link import("./jurisdiction").Jurisdiction.returnTaxTreatment}).
 */
export type AccountReturnKind = "interest" | "appreciation";

/**
 * An account's tax *behavior* in engine terms (seam 2), never a jurisdiction's branded
 * vehicle name. The account states what kind of flow a withdrawal produces and how
 * contributions and forced distributions behave; the jurisdiction owns the *consequence*.
 */
export interface SimAccountTaxProfile {
  /** The {@link TaxCategory} that withdrawals from this account produce. */
  readonly withdrawalCategory: TaxCategory;
  /** Whether contributions reduce current taxable income (tax-deferred in). */
  readonly contributionsPreTax: boolean;
  /** Whether the account is subject to jurisdiction forced distributions (RMD-like). */
  readonly forcedDistributionEligible: boolean;
  /**
   * The KIND of return this account produces ({@link AccountReturnKind}). "interest"
   * marks a cash buffer whose return the jurisdiction may tax at accrual; absent or
   * "appreciation" → an unrealized gain, deferred to withdrawal and taxed there against
   * cost basis. The engine owns the accrual bookkeeping; accrual-vs-realization timing and
   * the income category live in `rules`, via
   * {@link import("./jurisdiction").Jurisdiction.returnTaxTreatment}.
   */
  readonly returnKind?: AccountReturnKind;
}

/**
 * The account tax profiles the plan→projection mapping instantiates (see
 * `projectionBase.ts`), exported so the mapping and tests share one neutral definition.
 *
 * {@link CAPITAL_GAINS_TAX_PROFILE}: brokerage / goal fund (post-tax in, capital-gains
 * out, no forced draw). {@link PRE_TAX_TAX_PROFILE}: tax-deferred retirement account
 * (tax-deferred in, ordinary-income out, forced-distribution eligible).
 * {@link CASH_INTEREST_TAX_PROFILE}: cash buffer whose RETURN is interest booked at
 * accrual, which is precisely why its withdrawal is tax-free.
 * {@link TAX_EXEMPT_TAX_PROFILE}: a genuine tax-exempt vehicle (post-tax in, tax-free
 * out, growth never taxed).
 */
export const CAPITAL_GAINS_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "capitalGains",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
  // Stated explicitly rather than left absent, so the deferral is the JURISDICTION's call
  // through `returnTaxTreatment`, not a default-by-omission: US defers to withdrawal, a
  // mark-to-market regime could tax at accrual. Behaviour under US is unchanged.
  returnKind: "appreciation",
};

export const PRE_TAX_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "ordinaryIncome",
  contributionsPreTax: true,
  forcedDistributionEligible: true,
};

/**
 * Cash buffer / savings: post-tax in, return is bank interest the jurisdiction may tax at
 * accrual whether or not the buffer is ever withdrawn — which is exactly why the withdrawal
 * itself is tax-free. Distinct from {@link TAX_EXEMPT_TAX_PROFILE}, whose growth is
 * genuinely never taxed. The interest's timing and income category live in `rules`.
 */
export const CASH_INTEREST_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "taxExempt",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
  returnKind: "interest",
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
 * A one-time transfer applied at the given month. `amountCents` > 0 = influx, < 0 =
 * outflow; `proportionalFraction` takes that share of the balance then (-0.2 = a 20% loss,
 * for a market crash). Both may combine: applied = amountCents + round(balance * fraction).
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
  /**
   * Human-facing name ("Cash savings", "Brokerage", a goal's own name). Diagnostic only:
   * nothing in the simulation reads it, but it rides through to the per-source income flow
   * view so a decumulation draw names *which* account is drained rather than an anonymous
   * tax bucket. Absent → reporting falls back to the account id.
   */
  readonly label?: string;
  /** liquid=true: eligible to receive net cash flow from the allocation waterfall. */
  readonly liquid: boolean;
  /** Neutral tax behavior for withdrawal routing / forced distributions (seam 2). */
  readonly taxProfile: SimAccountTaxProfile;
  readonly openingBalanceCents: Cents;

  private rateSegments: RateSegment[];
  private transfers: SimOneTimeTransfer[] = [];

  constructor(params: {
    id: string;
    ownerId: string;
    label?: string;
    liquid: boolean;
    taxProfile: SimAccountTaxProfile;
    openingBalanceCents: Cents;
    initialAnnualRate: number;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.kind = "asset";
    this.label = params.label;
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
   * The whole return-rate schedule, one entry per segment, ascending by `startMonth`. A
   * glide path or mid-run rate cut carries more than one — `getRateAt(0)` would hide
   * the rest.
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
   * A copy with extra one-time transfers attached — folds ledger-derived payoff outflows
   * in at the simulation boundary without reconstructing the account from a subset of its
   * state. Preserves the full rate-segment history and any existing transfers.
   */
  withAdditionalTransfers(transfers: readonly SimOneTimeTransfer[]): SimAccount {
    const clone = new SimAccount({
      id: this.id,
      ownerId: this.ownerId,
      label: this.label,
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
