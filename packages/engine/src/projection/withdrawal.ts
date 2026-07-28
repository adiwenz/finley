import type { Cents } from "../money";
import type { SimAccount } from "../simAccount";
import type { TaxCategory } from "../cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { IncomeSourceMonth } from "./waterfall";

type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

/**
 * The slice of `SimState` decumulation reads and mutates, declared structurally so state
 * stays private to the simulator while this module remains independently testable.
 */
export interface WithdrawalState {
  readonly accounts: readonly SimAccount[];
  /** Authoritative mutable balances; a draw reduces its source account in place. */
  readonly assetBalances: Map<string, Cents>;
  /**
   * Post-tax principal already taxed, per account. A draw books only its GAIN (`draw −
   * pro-rata basis`) to tax. Absent → basis 0, so the whole draw is taxable — right for a
   * pre-tax account, whose contributions were never taxed going in.
   */
  readonly basisByAccount: Map<string, Cents>;
  /**
   * The shortfall sink: its beginning-of-month balance is spent down BEFORE any investment
   * is liquidated, so the withdrawal only funds what the buffer can't.
   */
  readonly liquidAccount: SimAccount | null;
}

/**
 * Default liquidation order, keyed by an account's {@link
 * import("../simAccount").SimAccountTaxProfile.withdrawalCategory} — earlier is drawn
 * first. `capitalGains` leads (least tax friction under a preferential-rate regime),
 * `taxExempt` last to preserve tax-free growth. Every category is grossed up to net its
 * need, so the order ranks them by gross-up cost, not by which are taxed at all.
 * {@link buildWithdrawalSources} takes an override. Forced RMDs run ahead regardless, in a
 * separate channel that has already reduced the balances and the need.
 */
export const DEFAULT_LIQUIDATION_ORDER: readonly TaxCategory[] = [
  "capitalGains",
  "ordinaryIncome",
  "taxExempt",
];

/**
 * Backstop on the gross-up climb. Set high because exhausting it fails QUIETLY: the climb
 * stops short of the fixed point, the draw lands light, and the shortfall rides to next
 * month. Each step closes the gap by the marginal rate, so `usJurisdiction` (max rate
 * 0.6845, the 1.85x Social Security "torpedo" against the 37% bracket) settles in 37 steps
 * on a $10k need, 56 on $10M; a 0.9-rate seam would want ~200.
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
 * runs the other direction, so every investment account is a valid source regardless. The
 * one exclusion is the liquid cash account, already spent down by the shortfall charge.
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
 * map. Deferrals are ignored — decumulation has none, a still-deferring worker has
 * surplus income anyway, and the residual self-corrects in the liquid buffer next month.
 * Returns the net total plus each owner's taxable base, which seeds the gross-up.
 */
