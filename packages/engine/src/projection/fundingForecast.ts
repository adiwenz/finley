/**
 * A LIGHTWEIGHT annual answer to "if the household is short by this much over the coming year,
 * which accounts pay for it, and what taxable income does that realize?"
 *
 * This exists for one reason: the year-start tax estimate ({@link
 * import("./taxYearProjection").projectKnownTaxYear}) can read scheduled income straight off
 * compiled plan data, but a retired household's largest taxable income is not scheduled at all —
 * it is the pre-tax withdrawals the funding waterfall makes to pay for ordinary living. Leaving
 * those out made the estimate ~$0 and pushed the entire year's tax into the December
 * reconciliation, which is what put a recurring December spike in every decumulation plan.
 *
 * It is a FORECAST, not a second simulation. It answers only "how much from each account, and
 * how much of that is taxable", and deliberately reproduces none of the monthly machinery:
 * no month-by-month balances, no compounding, no snapshots, no event replay, no retirement
 * solving. The year's ACTUAL taxable income is still whatever the real waterfall does; the
 * December true-up ({@link import("./annualTaxSettlement").settleAnnualTax}) remains
 * authoritative and now simply has far less left to settle.
 *
 * Account priority is NOT redefined here — it comes from {@link
 * import("./withdrawal").orderedLiquidationAccounts}, the same ranking decumulation and the
 * settlement drain in. A forecast ranking accounts by its own rules would predict draws the
 * waterfall never makes, and the estimate would be confidently wrong instead of merely rough.
 */

import type { Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";

/** One account as the forecast sees it: what it holds, and how much of that is basis. */
export interface ForecastAccount {
  readonly id: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly balanceCents: Cents;
  readonly basisCents: Cents;
  /**
   * The liquid cash buffer. It is not SOLD to cover a gap — {@link
   * import("./withdrawal").buildWithdrawalSources} spends it directly as `liquidDrawdownCents`
   * and the shortfall cascade charges against it — so it realizes nothing, whatever its basis
   * and whatever the jurisdiction's withdrawal seam would say about an account of its category.
   * Forecasting a gain on it would invent taxable income the year will never have.
   */
  readonly liquidBuffer?: boolean;
}

/** One account's forecast contribution to the year's funding need. */
export interface ForecastDraw {
  readonly accountId: string;
  readonly ownerId: string;
  readonly category: TaxCategory;
  readonly grossCents: Cents;
  /** The realized gain within {@link grossCents} — for a pre-tax account, the whole of it. */
  readonly taxableCents: Cents;
}

export interface FundingForecast {
  readonly draws: readonly ForecastDraw[];
  /** `need` less what the accounts could actually cover; the household is short by this much. */
  readonly unfundedCents: Cents;
}

const NOTHING_FORECAST: FundingForecast = { draws: [], unfundedCents: 0 };

/**
 * Walk `ordered` — already in {@link import("./withdrawal").orderedLiquidationAccounts} order —
 * taking exactly what is left of `needCents` from each, capped at its balance, until the need is
 * covered. The annual analogue of one month of {@link
 * import("./withdrawal").buildWithdrawalSources}: same order, same "sell exactly the need"
 * sizing, same jurisdiction-owned basis/gain seam, just once for twelve months instead of
 * twelve times.
 *
 * PURE — reads balances, mutates nothing. The caller threads its own working balances if it
 * needs to forecast twice against the same accounts.
 *
 * No gross-up here either. The tax these draws cause is not netted out of them; it is solved
 * OUTSIDE this function, by the caller's fixed point over the whole year's need (see {@link
 * import("./taxYearProjection").projectKnownTaxYear}) — which is the annual analogue of what
 * really happens, where the tax is paid from the following months' funding need.
 */
export function forecastFundingDraws(
  needCents: Cents,
  ordered: readonly ForecastAccount[],
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
): FundingForecast {
  if (needCents <= 0) return NOTHING_FORECAST;

  const draws: ForecastDraw[] = [];
  let remaining = needCents;
  for (const account of ordered) {
    if (remaining <= 0) break;
    const balance = account.balanceCents;
    if (balance <= 0) continue;

    const basis = Math.max(0, account.basisCents);
    const gross = Math.min(balance, remaining);
    // The jurisdiction owns return-of-capital policy. The FALLBACK, when it declines the seam, is
    // deliberately `gross` — the whole draw taxable — because that is what {@link
    // import("./withdrawal").buildWithdrawalSources} falls back to, and this forecasts that
    // channel specifically. (The pro-rata split the explicit-funding path falls back to would
    // read a seamless jurisdiction's brokerage draw as tax-free and quietly under-estimate the
    // year by the whole balance.)
    const taxableCents = account.liquidBuffer === true
      ? 0
      : (jurisdiction.taxableWithdrawalCents?.(
          { grossCents: gross, basisCents: basis, balanceCents: balance, category: account.category },
          ctx,
        ) ?? gross);

    remaining -= gross;
    draws.push({
      accountId: account.id,
      ownerId: account.ownerId,
      category: account.category,
      grossCents: gross,
      taxableCents,
    });
  }

  return { draws, unfundedCents: Math.max(0, remaining) };
}
