import type { Cents } from "../money";
import type { SimAccount } from "../simAccount";
import type { TaxCategory } from "../cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import { isEarmarkedForDisposition, type SimGoal } from "../goal";
import type { IncomeSourceMonth } from "./waterfall";

/** A per-owner map of taxable amount by {@link TaxCategory} (mirrors the waterfall). */
type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

/**
 * The slice of the simulator's state the desired-withdrawal (decumulation)
 * bookkeeping reads and mutates. A structural view over `SimState` — declaring it
 * here (rather than importing the whole mutable `SimState`) keeps that state object
 * private to the simulator while this module stays independently testable, mirroring
 * {@link import("./rmd").RmdState} and {@link import("./governmentBenefit").EarningsState}.
 */
export interface WithdrawalState {
  /** Every asset account — the withdrawal walks these as liquidation sources. */
  readonly accounts: readonly SimAccount[];
  /** The authoritative mutable balances; a drawdown reduces its source account in place. */
  readonly assetBalances: Map<string, Cents>;
  /**
   * Per-account cost basis (§#94) — the post-tax principal the owner has already
   * paid tax on. A draw books only its GAIN (`draw − pro-rata basis`) to tax; the
   * basis it returns falls out of the account's basis here, pro-rata. An absent
   * entry is basis 0 → the whole draw is taxable, which is exactly right for a
   * pre-tax account (its contributions were never taxed going in).
   */
  readonly basisByAccount: Map<string, Cents>;
  /**
   * The first liquid account (the §5.1 shortfall sink). Its beginning-of-month
   * balance is spent down BEFORE any investment is liquidated (D2): the withdrawal
   * only funds the shortfall the liquid buffer can't, so the cascade drains cash first.
   */
  readonly liquidAccount: SimAccount | null;
  /** Funding goals — a `convertToEquity`/`spend` goal through its target month earmarks its fund (D4, §5.2). */
  readonly goals: readonly SimGoal[];
}

/**
 * The **tax-efficient default** order investment accounts are liquidated in during
 * decumulation (§16, D2), keyed by the account's neutral
 * {@link import("../simAccount").SimAccountTaxProfile.withdrawalCategory}:
 * `capitalGains` first (brokerage + eligible goal funds, least tax friction under a
 * preferential-rate regime), then `ordinaryIncome` (taxed like an RMD), then
 * `taxExempt` last (preserve tax-free growth). Earlier in the list = drawn first.
 * Every category is grossed up to net its need (#100); the order ranks them by how
 * much tax that gross-up tends to cost, not by which ones are taxed at all.
 *
 * This is the DEFAULT, not a fixed rule: {@link buildWithdrawalSources} accepts an
 * override (§16 "overridable"), so a plan can, say, spend a tax-exempt account first
 * for a bequest strategy. Forced RMDs are always honored ahead of any elective draw
 * regardless of this order — they run in a separate channel that has already reduced
 * the balances and the need before this loop (see {@link buildWithdrawalSources}).
 */
export const DEFAULT_LIQUIDATION_ORDER: readonly TaxCategory[] = [
  "capitalGains",
  "ordinaryIncome",
  "taxExempt",
];

/**
 * Backstop on the gross-up climb in {@link buildWithdrawalSources} — a guard against a
 * pathological seam spinning forever, NOT a tuning knob. The loop exits the moment it
 * converges, so this bound is only reached by seams that never do.
 *
 * Set it high because exhausting it fails QUIETLY: the climb stops short of the fixed
 * point, the draw lands light, and the shortfall rides to next month — the very leak
 * this channel exists to prevent. Each step closes the remaining gap by the marginal
 * rate, so the count scales with both the rate and the size of the need: `usJurisdiction`
 * (max rate 0.6845, the 1.85x Social Security "torpedo" against the 37% bracket) settles
 * in 37 steps on a $10k need and 56 on a $10M one, while a hypothetical 0.9-rate seam
 * would want ~200. A realistic draw converges in about a dozen.
 */
const GROSS_UP_ITERATIONS = 1_000;

/** Rank map (category → position) built from an ordered liquidation list. */
function liquidationRankMap(order: readonly TaxCategory[]): Partial<Record<TaxCategory, number>> {
  const map: Partial<Record<TaxCategory, number>> = {};
  order.forEach((category, index) => {
    if (map[category] === undefined) map[category] = index;
  });
  return map;
}