function estimateNetIncome(
  sources: readonly IncomeSourceMonth[],
  computeTaxCents: (taxableByCategory: TaxableByCategory) => Cents,
): { netIncomeCents: Cents; taxableByOwner: Map<string, TaxableByCategory> } {
  let grossTotal = 0;
  const taxableByOwner = new Map<string, TaxableByCategory>();
  for (const src of sources) {
    grossTotal += src.waterfallInflowCents;
    // Booked under its provenance category; the jurisdiction owns the inclusion %, so the
    // engine never pre-applies a fraction. A source's taxable base can differ from the cash
    // it puts through the waterfall — a returned-basis draw books only its gain, and a
    // savings-interest booking has positive taxableCents but 0 inflow (already credited) —
    // so honor the explicit amount, letting the gross-up baseline see what the tax seam will.
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
 * import("./rmd").buildRmdSources}: it pulls cash out of investment accounts (mutating
 * `assetBalances`) and re-injects it as income, so the withdrawal is taxed once at the
 * tax chokepoint and its net funds the month's obligations instead of the plan retiring
 * onto a credit card.
 *
 * The amount is NEED-based, not a safe-withdrawal rate: `gap = obligations −
 * non-withdrawal net income`, less the liquid buffer spent first. Sources are drawn in
 * {@link DEFAULT_LIQUIDATION_ORDER} (or a caller override) and gated by {@link
 * isLiquidatable}. Every draw injects at its account's own withdrawal category, grossed
 * up as the least fixed point of `gross = need + inducedTax(gross)`, where induced tax is
 * `computeTaxCents` differenced over the WHOLE return. Hence a draw taxed at 0% on its
 * own but dragging a benefit into provisional-income taxability is still sized to net the
 * need; and the need is netted EXACTLY, where inverting an implied rate (`need / (1 −
 * rate)`) assumes tax scales proportionally and falls short against a real bracket, which
 * sits at `offset + rate × draw`.
 *
 * Two latent limits, neither binding on `usJurisdiction` but both reachable by a new
 * jurisdiction:
 *
 * 1. The climb assumes the seam is MONOTONE — a larger draw never owes less tax — which
 *    is what makes a rising sequence stop at the cheapest solution rather than oscillate.
 *    A refundable credit phasing IN over the draw (EITC-shaped) breaks it, and the loop
 *    returns whatever it held when the iteration budget ran out.
 * 2. The draw is only sized UP from `need`. Under a notch — a threshold taxing the whole
 *    return more once crossed, not just the excess, as Australia's Medicare Levy
 *    Surcharge does — drawing LESS and carrying a small shortfall can leave the household
 *    better off. This channel will cross the notch, and if the lump outruns the balance it
 *    empties the account.
 *
 * No double-withdraw against RMDs: their sources are already in `nonWithdrawalSources`, so
 * their income shrinks the gap and their forced draw already reduced these balances —
 * total pre-tax drawn settles at `max(desired, required)`. With no tax seam, every draw
 * nets one-for-one.
 */
export interface WithdrawalPlan {
  /** Taxable investment-liquidation income sources for the waterfall (may be empty). */
  readonly sources: IncomeSourceMonth[];
  /**
   * The slice of the gap the liquid buffer covers before any investment is sold — cash the
   * household is living on because income fell short. Reporting-only, never a waterfall
   * source: the cash is already in the account and the cascade spends it directly, so
   * injecting it would double-count and mis-tax it. Returned so the flow view can show
   * "savings are covering this month" rather than a misleading zero-income band.
   */
  readonly liquidDrawdownCents: Cents;
}

export function buildWithdrawalSources(
  state: WithdrawalState,
  jurisdiction: Jurisdiction,
  nonWithdrawalSources: readonly IncomeSourceMonth[],
  obligationsCents: Cents,
  ctx: JurisdictionContext,
  liquidationOrder: readonly TaxCategory[] = DEFAULT_LIQUIDATION_ORDER,
): WithdrawalPlan {
  const computeTaxCents = (taxable: TaxableByCategory): Cents =>
    jurisdiction.computeTaxCents(taxable, ctx);

  const { netIncomeCents, taxableByOwner } = estimateNetIncome(
    nonWithdrawalSources,
    computeTaxCents,
  );

  const gap = obligationsCents - netIncomeCents;
  if (gap <= 0) return { sources: [], liquidDrawdownCents: 0 };

  // Spend the liquid buffer first: the cascade charges whatever the withdrawal leaves
  // uncovered against the liquid account, draining it before any investment is sold.
  const liquidBuffer =
    state.liquidAccount !== null
      ? Math.max(0, state.assetBalances.get(state.liquidAccount.id) ?? 0)
      : 0;
  // The reported savings drawdown, identical in both branches: the whole gap when the
  // buffer absorbs it (nothing sold), else the whole buffer (the rest is sold below).
  const liquidDrawdownCents = Math.min(gap, liquidBuffer);
  let need = gap - liquidBuffer;
  if (need <= 0) return { sources: [], liquidDrawdownCents };

  const rankMap = liquidationRankMap(liquidationOrder);
  const orderedSources = state.accounts
    .filter((a) => isLiquidatable(a, state))
    .sort((a, b) => liquidationRank(a, rankMap) - liquidationRank(b, rankMap));

  const sources: IncomeSourceMonth[] = [];
  for (const account of orderedSources) {
    if (need <= 0) break;
    const balance = state.assetBalances.get(account.id) ?? 0;
    if (balance <= 0) continue;

    const withdrawalCategory = account.taxProfile.withdrawalCategory;
    // Only the GAIN is taxable, but WHICH portion is the jurisdiction's call: the engine
    // owns and passes the basis state, the jurisdiction owns the return-of-capital policy
    // and accounting method. Absent seam → the whole draw is taxable, restoring the
    // "engine passes the full gross" default and matching a basis-0 pre-tax account.
    const basis = Math.max(0, state.basisByAccount.get(account.id) ?? 0);
    const gainOf = (draw: Cents): Cents =>
      jurisdiction.taxableWithdrawalCents?.(
        { grossCents: draw, basisCents: basis, balanceCents: balance, category: withdrawalCategory },
        ctx,
      ) ?? draw;
    // Difference the tax over the WHOLE return, not the draw's own-category rate: a
    // gains/tax-exempt draw can read as 0% alone yet still raise the return's tax by
    // pulling a benefit into provisional-income taxability, which an own-category rate
    // would multiply by 0 and miss. Only the gain is booked to the taxable map — the full
    // gross is still paid out as take-home below.
    const base = taxableByOwner.get(account.ownerId) ?? {};
    const withDraw = (draw: Cents): TaxableByCategory => ({
      ...base,
      [withdrawalCategory]: (base[withdrawalCategory] ?? 0) + gainOf(draw),
    });
    const baseTax = computeTaxCents(base);
    const inducedTax = (draw: Cents): Cents => computeTaxCents(withDraw(draw)) - baseTax;
    // Sizing is circular — the tax depends on the draw, the draw must cover the tax — so
    // climb to the least fixed point of `gross = need + inducedTax(gross)`. Climb UP from
    // `need`: since tax only rises with the draw, a rising sequence stops at the first
    // solution, which is the cheapest liquidation that nets the need. Iterate rather than
    // invert because `computeTaxCents` is a jurisdiction-supplied black box.
    let gross = Math.min(balance, need);
    for (let i = 0; i < GROSS_UP_ITERATIONS; i++) {
      const wanted = need + inducedTax(gross);
      // The account cannot cover its own gross-up: take what is there and let the rest of
      // the need fall to the next source in the liquidation order.
      if (wanted >= balance) {
        gross = balance;
        break;
      }
      if (wanted === gross) break;
      gross = wanted;
    }
    // The net delivered reduces the remaining need; the owner's taxable base rises for any
    // later draw.
    const taxOnGross = computeTaxCents(withDraw(gross)) - baseTax;
    const netDelivered = gross - taxOnGross;

    // The rest of the gross is returned principal. Reduce basis by it (method-agnostic:
    // gross − taxable) so the next draw is measured against what remains.
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
      // Report by the account it came from, so a draining "emergency fund" reads as that
      // fund by name rather than as an anonymous `capitalGains` band.
      sourceId: account.id,
      label: account.label ?? account.id,
    });
  }

  return { sources, liquidDrawdownCents };
}
