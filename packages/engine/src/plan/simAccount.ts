/**
 * The simulator's compiled asset: a rate-segment series plus one-time transfers.
 * Engine-internal, compiled from the authoring {@link import("./account").Account}; the
 * API never constructs it directly. Liabilities are modeled separately.
 *
 * Compounding applies `preciseMonthlyRate(rateAt(m))` once per month, unconditionally. A
 * one-time transfer lands first, so compounding starts from the post-transfer balance.
 */

import type { Cents } from "../money/money";
import { preciseMonthlyRate, type TaxCategory } from "../money/cashFlowSeries";

/**
 * The neutral KIND of return an account produces — an economic fact, not a tax rule.
 * "interest": a currently-taxable cash yield (bank / money-market balance).
 * "appreciation": an unrealized capital gain. The JURISDICTION owns whether/when/how it
 * is taxed ({@link import("../jurisdiction/jurisdiction").Jurisdiction.returnTaxTreatment}).
 */
export type AccountReturnKind = "interest" | "appreciation";

/**
 * **What holding this account still defers** — a property of the STOCK, and the only thing the
 * drawdown order ranks on ({@link
 * import("../projection/withdrawal").orderedLiquidationAccounts}).
 *
 * Deliberately not a {@link TaxCategory}. That vocabulary describes a FLOW — what money is when it
 * arrives — and the two answer different questions about the same account: a traditional 401(k)
 * pays `ordinaryIncome` (which is what the brackets need to know) and is `taxDeferred` (which is
 * why it is drawn third). Ranking on the flow category worked only while every account happened to
 * have a distinct one, and it silently mis-ranked the moment two did not.
 *
 *  - `taxedAtAccrual` — a cash balance, taxed as its interest is credited. Holding it defers
 *    nothing at all.
 *  - `taxable` — a taxable investment: the gain is deferred until sale, then taxed at whatever
 *    preference the jurisdiction gives it.
 *  - `taxDeferred` — pre-tax: contributions and growth untaxed until withdrawal, then ordinary.
 *  - `taxExempt` — never taxed. Holding it compounds that, which is why it is drawn last.
 */
export type AccountTaxTreatment = "taxedAtAccrual" | "taxable" | "taxDeferred" | "taxExempt";

/**
 * An account's tax *behavior* in engine terms (seam 2), never a jurisdiction's branded
 * vehicle name; the jurisdiction owns the *consequence*.
 */
export interface SimAccountTaxProfile {
  /** The FLOW question: what a withdrawal from here IS, for the jurisdiction to price. */
  readonly withdrawalCategory: TaxCategory;
  /** The STOCK question: what holding it defers, and so where it sits in the drawdown order. */
  readonly taxTreatment: AccountTaxTreatment;
  /** Whether contributions reduce current taxable income. */
  readonly contributionsPreTax: boolean;
  /** Subject to jurisdiction forced distributions (RMD-like). */
  readonly forcedDistributionEligible: boolean;
  /**
   * Absent or "appreciation" → an unrealized gain, deferred to withdrawal and taxed there
   * against cost basis. The engine owns the accrual bookkeeping; accrual-vs-realization
   * timing and the income category live in `rules`.
   */
  readonly returnKind?: AccountReturnKind;
}

/**
 * The account tax profiles the plan→projection mapping instantiates (see
 * `projectionBase.ts`), exported so the mapping and tests share one neutral definition:
 * {@link CAPITAL_GAINS_TAX_PROFILE} brokerage / goal fund, {@link PRE_TAX_TAX_PROFILE}
 * tax-deferred retirement account, {@link CASH_INTEREST_TAX_PROFILE} cash buffer,
 * {@link TAX_EXEMPT_TAX_PROFILE} genuine tax-exempt vehicle.
 */
export const CAPITAL_GAINS_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "capitalGains",
  taxTreatment: "taxable",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
  // Stated rather than left absent, so the deferral is the JURISDICTION's call through
  // `returnTaxTreatment`: a mark-to-market regime could tax at accrual instead.
  returnKind: "appreciation",
};

export const PRE_TAX_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "ordinaryIncome",
  taxTreatment: "taxDeferred",
  contributionsPreTax: true,
  forcedDistributionEligible: true,
};

/**
 * The return is bank interest the jurisdiction may tax at accrual whether or not the buffer
 * is ever withdrawn — which is exactly why the withdrawal itself is tax-free. Distinct from
 * {@link TAX_EXEMPT_TAX_PROFILE}, whose growth is genuinely never taxed, and the withdrawal
 * category says so: holding this buys nothing, so nothing is lost by spending it first.
 */
export const CASH_INTEREST_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "taxedAtAccrual",
  taxTreatment: "taxedAtAccrual",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
  returnKind: "interest",
};