/** Liquidation rank for an account, from its withdrawal category (absent → last). */
function liquidationRank(
  account: SimAccount,
  rankMap: Partial<Record<TaxCategory, number>>,
): number {
  return rankMap[account.taxProfile.withdrawalCategory] ?? 99;
}

/**
 * Whether `account` may be liquidated to fund a retirement shortfall (D4) — i.e.
 * whether it counts as drawable retirement portfolio.
 *
 * "Liquidatable in decumulation" is deliberately distinct from the `liquid` flag:
 * `liquid` means "eligible to *receive* deposits" (the deposit direction); a
 * drawdown is the opposite direction, so every investment account is a valid
 * *source* regardless of `liquid`. The two exclusions:
 *  - the liquid cash account itself — it is spent down first via the §5.1 shortfall
 *    charge, so it is not a withdrawal source here (it would double-count);
 *  - a goal fund earmarked by its **disposition** (§5.2): a `convertToEquity` or
 *    `spend` goal up to and including its target month is committed to that purchase /
 *    expense, so it drops out of the nest egg. A `retain` (liquid reserve) or
 *    `drawDown` (the nest egg itself) goal always counts. Past its target month the
 *    goal has already FIRED (the simulator's `fireGoalDispositions` zeroed the fund or
 *    swapped it to an illiquid property and dropped the goal), so there is no stale
 *    earmarked balance here to reason about.
 */
function isLiquidatable(
  account: SimAccount,
  state: WithdrawalState,
  month: number,
): boolean {
  if (state.liquidAccount !== null && account.id === state.liquidAccount.id) return false;
  for (const goal of state.goals) {
    if (goal.fundAccountId !== account.id) continue;
    if (isEarmarkedForDisposition(goal, month)) return false;
  }
  return true;
}

/** Add `amount` to `map[category]` (creating the entry at 0 first). */
function addCategory(map: TaxableByCategory, category: TaxCategory, amount: Cents): void {
  if (amount === 0) return;
  map[category] = (map[category] ?? 0) + amount;
}

/**
 * Estimate this month's after-tax income from the non-withdrawal sources (wages,
 * government retirement benefit, RMD). A single-pass estimate (D1): tax is the sum
 * of each owner's §5.3 tax on their taxable-by-category map. Deferrals are ignored —
 * in decumulation there are none, and a still-deferring worker has surplus income
 * (no shortfall) anyway; the residual self-corrects in the liquid buffer next month.
 * Returns both the net total and each owner's per-category taxable base, the latter
 * seeding the pre-tax gross-up (D3).
 */
function estimateNetIncome(
  sources: readonly IncomeSourceMonth[],
  computeTaxCents: (taxableByCategory: TaxableByCategory) => Cents,
): { netIncomeCents: Cents; taxableByOwner: Map<string, TaxableByCategory> } {
  let grossTotal = 0;
  const taxableByOwner = new Map<string, TaxableByCategory>();
  for (const src of sources) {
    grossTotal += src.grossCents;
    // Booked under its provenance category — the jurisdiction owns the inclusion %,
    // so the engine never pre-applies a fraction (§5.4). A source may book less than
    // its gross as taxable (a returned-basis fund draw, an accrued-interest booking
    // with gross 0) — honor its explicit taxable amount so the gross-up baseline sees
    // the same taxable base the tax seam will (#94).
    let map = taxableByOwner.get(src.ownerId);
    if (map === undefined) {
      map = {};
      taxableByOwner.set(src.ownerId, map);
    }
    addCategory(map, src.taxCategory, src.taxableCents ?? src.grossCents);
  }
  let taxTotal = 0;
  for (const taxable of taxableByOwner.values()) taxTotal += computeTaxCents(taxable);
  return { netIncomeCents: grossTotal - taxTotal, taxableByOwner };
}

