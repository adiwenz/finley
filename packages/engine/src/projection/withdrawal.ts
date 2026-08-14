import type { Cents } from "../money/money";
import type { SimAccount } from "../plan/simAccount";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";

/**
 * The slice of `SimState` decumulation reads and mutates, declared structurally to keep
 * state private to the simulator and this module independently testable.
 */
export interface WithdrawalState {
  readonly accounts: readonly SimAccount[];
  /** Authoritative balances; a draw reduces its source account in place. */
  readonly assetBalances: Map<string, Cents>;
  /**
   * Post-tax principal, per account. A draw books only its GAIN (`draw − pro-rata basis`)
   * to tax. Absent → basis 0, so the whole draw is taxable, as for a pre-tax account.
   */
  readonly basisByAccount: Map<string, Cents>;
  /** The shortfall sink: spent down BEFORE any investment is liquidated. */
  readonly liquidAccount: SimAccount | null;
}

/**
 * Default liquidation order, keyed by an account's {@link
 * import("../plan/simAccount").SimAccountTaxProfile.withdrawalCategory} — earlier is drawn
 * first, ranking accounts by what HOLDING each one is still worth:
 *
 *  - `taxedAtAccrual` (a cash balance) first: its return is taxed the month it is credited, so
 *    holding it defers nothing. Spending it costs a household nothing at all, and every month it
 *    is skipped is a month something taxable was sold instead.
 *  - `capitalGains` next — least friction of the taxable draws under a preferential-rate regime.
 *  - `ordinaryIncome` after that.
 *  - `taxExempt` last, because there its growth is genuinely never taxed and holding it compounds
 *    that. The two untaxed-on-withdrawal categories sit at OPPOSITE ends for that reason alone;
 *    collapsing them stranded cash behind a pre-tax account and sold the account to avoid it.
 *
 * No gross-up happens here — an ordinary mid-year decumulation's own tax is settled with the rest
 * of the year's, through the year's instalments and its closing balance (see {@link
 * import("../jurisdiction/jurisdiction").Jurisdiction.computeTaxCents}'s ANNUAL contract) — so
 * the order ranks accounts by preference alone, not by gross-up cost.
 */
export const DEFAULT_LIQUIDATION_ORDER: readonly TaxCategory[] = [
  "taxedAtAccrual",
  "capitalGains",
  "ordinaryIncome",
  "taxExempt",
];

function liquidationRankMap(order: readonly TaxCategory[]): Partial<Record<TaxCategory, number>> {
  const map: Partial<Record<TaxCategory, number>> = {};
  order.forEach((category, index) => {
    if (map[category] === undefined) map[category] = index;
  });
  return map;
}

/** The shape {@link orderedLiquidationAccounts} ranks by — every account state in the engine has it. */
export interface LiquidationRankable {
  readonly id: string;
  readonly taxProfile: { readonly withdrawalCategory: TaxCategory };
}

/**
 * The ONE account order every money-out path drains in: the liquid cash account first — it is
 * spent before anything is sold — then by `liquidationOrder` rank, ties held in the roster's own
 * order by a stable sort.
 *
 * Shared rather than re-derived, because two callers must agree on it: decumulation ({@link
 * buildWithdrawalSources}, which then drops the liquid account because the shortfall charge
 * already spent it) and the year-start funding forecast ({@link
 * import("./fundingForecast").forecastFundingDraws}). The forecast's whole value is that it
 * predicts the draws the real waterfall will take, which it cannot do from a second copy of this
 * ranking free to drift from the first.
 */
export function orderedLiquidationAccounts<T extends LiquidationRankable>(
  accounts: readonly T[],
  liquidAccountId: string | null,
  liquidationOrder: readonly TaxCategory[] = DEFAULT_LIQUIDATION_ORDER,
): readonly T[] {
  const rankMap = liquidationRankMap(liquidationOrder);
  const rank = (a: T): number =>
    a.id === liquidAccountId ? -1 : (rankMap[a.taxProfile.withdrawalCategory] ?? 99);
  return [...accounts].sort((a, b) => rank(a) - rank(b));
}

/**
 * Single-pass net of this month's non-withdrawal income (wages, benefit, RMD): the gross, less
 * the federal income-tax installment the allocation waterfall will charge on it. Sizing the
 * gap gross would leave exactly the installment uncovered every month, pushing a household
 * with a thin cash buffer onto credit rather than selling the investments it holds.
 */
function estimateNetIncome(
  sources: readonly IncomeSourceMonth[],
  estimatedIncomeTaxCents: Cents,
): Cents {
  let grossTotal = 0;
  for (const src of sources) grossTotal += src.waterfallInflowCents;
  return grossTotal - estimatedIncomeTaxCents;
}

/**
 * Result of the decumulation channel, which runs BEFORE the waterfall alongside {@link
 * import("./rmd").buildRmdSources}: it pulls cash from investment accounts (mutating
 * `assetBalances`) and re-injects it as income.
 *
 * NEED-based, not a safe-withdrawal rate: `gap = obligations − non-withdrawal net income`,
 * less the liquid buffer spent first. Each draw sells EXACTLY `need` (capped at the account's
 * balance) — no gross-up: the tax this draw's own gain causes is not charged here, or in any
 * other month, but folded into the year's actual taxable income and settled with the year. The
 * realized gain still rides `taxableCents` on the returned source, so it reaches the caller's
 * annual accumulator; it is simply not netted out of the draw itself.
 *
 * No double-withdraw against RMDs: their sources already sit in `nonWithdrawalSources` and
 * their forced draw already reduced these balances, so total pre-tax drawn settles at
 * `max(desired, required)`.
 */
