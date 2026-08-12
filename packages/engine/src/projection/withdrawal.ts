import type { Cents } from "../money/money";
import type { SimAccount } from "../plan/simAccount";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";
import { monthlyIncomeTaxCents } from "./incomeTax";

type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

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
 * first. `capitalGains` leads (least tax friction under a preferential-rate regime),
 * `taxExempt` last to preserve tax-free growth. Every category is grossed up to net its
 * need, so the order ranks them by gross-up cost, not by which are taxed at all.
 */
export const DEFAULT_LIQUIDATION_ORDER: readonly TaxCategory[] = [
  "capitalGains",
  "ordinaryIncome",
  "taxExempt",
];

/**
 * Backstop on the gross-up climb. Set high because exhausting it fails QUIETLY: the draw
 * lands light and the shortfall rides to next month. Each step closes the gap by the
 * marginal rate, so `usJurisdiction` (max rate 0.6845, the 1.85x Social Security "torpedo"
 * against the 37% bracket) settles in 37 steps on a $10k need, 56 on $10M; a 0.9-rate seam
 * would want ~200.
 */
const GROSS_UP_ITERATIONS = 1_000;

function liquidationRankMap(order: readonly TaxCategory[]): Partial<Record<TaxCategory, number>> {
  const map: Partial<Record<TaxCategory, number>> = {};
  order.forEach((category, index) => {
    if (map[category] === undefined) map[category] = index;
  });
  return map;
}

function liquidationRank(
  account: SimAccount,
  rankMap: Partial<Record<TaxCategory, number>>,
): number {
  return rankMap[account.taxProfile.withdrawalCategory] ?? 99;
}

/**
 * Distinct from the `liquid` flag, which means "eligible to *receive* deposits". A drawdown
 * runs the other direction, so every investment account is a valid source. The one
 * exclusion is the liquid cash account, already spent down by the shortfall charge.
 */
function isLiquidatable(account: SimAccount, state: WithdrawalState): boolean {
  if (state.liquidAccount !== null && account.id === state.liquidAccount.id) return false;
  return true;
}

function addCategory(map: TaxableByCategory, category: TaxCategory, amount: Cents): void {
  if (amount === 0) return;
  map[category] = (map[category] ?? 0) + amount;
}

/**
 * Single-pass estimate of this month's after-tax income from non-withdrawal sources
 * (wages, benefit, RMD): tax is the sum of each owner's tax on their taxable-by-category
 * map. Deferrals are ignored — decumulation has none, and the residual self-corrects in
 * the liquid buffer next month. The returned taxable bases seed the gross-up.
 */
function estimateNetIncome(
  sources: readonly IncomeSourceMonth[],
  computeTaxCents: (taxableByCategory: TaxableByCategory) => Cents,
): { netIncomeCents: Cents; taxableByOwner: Map<string, TaxableByCategory> } {
  let grossTotal = 0;
  const taxableByOwner = new Map<string, TaxableByCategory>();
  for (const src of sources) {
    grossTotal += src.waterfallInflowCents;
    // The jurisdiction owns the inclusion %, so the engine never pre-applies a fraction and
    // honors the explicit taxable amount. A source's taxable base can differ from the cash
    // it puts through the waterfall: a returned-basis draw books only its gain, and savings
    // interest has positive taxableCents but 0 inflow (already credited).
    let map = taxableByOwner.get(src.ownerId);
    if (map === undefined) {
      map = {};
      taxableByOwner.set(src.ownerId, map);
    }
    addCategory(map, src.taxCategory, src.taxableCents ?? src.waterfallInflowCents);
  }
  let taxTotal = 0;
  for (const taxable of taxableByOwner.values()) taxTotal += computeTaxCents(taxable);
  return { netIncomeCents: grossTotal - taxTotal, taxableByOwner };
}