/**
 * The desired-withdrawal (decumulation) channel (§7, D0). Runs BEFORE the waterfall,
 * alongside {@link import("./rmd").buildRmdSources} / {@link
 * import("./governmentBenefit").buildGovernmentBenefitSources}: it pulls cash out of
 * investment accounts (mutating `assetBalances`) and re-injects it as income sources
 * so the withdrawal is taxed once at the §5.3 chokepoint and its net lands where the
 * waterfall routes take-home — funding the month's obligations instead of the plan
 * "retiring onto a credit card" (#35).
 *
 * The amount is NEED-based, not a fixed safe-withdrawal rate (D1, §7 RESOLVED):
 * `gap = obligations − non-withdrawal net income`, then the existing liquid buffer is
 * spent first (D2), so the channel only liquidates investments for `gap − liquidBuffer`.
 * Sources are drawn in {@link DEFAULT_LIQUIDATION_ORDER} (capital-gains → ordinary-income → tax-exempt),
 * or in a caller-supplied `liquidationOrder` override (§16 overridable), and
 * gated by {@link isLiquidatable}. EVERY draw injects at its account's own withdrawal
 * category and is grossed up so its net still covers the need (D3): the draw is solved
 * as the least fixed point of `gross = need + inducedTax(gross)`, where the induced tax
 * is `computeTaxCents` differenced over the WHOLE return (base vs base-plus-draw). Two
 * consequences follow. A draw taxed at 0% on its own but pulling a government benefit
 * into provisional-income taxability is still sized to net the need (#100), because the
 * whole-return difference sees the benefit it drags in. And the draw nets the need
 * EXACTLY rather than approximately — a fixed point satisfies `gross − tax = need` by
 * construction — where inverting an implied rate (`need / (1 − rate)`) assumes tax scales
 * proportionally with the draw and so falls short against a real bracket, which sits at
 * `offset + rate × draw`. A genuinely untaxed draw nets one-for-one, the fixed point
 * being `need` itself.
 *
 * Two limits of this sizing, both about what the seam is assumed to look like. Neither
 * binds `usJurisdiction`, and both are things a NEW jurisdiction could walk into:
 *
 * 1. The climb assumes the seam is MONOTONE — a larger draw never owes less tax. That is
 *    what makes a rising sequence stop at the least (cheapest) solution rather than
 *    oscillate. A refundable credit that phases IN over the draw (EITC-shaped: more
 *    income buys a bigger credit, so net tax FALLS) breaks the assumption, and the loop
 *    would return whatever it happened to hold when the iteration budget ran out.
 * 2. The draw is only ever sized UP from `need`, never down. Under a notch — a threshold
 *    that taxes the whole return more once crossed, rather than just the excess, as
 *    Australia's Medicare Levy Surcharge does — deliberately drawing LESS and carrying a
 *    small shortfall can leave the household better off than paying the lump. This
 *    channel cannot express that: it will cross the notch, and if the lump outruns the
 *    balance it empties the account. Nothing in a bracket-and-phase-in seam has a notch,
 *    so this is latent (#107).
 *
 * RMD interaction (no double-withdraw): RMD sources are already in `nonWithdrawalSources`,
 * so their income shrinks the gap and their forced pre-tax draw already reduced the
 * balances here — total pre-tax drawn settles at `max(desired, required)` without an
 * additive draw (the full binding + its dedicated tests stay in #32).
 *
 * Absent tax seam (v1 null jurisdiction) → tax is 0, so every draw nets one-for-one.
 *
 * Returns both the taxable withdrawal `sources` (fed to the waterfall) and the
 * `liquidDrawdownCents` — the slice of the gap the liquid buffer covers before any
 * investment is sold (issue #99). That drawdown never becomes a waterfall source: the
 * cash is already in the account and the §5.1 cascade spends it directly, so injecting
 * it would double-count and mis-tax it. It is returned purely so the flow view can show
 * "savings are covering this month" rather than a misleading zero-income band.
 */
export interface WithdrawalPlan {
  /** Taxable investment-liquidation income sources for the waterfall (may be empty). */
  readonly sources: IncomeSourceMonth[];
  /**
   * The gap covered by drawing the existing liquid buffer this month — cash the
   * household is living on because income fell short. Reporting-only (issue #99): it is
   * NOT a waterfall source and is not taxable. 0 when income covered the month.
   */
  readonly liquidDrawdownCents: Cents;
}

