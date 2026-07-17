import type { Cents } from "../money";
import type { Account } from "../account";
import type { TaxCategory } from "../cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import { isEarmarkedForDisposition, type Goal } from "../goal";
import type { IncomeSourceMonth } from "./waterfall";

/** A per-owner map of taxable amount by {@link TaxCategory} (mirrors the waterfall). */
type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

/**
 * The slice of the simulator's state the desired-withdrawal (decumulation)
 * bookkeeping reads and mutates. A structural view over `SimState` — declaring it
 * here (rather than importing the whole mutable `SimState`) keeps that state object
 * private to the simulator while this module stays independently testable, mirroring
 * {@link import("./rmd").RmdState} and {@link import("./socialSecurity").EarningsState}.
 */
export interface WithdrawalState {
  /** Every asset account — the withdrawal walks these as liquidation sources. */
  readonly accounts: readonly Account[];
  /** The authoritative mutable balances; a drawdown reduces its source account in place. */
  readonly assetBalances: Map<string, Cents>;
  /**
   * The first liquid account (the §5.1 shortfall sink). Its beginning-of-month
   * balance is spent down BEFORE any investment is liquidated (D2): the withdrawal
   * only funds the shortfall the liquid buffer can't, so the cascade drains cash first.
   */
  readonly liquidAccount: Account | null;
  /** Funding goals — a `convertToEquity`/`spend` goal through its target month earmarks its fund (D4, §5.2). */
  readonly goals: readonly Goal[];
}

/**
 * The order investment accounts are liquidated in during decumulation (D2), keyed
 * by the account's neutral {@link import("../account").AccountTaxProfile.withdrawalCategory}:
 * `capitalGains` first (brokerage + eligible goal funds, least tax friction — no
 * gross-up), then `ordinaryIncome` (taxed like an RMD), then `taxExempt` last
 * (preserve tax-free growth). Lower rank = drawn first.
 */
const LIQUIDATION_ORDER: Partial<Record<TaxCategory, number>> = {
  capitalGains: 0,
  ordinaryIncome: 1,
  taxExempt: 2,
};

/** Liquidation rank for an account, from its withdrawal category (unknown → last). */
function liquidationRank(account: Account): number {
  return LIQUIDATION_ORDER[account.taxProfile.withdrawalCategory] ?? 99;
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
  account: Account,
  state: WithdrawalState,
  month: number,
): boolean {
  if (state.liquidAccount !== null && account.id === state.liquidAccount.id) return false;
  for (const goal of state.goals) {
    if (goal.fundAccountId !== account.id) continue;
    if (isEarmarkedForDisposition(goal.disposition, goal.targetDate, month)) return false;
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
    // Full gross booked under its provenance category — the jurisdiction owns the
    // inclusion %, so the engine never pre-applies a fraction (§5.4).
    let map = taxableByOwner.get(src.ownerId);
    if (map === undefined) {
      map = {};
      taxableByOwner.set(src.ownerId, map);
    }
    addCategory(map, src.taxCategory, src.grossCents);
  }
  let taxTotal = 0;
  for (const taxable of taxableByOwner.values()) taxTotal += computeTaxCents(taxable);
  return { netIncomeCents: grossTotal - taxTotal, taxableByOwner };
}

/**
 * The desired-withdrawal (decumulation) channel (§7, D0). Runs BEFORE the waterfall,
 * alongside {@link import("./rmd").buildRmdSources} / {@link
 * import("./socialSecurity").buildSocialSecuritySources}: it pulls cash out of
 * investment accounts (mutating `assetBalances`) and re-injects it as income sources
 * so the withdrawal is taxed once at the §5.3 chokepoint and its net lands where the
 * waterfall routes take-home — funding the month's obligations instead of the plan
 * "retiring onto a credit card" (#35).
 *
 * The amount is NEED-based, not a fixed safe-withdrawal rate (D1, §7 RESOLVED):
 * `gap = obligations − non-withdrawal net income`, then the existing liquid buffer is
 * spent first (D2), so the channel only liquidates investments for `gap − liquidBuffer`.
 * Sources are drawn in {@link LIQUIDATION_ORDER} (capital-gains → ordinary-income → tax-exempt) and
 * gated by {@link isLiquidatable}. Non-pre-tax draws inject as a non-taxable category
 * (net one-for-one, no gross-up); pre-tax draws inject as `ordinaryIncome`, grossed up
 * by a marginal rate differenced from `computeTaxCents` so the net still covers the
 * need (D3). The estimate is single-pass; the small residual self-corrects next month.
 *
 * RMD interaction (no double-withdraw): RMD sources are already in `nonWithdrawalSources`,
 * so their income shrinks the gap and their forced pre-tax draw already reduced the
 * balances here — total pre-tax drawn settles at `max(desired, required)` without an
 * additive draw (the full binding + its dedicated tests stay in #32).
 *
 * Absent tax seam (v1 null jurisdiction) → tax is 0, so pre-tax draws net one-for-one.
 */
