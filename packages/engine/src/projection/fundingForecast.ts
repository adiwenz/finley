/**
 * A LIGHTWEIGHT annual answer to "if the household is short by this much over the coming year,
 * which accounts pay for it, and what taxable income does that realize?"
 *
 * This exists for one reason: the year-start tax estimate ({@link
 * import("./taxYearProjection").projectKnownTaxYear}) can read scheduled income straight off
 * compiled plan data, but a retired household's largest taxable income is not scheduled at all —
 * it is the pre-tax withdrawals the funding waterfall makes to pay for ordinary living. Leaving
 * those out made the estimate ~$0 and left the entire year's tax to the year-end balance, which
 * is what deferred nearly every decumulating household's whole tax bill by a year.
 *
 * It is a FORECAST, not a second simulation. It answers only "how much from each account, and
 * how much of that is taxable", and deliberately reproduces almost none of the monthly machinery:
 * no snapshots, no event replay, no liabilities, no properties, no retirement solving, and it
 * never re-enters `simulateHousehold`. The year's ACTUAL taxable income is still whatever the
 * real waterfall does; the year's close ({@link
 * import("./taxYearSettlement").finalizeTaxYear}) remains authoritative and now simply has far
 * less left to carry into the next April.
 *
 * **It does walk the twelve months, and it does compound.** The one thing it cannot get right by
 * looking at January alone is how much an account can supply, because an account goes on earning
 * while it is being spent: a retirement balance opening at $82,092 funded $84,568 of withdrawals
 * over its final year, $2,476 more than it ever contained at once. Capping the year's draw at the
 * opening balance therefore understated the last year of every decumulating plan by exactly the
 * growth earned before depletion, and left that slice's tax — $549.67 on the default plan — for
 * the following April to charge as a lone spike after the household had stopped paying tax at all.
 * So each month applies the account's configured growth and then subtracts that month's share of
 * the need, in the same order the waterfall would. A depleted account compounds nothing, which is
 * what stops the walk from inventing a balance that was spent in March.
 *
 * That is twelve multiplications per account, not a second projection: no state is threaded out,
 * nothing is snapshotted, and the tax/funding circularity is still solved OUTSIDE this function by
 * the caller's fixed point ({@link import("./taxYearProjection").projectKnownTaxYear}).
 *
 * Account priority is NOT redefined here — it comes from {@link
 * import("./withdrawal").orderedLiquidationAccounts}, the same ranking decumulation itself drains
 * in. A forecast ranking accounts by its own rules would predict draws the waterfall never makes,
 * and the estimate would be confidently wrong instead of merely rough.
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
  /**
   * The account's own monthly growth rates for the twelve forecast months, in order — exactly
   * what {@link import("../plan/simAccount").SimAccount.getMonthlyRateAt} returns for each, so a
   * rate schedule that steps mid-year is honoured rather than flattened to January's.
   *
   * Absent means a flat, non-growing account: every existing caller and fixture that omits it
   * gets the old behaviour, and a zero-return account is unaffected either way.
   */
  readonly monthlyRates?: readonly number[];
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

/** The forecast horizon: one tax year, walked a month at a time. */
const FORECAST_MONTHS = 12;

/**
 * Month `m`'s share of an annual figure, integer cents, the twelve shares summing to exactly
 * `annualCents`. Even by design and not by accident: the tax half of the need really is paid in
 * twelve even instalments ({@link import("./federalIncomeTax").MONTHS_IN_TAX_YEAR}), and ordinary
 * living costs are close enough to even that shaping them would be false precision in a forecast
 * that already rounds the year's income to the nearest scheduled dollar.
 */
function monthShareCents(annualCents: Cents, month: number): Cents {
  return (
    Math.round((annualCents * (month + 1)) / FORECAST_MONTHS) -
    Math.round((annualCents * month) / FORECAST_MONTHS)
  );
}

