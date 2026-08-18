/**
 * A LIGHTWEIGHT annual answer to "if the household is short by this much in each of the coming
 * twelve months, which accounts pay for it, and what taxable income does that realize?"
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
 * no snapshots, no event replay, no properties, no retirement solving, and it never re-enters
 * `simulateHousehold`. It holds no liabilities either — a debt reaches it as need, in the months
 * its own schedule says it is paid ({@link
 * import("./liabilitySteps").forecastLiabilityPayments}), like every other cost. The year's ACTUAL taxable income is still whatever the
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
 * So each month subtracts that month's need, in the same order the waterfall would, and then
 * applies the account's configured growth to whatever survived. A depleted account compounds
 * nothing, which is what stops the walk from inventing a balance that was spent in March.
 *
 * **The need arrives with its own shape**, one figure per month, not a year's total sliced twelve
 * ways. WHEN money is spent decides how much of it an account has grown to meet and, through the
 * jurisdiction's basis seam, how much gain a sale realizes: a household that buys a house in March
 * sells a year's worth of brokerage out of a March balance, against a March basis, and realizing
 * far more gain than the same dollars dribbled out monthly would. Averaging that away made the
 * estimate confidently smooth and wrong — on the engine's own home-purchase fixture, a $150,000
 * March obligation realizes $25,045 of gain, which an evenly-spread forecast priced at $19,416 and
 * a January-balance cap at $13,636, below the jurisdiction's threshold and so at no tax at all.
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
   * REQUIRED, and required for a reason: an omissible rate schedule defaults an account to not
   * growing, which is the very blind spot this forecast exists to close, and it does so silently —
   * a caller that forgets it gets a plausible answer that is short by exactly the growth earned
   * before depletion. A genuinely flat account passes twelve zeroes and says so.
   */
  readonly monthlyRates: readonly number[];
  /**
   * The owner's age, ONLY so {@link
   * import("../jurisdiction/jurisdiction").Jurisdiction.earlyWithdrawalPenaltyCents} can be
   * forecast — mirrors {@link import("./withdrawal").WithdrawalState.personsById}'s lookup for
   * the real decumulation draw this forecasts. Absent → the seam is never called and no penalty
   * is forecast for this account, exactly as an unknown birth year skips it in the real draw.
   */
  readonly age?: number;
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
export const FORECAST_MONTHS = 12;

/**
 * A year's figure spread evenly over the twelve forecast months, integer cents, the shares summing
 * to exactly `annualCents`.
 *
 * For the parts of the need that really ARE even — chiefly the year's own estimated income tax,
 * which is charged in twelve equal instalments ({@link
 * import("./federalIncomeTax").MONTHS_IN_TAX_YEAR}) — and for callers with nothing better to say
 * about timing. Everything the plan does know the timing of should arrive shaped instead; see
 * {@link forecastFundingDraws}.
 */
export function evenMonthlyShares(annualCents: Cents): Cents[] {
  return Array.from(
    { length: FORECAST_MONTHS },
    (_, month) =>
      Math.round((annualCents * (month + 1)) / FORECAST_MONTHS) -
      Math.round((annualCents * month) / FORECAST_MONTHS),
  );
}

/**
 * Walk twelve months over `ordered` — already in {@link
 * import("./withdrawal").orderedLiquidationAccounts} order — taking what is left of each month's
 * need from each account in turn and then growing whatever survived by that account's own rate,
 * until the year's need is covered or the accounts are dry. The annual analogue of twelve months
 * of {@link import("./withdrawal").buildWithdrawalSources}: same order, same "sell exactly the
 * need" sizing, same jurisdiction-owned basis/gain seam.
 *
 * `needByMonthCents` is the year's funding need MONTH BY MONTH, index 0 being the tax year's first
 * processed month. Entries are SIGNED: a month whose income exceeds its costs carries a negative
 * need, and that surplus carries forward against later months rather than being clamped away —
 * which is how a household that banks a March bonus and lives off it until August forecasts no
 * sale at all. (Clamping per month instead would forecast a household selling investments in
 * every lean month while its own cash piled up beside them.)
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
 *
 * An early-withdrawal penalty is the one exception, forecast the same way the real draw charges
 * it: netted out immediately, not solved by the fixed point above. `remaining` tracks NET
 * delivered per account, so a penalized account's shortfall is forecast pulling more from the
 * next account in line — the real draw's own behavior (see `withdrawal.ts`'s module doc). Get
 * this wrong and a decumulating household under 59½ forecasts too little capital-gains income
 * from its taxable accounts, reintroducing the December spike this module exists to prevent.
 */
export function forecastFundingDraws(
  needByMonthCents: readonly Cents[],
  ordered: readonly ForecastAccount[],
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
): FundingForecast {
  if (ordered.length === 0) return NOTHING_FORECAST;

  // Working copies, one entry per account, parallel to `ordered`.
  const balances = ordered.map((a) => Math.max(0, a.balanceCents));
  const bases = ordered.map((a) => Math.max(0, a.basisCents));
  const grossByAccount = ordered.map(() => 0);
  const taxableByAccount = ordered.map(() => 0);

  // SIGNED between months: a surplus month carries forward as a negative and pays for a lean one.
  let carriedNeed = 0;
  for (let month = 0; month < FORECAST_MONTHS; month++) {
    let remaining = (needByMonthCents[month] ?? 0) + carriedNeed;

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
      // No age → the real draw never calls the seam either, so the forecast must not invent one.
      const penalty =
        account.age === undefined
          ? 0
          : (jurisdiction.earlyWithdrawalPenaltyCents?.(
              { grossCents: gross, basisCents: bases[i]!, balanceCents: balance, category: account.category },
              { year: ctx.year, age: account.age },
            ) ?? 0);

      balances[i] = balance - gross;
      bases[i] = Math.max(0, bases[i]! - (gross - taxable));
      grossByAccount[i] += gross;
      taxableByAccount[i] += taxable;
      remaining -= gross - penalty;
    }
    carriedNeed = remaining;

    // Growth, on whatever survived this month's spending. A depleted account multiplies zero by
    // its rate and stays depleted, which is the "stop compounding once drained" rule stating
    // itself rather than needing a branch.
    for (let i = 0; i < ordered.length; i++) {
      // `?? 0` guards a short array, not an absent schedule: `monthlyRates` is required, and a
      // caller with no growth to declare declares zeroes.
      const rate = ordered[i]!.monthlyRates[month] ?? 0;
      if (rate === 0 || balances[i]! <= 0) continue;
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

  return { draws, unfundedCents: Math.max(0, carriedNeed) };
}