export const TAX_EXEMPT_TAX_PROFILE: SimAccountTaxProfile = {
  withdrawalCategory: "taxExempt",
  taxTreatment: "taxExempt",
  contributionsPreTax: false,
  forcedDistributionEligible: false,
};

interface RateSegment {
  startMonth: number;
  annualRate: number;
}

/**
 * `amountCents` > 0 = influx, < 0 = outflow; `proportionalFraction` takes that share of the
 * balance then (-0.2 = a 20% loss). Both may combine: applied = amountCents +
 * round(balance * fraction).
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
   * Diagnostic only — nothing in the simulation reads it, but it rides through to the
   * per-source income flow view so a decumulation draw names *which* account is drained
   * rather than an anonymous tax bucket. Absent → reporting falls back to the account id.
   */
  readonly label?: string;
  /** liquid=true: eligible to receive net cash flow from the allocation waterfall. */
  readonly liquid: boolean;
  /**
   * Passes DIRECTLY to a named beneficiary at death, outside the estate — so it is neither
   * available to pay the final tax bill and the debts left behind, nor at risk from them
   * ({@link import("../projection/estateSettlement").settleEstate}). True for retirement
   * vehicles, false for cash and ordinary taxable holdings.
   *
   * Orthogonal to {@link liquid}, which is about receiving the waterfall's surplus: a taxable
   * brokerage account is illiquid in that sense and still squarely in the estate.
   *
   * Defaults to false — in the estate. Every account the plan compiles states it explicitly
   * ({@link import("../compile/projectionBase").buildPlanAccounts}), so the default is only ever
   * reached by a hand-built engine fixture, which reads it only if it also declares a household
   * death month.
   */
  readonly beneficiaryDesignated: boolean;
  readonly taxProfile: SimAccountTaxProfile;
  readonly openingBalanceCents: Cents;

  private rateSegments: RateSegment[];
  private transfers: SimOneTimeTransfer[] = [];

  constructor(params: {
    id: string;
    ownerId: string;
    label?: string;
    liquid: boolean;
    beneficiaryDesignated?: boolean;
    taxProfile: SimAccountTaxProfile;
    openingBalanceCents: Cents;
    initialAnnualRate: number;
  }) {
    this.id = params.id;
    this.ownerId = params.ownerId;
    this.kind = "asset";
    this.label = params.label;
    this.liquid = params.liquid;
    this.beneficiaryDesignated = params.beneficiaryDesignated ?? false;
    this.taxProfile = params.taxProfile;
    this.openingBalanceCents = params.openingBalanceCents;
    this.rateSegments = [{ startMonth: 0, annualRate: params.initialAnnualRate }];
  }

  /** Overrides the rate from `month` forward, discarding any later segments. */
  addRateChange(month: number, newAnnualRate: number): void {
    this.rateSegments = this.rateSegments.filter((s) => s.startMonth < month);
    this.rateSegments.push({ startMonth: month, annualRate: newAnnualRate });
    this.rateSegments.sort((a, b) => a.startMonth - b.startMonth);
  }

  getRateAt(month: number): number {
    let rate = this.rateSegments[0].annualRate;
    for (const seg of this.rateSegments) {
      if (seg.startMonth <= month) rate = seg.annualRate;
      else break;
    }
    return rate;
  }

  /**
   * One entry per segment, ascending by `startMonth`. A glide path or mid-run rate cut
   * carries more than one, which `getRateAt(0)` would hide.
   */
  rateSchedule(): readonly { startMonth: number; annualRate: number }[] {
    return this.rateSegments.map((s) => ({ startMonth: s.startMonth, annualRate: s.annualRate }));
  }

  getMonthlyRateAt(month: number): number {
    return preciseMonthlyRate(this.getRateAt(month));
  }

  addTransfer(transfer: SimOneTimeTransfer): void {
    this.transfers.push(transfer);
    this.transfers.sort((a, b) => a.month - b.month);
  }

  /**
   * A copy with extra transfers attached — folds ledger-derived payoff outflows in at the
   * simulation boundary, preserving the full rate-segment history and existing transfers.
   */
  withAdditionalTransfers(transfers: readonly SimOneTimeTransfer[]): SimAccount {
    const clone = new SimAccount({
      id: this.id,
      ownerId: this.ownerId,
      label: this.label,
      liquid: this.liquid,
      beneficiaryDesignated: this.beneficiaryDesignated,
      taxProfile: this.taxProfile,
      openingBalanceCents: this.openingBalanceCents,
      initialAnnualRate: this.rateSegments[0].annualRate,
    });
    clone.rateSegments = this.rateSegments.map((s) => ({ ...s }));
    clone.transfers = [...this.transfers, ...transfers].sort((a, b) => a.month - b.month);
    return clone;
  }

  getTransfersAt(month: number): SimOneTimeTransfer[] {
    return this.transfers.filter((t) => t.month === month);
  }
}