/**
 * Walk twelve months over `ordered` — already in {@link
 * import("./withdrawal").orderedLiquidationAccounts} order — growing each account by its own rate
 * and then taking what is left of that month's share of `needCents` from each in turn, until the
 * year's need is covered or the accounts are dry. The annual analogue of twelve months of {@link
 * import("./withdrawal").buildWithdrawalSources}: same order, same "sell exactly the need"
 * sizing, same jurisdiction-owned basis/gain seam.
 *
 * **Draw, then grow**, matching the simulator's own pipeline — the funding waterfall runs in steps
 * 3–7 and `compoundAssets` in step 9, so a month's spending never earns that month's return. Get
 * this backwards and the forecast credits a full extra month of growth on money already spent.
 *
 * A month's unmet need CARRIES to the next rather than being dropped, so an account that is
 * temporarily short does not silently shrink the year's forecast draw; what is still unmet after
 * December is {@link FundingForecast.unfundedCents}.
 *
 * Basis falls with the balance, at whatever rate the seam's own answer implies: the part of a draw
 * that was NOT taxable is precisely the capital returned, so subtracting it is the pro-rata model
 * without restating it here. Growth raises the balance and not the basis, which is exactly what
 * `compoundAssets` does — and is why the gain in a drawn-down account keeps rising.
 *
 * PURE — reads balances, mutates nothing, threads its own working copies. Twelve iterations over
 * a handful of accounts: no snapshots, no events, no liabilities, no second simulation.
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

  // Working copies, one entry per account, parallel to `ordered`.
  const balances = ordered.map((a) => Math.max(0, a.balanceCents));
  const bases = ordered.map((a) => Math.max(0, a.basisCents));
  const grossByAccount = ordered.map(() => 0);
  const taxableByAccount = ordered.map(() => 0);

  let carriedNeed = 0;
  for (let month = 0; month < FORECAST_MONTHS; month++) {
    let remaining = monthShareCents(needCents, month) + carriedNeed;

    for (let i = 0; i < ordered.length; i++) {
      if (remaining <= 0) break;
      const balance = balances[i]!;
      if (balance <= 0) continue;
      const account = ordered[i]!;

      const gross = Math.min(balance, remaining);
      // The jurisdiction owns return-of-capital policy. The FALLBACK, when it declines the seam,
      // is deliberately `gross` — the whole draw taxable — because that is what {@link
      // import("./withdrawal").buildWithdrawalSources} falls back to, and this forecasts that
      // channel specifically. (The pro-rata split the explicit-funding path falls back to would
      // read a seamless jurisdiction's brokerage draw as tax-free and quietly under-estimate the
      // year by the whole balance.)
      const taxable =
        account.liquidBuffer === true
          ? 0
          : (jurisdiction.taxableWithdrawalCents?.(
              { grossCents: gross, basisCents: bases[i]!, balanceCents: balance, category: account.category },
              ctx,
            ) ?? gross);

      balances[i] = balance - gross;
      bases[i] = Math.max(0, bases[i]! - (gross - taxable));
      grossByAccount[i] += gross;
      taxableByAccount[i] += taxable;
      remaining -= gross;
    }
    carriedNeed = Math.max(0, remaining);

    // Growth, on whatever survived this month's spending. A depleted account multiplies zero by
    // its rate and stays depleted, which is the "stop compounding once drained" rule stating
    // itself rather than needing a branch.
    for (let i = 0; i < ordered.length; i++) {
      const rate = ordered[i]!.monthlyRates?.[month];
      if (rate === undefined || rate === 0 || balances[i]! <= 0) continue;
      balances[i] = Math.round(balances[i]! * (1 + rate));
    }
  }

  const draws: ForecastDraw[] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (grossByAccount[i]! <= 0) continue;
    draws.push({
      accountId: ordered[i]!.id,
      ownerId: ordered[i]!.ownerId,
      category: ordered[i]!.category,
      grossCents: grossByAccount[i]!,
      taxableCents: taxableByAccount[i]!,
    });
  }

  return { draws, unfundedCents: carriedNeed };
}