export function buildWithdrawalSources(
  state: WithdrawalState,
  jurisdiction: Jurisdiction,
  month: number,
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

  // Spend down the existing liquid buffer first (D2): the §5.1 cascade will charge
  // the shortfall the withdrawal leaves uncovered against the liquid account, draining
  // it to 0 before any investment is sold. So only fund what the buffer can't.
  const liquidBuffer =
    state.liquidAccount !== null
      ? Math.max(0, state.assetBalances.get(state.liquidAccount.id) ?? 0)
      : 0;
  // The buffer covers `min(gap, buffer)` of the gap — the whole gap when the buffer can
  // absorb it (need ≤ 0, nothing sold), else the whole buffer (the rest is sold below).
  // This IS the reported savings drawdown (issue #99), the same in both branches.
  const liquidDrawdownCents = Math.min(gap, liquidBuffer);
  let need = gap - liquidBuffer;
  if (need <= 0) return { sources: [], liquidDrawdownCents };

  const rankMap = liquidationRankMap(liquidationOrder);
  const orderedSources = state.accounts
    .filter((a) => isLiquidatable(a, state, month))
    .sort((a, b) => liquidationRank(a, rankMap) - liquidationRank(b, rankMap));

  const sources: IncomeSourceMonth[] = [];
  for (const account of orderedSources) {
    if (need <= 0) break;
    const balance = state.assetBalances.get(account.id) ?? 0;
    if (balance <= 0) continue;

    const withdrawalCategory = account.taxProfile.withdrawalCategory;
    // Cost basis (#94): only the GAIN portion of a draw is taxable — but WHICH portion
    // is the jurisdiction's call, not the engine's. The engine owns and passes the basis
    // state; the jurisdiction owns the return-of-capital policy and accounting method
    // (`taxableWithdrawalCents`, mirroring the RMD seam). Absent seam → the whole draw is
    // taxable, which restores the "engine passes the full gross" default and is exactly
    // the pre-tax "fully taxable" behavior for a basis-0 account.
    const basis = Math.max(0, state.basisByAccount.get(account.id) ?? 0);
    const gainOf = (draw: Cents): Cents =>
      jurisdiction.taxableWithdrawalCents?.(
        { grossCents: draw, basisCents: basis, balanceCents: balance, category: withdrawalCategory },
        ctx,
      ) ?? draw;
    // Difference the tax over the WHOLE return, not the draw's own-category rate: a
    // capital-gains / tax-exempt draw can read as 0% on its own yet still raise the
    // return's tax by pulling a government benefit into provisional-income taxability
    // (#100), and an own-category rate would multiply by 0 and miss it. The category is
    // the account's own neutral provenance, never a US vehicle string. Only the gain is
    // booked to the taxable map — the full gross is still paid out as take-home below.
    const base = taxableByOwner.get(account.ownerId) ?? {};
    const withDraw = (draw: Cents): TaxableByCategory => ({
      ...base,
      [withdrawalCategory]: (base[withdrawalCategory] ?? 0) + gainOf(draw),
    });
    const baseTax = computeTaxCents(base);
    const inducedTax = (draw: Cents): Cents => computeTaxCents(withDraw(draw)) - baseTax;
    // Sizing the draw is circular: the tax depends on the draw, and the draw has to
    // cover the tax. Solve it by climbing to the least fixed point of
    // `gross = need + inducedTax(gross)` (see the doc above for why a fixed point is the
    // right target and why the closed-form inversion is not). Climb from `need` rather
    // than down from a guess — since the tax only rises with the draw, a rising sequence
    // stops at the FIRST solution, and a first solution is the cheapest liquidation that
    // nets the need. Iterate rather than invert because `computeTaxCents` is a black box:
    // the jurisdiction supplies it, so its form is unknown here by construction.
    let gross = Math.min(balance, need);
    for (let i = 0; i < GROSS_UP_ITERATIONS; i++) {
      const wanted = need + inducedTax(gross);
      // The account cannot cover its own gross-up: take what is there and let the rest
      // of the need fall to the next source in the liquidation order.
      if (wanted >= balance) {
        gross = balance;
        break;
      }
      if (wanted === gross) break;
      gross = wanted;
    }
    // The net this actually delivers reduces the remaining need, and the owner's taxable
    // base rises for any later draw.
    const taxOnGross = computeTaxCents(withDraw(gross)) - baseTax;
    const netDelivered = gross - taxOnGross;

    // The taxable gain is what the jurisdiction returned; the rest of the gross is
    // principal returned. Reduce the account's basis by that principal (method-agnostic:
    // gross − taxable), so the next draw is measured against the basis that remains (#94).
    const gainCents = gainOf(gross);
    state.basisByAccount.set(account.id, basis - (gross - gainCents));
    state.assetBalances.set(account.id, balance - gross);
    taxableByOwner.set(account.ownerId, withDraw(gross));
    need -= netDelivered;
    sources.push({
      ownerId: account.ownerId,
      grossCents: gross,
      taxCategory: withdrawalCategory,
      taxableCents: gainCents,
      // Report the draw by the account it came from (issue #99): the account id keys the
      // band and its label names it, so an "emergency fund" goal draining reads as that
      // fund by name rather than as an anonymous `capitalGains` band.
      sourceId: account.id,
      label: account.label ?? account.id,
    });
  }

  return { sources, liquidDrawdownCents };
}