export interface WithdrawalPlan {
  readonly sources: IncomeSourceMonth[];
  /**
   * The slice of the gap the liquid buffer covers before any investment is sold.
   * Reporting-only, never a waterfall source: the cascade already spends this cash
   * directly, so injecting it would double-count and mis-tax it.
   */
  readonly liquidDrawdownCents: Cents;
  /**
   * Each liquidated account's full withdrawal result, in liquidation order — the decumulation
   * slice per-line funding attribution partitions across obligations. Carries the whole breakdown,
   * not just the net, so a consumer never re-derives basis or tax from a flattened amount:
   * `gross = principal + gain` (principal is the returned basis) and `net = gross − tax`. Reported
   * net so Σ `netDeliveredCents` is the cash the walk funds with, not the gross sold. Aligns 1:1
   * with {@link sources}; empty when nothing was liquidated.
   */
  readonly decumulationDraws: readonly DecumulationDrawResult[];
}

/** One account's liquidation, gross down to the net cash it delivered toward the month. */
export interface DecumulationDrawResult {
  readonly sourceId: string;
  readonly grossWithdrawnCents: Cents;
  /** Returned basis (`gross − gain`); the amount the draw reduced the account's basis by. */
  readonly principalCents: Cents;
  readonly realizedGainCents: Cents;
  readonly taxCents: Cents;
  readonly netDeliveredCents: Cents;
}

export function buildWithdrawalSources(
  state: WithdrawalState,
  jurisdiction: Jurisdiction,
  nonWithdrawalSources: readonly IncomeSourceMonth[],
  obligationsCents: Cents,
  ctx: JurisdictionContext,
  liquidationOrder: readonly TaxCategory[] = DEFAULT_LIQUIDATION_ORDER,
  estimatedIncomeTaxCents: Cents = 0,
): WithdrawalPlan {
  const netIncomeCents = estimateNetIncome(nonWithdrawalSources, estimatedIncomeTaxCents);

  const gap = obligationsCents - netIncomeCents;
  if (gap <= 0) return { sources: [], liquidDrawdownCents: 0, decumulationDraws: [] };

  // Spend the liquid buffer first: the cascade charges whatever the withdrawal leaves
  // uncovered against the liquid account.
  const liquidBuffer =
    state.liquidAccount !== null
      ? Math.max(0, state.assetBalances.get(state.liquidAccount.id) ?? 0)
      : 0;
  const liquidDrawdownCents = Math.min(gap, liquidBuffer);
  let need = gap - liquidBuffer;
  if (need <= 0) return { sources: [], liquidDrawdownCents, decumulationDraws: [] };

  // The shared order, minus the liquid account: it is not exempt from being drawn — it is drawn
  // FIRST, above, as `liquidDrawdownCents`, and the cascade charges whatever is left against it
  // directly. Selling it again here would double-spend the same cash. (The `liquid` flag itself
  // means "eligible to *receive* deposits"; a drawdown runs the other way, so every other
  // account — investment or not — is a valid source.)
  const liquidId = state.liquidAccount?.id ?? null;
  const orderedSources = orderedLiquidationAccounts(
    state.accounts,
    liquidId,
    liquidationOrder,
  ).filter((a) => a.id !== liquidId);

  const sources: IncomeSourceMonth[] = [];
  const decumulationDraws: DecumulationDrawResult[] = [];
  for (const account of orderedSources) {
    if (need <= 0) break;
    const balance = state.assetBalances.get(account.id) ?? 0;
    if (balance <= 0) continue;

    const withdrawalCategory = account.taxProfile.withdrawalCategory;
    // Only the GAIN is taxable, but WHICH portion is the jurisdiction's call: the engine
    // owns and passes the basis state, the jurisdiction owns the return-of-capital policy
    // and accounting method. Absent seam → the whole draw is taxable.
    const basis = Math.max(0, state.basisByAccount.get(account.id) ?? 0);
    const gainOf = (draw: Cents): Cents =>
      jurisdiction.taxableWithdrawalCents?.(
        { grossCents: draw, basisCents: basis, balanceCents: balance, category: withdrawalCategory },
        ctx,
      ) ?? draw;
    // Sell exactly `need`, capped at the balance — no gross-up. Only the gain is booked as
    // `taxableCents` on the returned source (fed to the caller's annual accumulator); the
    // full gross is still paid out as take-home below, and no tax is netted out of it.
    const gross = Math.min(balance, need);
    const gainCents = gainOf(gross);

    // The rest of the gross is returned principal; reduce basis by it (method-agnostic:
    // gross − taxable).
    state.basisByAccount.set(account.id, basis - (gross - gainCents));
    state.assetBalances.set(account.id, balance - gross);
    need -= gross;
    sources.push({
      ownerId: account.ownerId,
      waterfallInflowCents: gross,
      taxCategory: withdrawalCategory,
      taxableCents: gainCents,
      // Report by source account, so a draining "emergency fund" reads by name rather than
      // as an anonymous `capitalGains` band.
      sourceId: account.id,
      label: account.label ?? account.id,
    });
    // `gross − gain` is the returned basis (the same figure that reduced `basisByAccount`
    // above); `taxCents` is always 0 and `netDeliveredCents` always equals `gross` — no tax
    // is charged against an ordinary mid-year draw.
    decumulationDraws.push({
      sourceId: account.id,
      grossWithdrawnCents: gross,
      principalCents: gross - gainCents,
      realizedGainCents: gainCents,
      taxCents: 0,
      netDeliveredCents: gross,
    });
  }

  return { sources, liquidDrawdownCents, decumulationDraws };
}