export function buildWithdrawalSources(
  state: WithdrawalState,
  jurisdiction: Jurisdiction,
  month: number,
  nonWithdrawalSources: readonly IncomeSourceMonth[],
  obligationsCents: Cents,
  ctx: JurisdictionContext,
): IncomeSourceMonth[] {
  const computeTaxCents = (taxable: TaxableByCategory): Cents =>
    jurisdiction.computeTaxCents(taxable, ctx);

  const { netIncomeCents, taxableByOwner } = estimateNetIncome(
    nonWithdrawalSources,
    computeTaxCents,
  );

  const gap = obligationsCents - netIncomeCents;
  if (gap <= 0) return [];

  // Spend down the existing liquid buffer first (D2): the §5.1 cascade will charge
  // the shortfall the withdrawal leaves uncovered against the liquid account, draining
  // it to 0 before any investment is sold. So only fund what the buffer can't.
  const liquidBuffer =
    state.liquidAccount !== null
      ? Math.max(0, state.assetBalances.get(state.liquidAccount.id) ?? 0)
      : 0;
  let need = gap - liquidBuffer;
  if (need <= 0) return [];

  const orderedSources = state.accounts
    .filter((a) => isLiquidatable(a, state, month))
    .sort((a, b) => liquidationRank(a) - liquidationRank(b));

  const sources: IncomeSourceMonth[] = [];
  for (const account of orderedSources) {
    if (need <= 0) break;
    const balance = state.assetBalances.get(account.id) ?? 0;
    if (balance <= 0) continue;

    const withdrawalCategory = account.taxProfile.withdrawalCategory;
    // A withdrawal that produces ordinary income is taxed in full at the chokepoint,
    // so it must be grossed up to net the need; a capital-gains / tax-exempt draw
    // lands one-for-one in v1 (the jurisdiction taxes 0 of it today). "Whole draw is
    // ordinary income" is the neutral signal, not a US vehicle string.
    if (withdrawalCategory === "ordinaryIncome") {
      // Gross up so the withdrawal NETS the needed cash (D3): difference the tax
      // seam at the owner's running taxable income to get the marginal rate on the
      // draw. Cap the gross at the balance; the net it actually delivers reduces the
      // remaining need, and the owner's taxable base rises for any later draw.
      const base = taxableByOwner.get(account.ownerId) ?? {};
      const withDraw = (draw: Cents): TaxableByCategory => ({
        ...base,
        ordinaryIncome: (base.ordinaryIncome ?? 0) + draw,
      });
      const baseTax = computeTaxCents(base);
      const marginalTax = computeTaxCents(withDraw(need)) - baseTax;
      const marginalRate = Math.min(0.99, Math.max(0, marginalTax / need));
      const grossWanted = Math.ceil(need / (1 - marginalRate));
      const gross = Math.min(balance, grossWanted);
      const taxOnGross = computeTaxCents(withDraw(gross)) - baseTax;
      const netDelivered = gross - taxOnGross;

      state.assetBalances.set(account.id, balance - gross);
      taxableByOwner.set(account.ownerId, withDraw(gross));
      need -= netDelivered;
      sources.push({ ownerId: account.ownerId, grossCents: gross, taxCategory: "ordinaryIncome" });
    } else {
      // A capital-gains / tax-exempt draw injects at its own withdrawal category and
      // nets one-for-one in v1 (the jurisdiction taxes 0 of it today — basis
      // tracking and preferential rates are a later slice). The category is the
      // account's own neutral provenance, never a US vehicle string.
      const gross = Math.min(balance, need);
      state.assetBalances.set(account.id, balance - gross);
      need -= gross;
      sources.push({ ownerId: account.ownerId, grossCents: gross, taxCategory: withdrawalCategory });
    }
  }

  return sources;
}