/**
 * Result of the decumulation channel, which runs BEFORE the waterfall alongside {@link
 * import("./rmd").buildRmdSources}: it pulls cash from investment accounts (mutating
 * `assetBalances`) and re-injects it as income, taxed once at the chokepoint.
 *
 * NEED-based, not a safe-withdrawal rate: `gap = obligations − non-withdrawal net income`,
 * less the liquid buffer spent first. Each draw is grossed up to the least fixed point of
 * `gross = need + inducedTax(gross)`, netting the need exactly — inverting an implied rate
 * (`need / (1 − rate)`) assumes tax scales proportionally and falls short against a bracket at
 * `offset + rate × draw`.
 *
 * Two limits, latent under `usJurisdiction`. The climb assumes MONOTONICITY, so an EITC-shaped
 * credit phasing in over the draw leaves it returning whatever it held at the iteration
 * budget. And it only sizes UP: under a notch (Australia's Medicare Levy Surcharge taxes the
 * whole return once crossed) drawing LESS can be better, but this channel crosses it and may
 * empty the account.
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
  priorTaxableByOwner?: ReadonlyMap<string, TaxableByCategory>,
): WithdrawalPlan {
  const computeTaxCents = (taxable: TaxableByCategory): Cents =>
    monthlyIncomeTaxCents(jurisdiction, ctx, taxable);

  const { netIncomeCents, taxableByOwner: incomeTaxableByOwner } = estimateNetIncome(
    nonWithdrawalSources,
    computeTaxCents,
  );

  // Explicit obligations resolve first, so any gains they realized already sit in the month's
  // taxable base; decumulation stacks its own gains ON TOP, bearing the higher marginal bracket.
  // `priorTaxableByOwner` already folds this month's non-withdrawal income in (it is built from
  // the same sources), so it REPLACES the income-only base rather than adding to it — merging
  // would double-count that income. Absent it (a direct unit call, or a month with no explicit
  // draw) the base is non-withdrawal income alone, unchanged. The gap below is sized on
  // `netIncomeCents` either way: explicit draws are net-neutral and never move it.
  const taxableByOwner =
    priorTaxableByOwner !== undefined
      ? new Map(Array.from(priorTaxableByOwner, ([owner, byCat]) => [owner, { ...byCat }]))
      : incomeTaxableByOwner;

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

  const rankMap = liquidationRankMap(liquidationOrder);
  const orderedSources = state.accounts
    .filter((a) => isLiquidatable(a, state))
    .sort((a, b) => liquidationRank(a, rankMap) - liquidationRank(b, rankMap));

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
    // Difference the tax over the WHOLE return, not the draw's own-category rate: a
    // gains/tax-exempt draw can read as 0% alone yet still raise the return's tax by
    // pulling a benefit into provisional-income taxability. Only the gain is booked to the
    // taxable map; the full gross is still paid out as take-home below.
    const base = taxableByOwner.get(account.ownerId) ?? {};
    const withDraw = (draw: Cents): TaxableByCategory => ({
      ...base,
      [withdrawalCategory]: (base[withdrawalCategory] ?? 0) + gainOf(draw),
    });
    const baseTax = computeTaxCents(base);
    const inducedTax = (draw: Cents): Cents => computeTaxCents(withDraw(draw)) - baseTax;
    // Sizing is circular — the tax depends on the draw, the draw must cover the tax — so
    // climb to the least fixed point of `gross = need + inducedTax(gross)`. Rising from
    // `need` stops at the first solution, the cheapest liquidation that nets it. Iterate
    // rather than invert: `computeTaxCents` is a jurisdiction-supplied black box.
    let gross = Math.min(balance, need);
    for (let i = 0; i < GROSS_UP_ITERATIONS; i++) {
      const wanted = need + inducedTax(gross);
      // The account cannot cover its own gross-up: take what is there and let the rest of
      // the need fall to the next source.
      if (wanted >= balance) {
        gross = balance;
        break;
      }
      if (wanted === gross) break;
      gross = wanted;
    }
    const taxOnGross = computeTaxCents(withDraw(gross)) - baseTax;
    const netDelivered = gross - taxOnGross;

    // The rest of the gross is returned principal; reduce basis by it (method-agnostic:
    // gross − taxable).
    const gainCents = gainOf(gross);
    state.basisByAccount.set(account.id, basis - (gross - gainCents));
    state.assetBalances.set(account.id, balance - gross);
    taxableByOwner.set(account.ownerId, withDraw(gross));
    need -= netDelivered;
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
    // Carry the whole result the gross-up already computed, not a flattened net: `gross − gain`
    // is the returned basis (the same figure that reduced `basisByAccount` above), and the tax is
    // the sale's induced tax. Attribution copies these onto the funding source verbatim.
    decumulationDraws.push({
      sourceId: account.id,
      grossWithdrawnCents: gross,
      principalCents: gross - gainCents,
      realizedGainCents: gainCents,
      taxCents: taxOnGross,
      netDeliveredCents: netDelivered,
    });
  }

  return { sources, liquidDrawdownCents, decumulationDraws };
}
