/**
 * Annual federal income-tax settlement — the ONE place a taxable withdrawal is still grossed
 * up. Every other month sells exactly what an obligation needs (see {@link
 * import("./withdrawal").buildWithdrawalSources}, {@link
 * import("./fundingDrawStep").resolveOrderedFundingDraw}); this is the exception, because here
 * the "obligation" IS the tax bill, and a taxable sale to fund it enlarges the very bill it is
 * raising cash for. Resolving that requires recursion: sell → the sale's gain raises the bill →
 * sell more → repeat until the amount raised covers the (now larger) bill.
 *
 * Runs once, at the year's last processed month (December, or — via `isFinalMonth` — a funding
 * block that truncates the run before December ever arrives), after that month's own income has
 * already folded into {@link
 * import("./runState").SimState.taxableIncomeByPersonYear} (via {@link
 * import("./allocationStep").allocateMonth}) — so the base this reads is the COMPLETE year,
 * regardless of which month each dollar of taxable income actually landed in.
 *
 * Federal tax is single-filer PER PERSON ({@link
 * import("../jurisdiction/jurisdiction").Jurisdiction.computeTaxCents} is called once per
 * person, never pooled across a household), so settlement runs person by person: each sells
 * from their OWN accounts (cash first, then the ordinary liquidation order) before any
 * shortfall borrows against the household's shared credit cards — the same cascade cards
 * {@link import("./liabilitySteps").applyShortfallCascade} uses, in the same ascending-APR
 * order, so a settlement that outruns both assets and credit reads as insolvency exactly like
 * any other unfundable obligation.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { SimState } from "./runState";
import { DEFAULT_LIQUIDATION_ORDER } from "./withdrawal";
import {
  addCategory,
  attributeTaxToSources,
  type SourceTaxable,
  type TaxableByCategory,
} from "./taxAttribution";
import {
  assertPersonTaxBreakdownReconciles,
  assertTaxAttributionReconciles,
} from "./waterfallInvariants";

/** Backstop on the settlement's recursive climb; a realistic bill converges in a few steps. */
const GROSS_UP_ITERATIONS = 1_000;

/** December, or every 12th month after it. */
export function isAnnualSettlementMonth(month: number): boolean {
  return month % 12 === 11;
}

/** One account sold to raise cash toward a person's tax bill. */
export interface SettlementDraw {
  readonly ownerId: string;
  readonly accountId: string;
  readonly label: string;
  readonly category: TaxCategory;
  readonly grossCents: Cents;
  readonly gainCents: Cents;
  readonly principalCents: Cents;
}

export interface AnnualTaxSettlementResult {
  /** Σ of every person's FINAL annual liability, after settlement's own induced gains. */
  readonly totalTaxCents: Cents;
  /** Household tax per {@link TaxCategory}, summed across persons. `{}` when nothing is owed. */
  readonly taxByCategoryCents: TaxableByCategory;
  /**
   * Household tax per income SOURCE, summed across persons — keyed like {@link
   * import("./waterfall.types").WaterfallResult.taxBySourceCents} (`sourceId` falling back to
   * tax category), so the chart that bands tax by source can show WHERE the year's liability
   * actually came from. Apportioned within each person/category by {@link
   * attributeTaxToSources} against {@link
   * import("./runState").SimState.taxableBySourceByPersonYear} (average-rate, not marginal —
   * the same policy the monthly payroll-tax attribution already uses). A settlement draw's OWN
   * induced gain is attributed to ITS account, keyed `tax-settlement:<accountId>`, matching
   * {@link import("./simulate").simulateHousehold}'s reporting bands for the same draws. `{}`
   * when nothing is owed.
   */
  readonly taxBySourceCents: Readonly<Record<string, Cents>>;
  /** Every account sale this settlement made, across every person, in resolution order. */
  readonly draws: readonly SettlementDraw[];
  /** Raised by selling assets — Σ `draws[].grossCents`. */
  readonly raisedCents: Cents;
  /** Raised by borrowing against the household's cascade cards once assets ran out. */
  readonly borrowedCents: Cents;
  /** Still unfunded after assets AND credit — the terminal insolvency case. */
  readonly uncoveredCents: Cents;
}

const EMPTY_RESULT: AnnualTaxSettlementResult = {
  totalTaxCents: 0,
  taxByCategoryCents: {},
  taxBySourceCents: {},
  draws: [],
  raisedCents: 0,
  borrowedCents: 0,
  uncoveredCents: 0,
};

/**
 * One person's recursive solve: sell from `sources` (already ordered) until the cash raised
 * covers the CURRENT bill — which itself grows as each sale's gain stacks onto `runningBase`.
 * Mutates `state.assetBalances`/`basisByAccount` for every account it draws from. Returns the
 * person's FINAL liability (post-settlement) and what was actually raised; the caller resolves
 * any gap through credit.
 */
function settlePerson(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  ownerId: string,
  annualBase: TaxableByCategory,
  rankMap: Partial<Record<TaxCategory, number>>,
): { finalTaxCents: Cents; raisedCents: Cents; draws: SettlementDraw[] } {
  const computeTax = (base: TaxableByCategory): Cents => jurisdiction.computeTaxCents(base, ctx);
  let runningBase: TaxableByCategory = { ...annualBase };
  const initialBill = computeTax(runningBase);
  if (initialBill <= 0) return { finalTaxCents: Math.max(0, initialBill), raisedCents: 0, draws: [] };

  const sources = state.accounts
    .filter((a) => a.ownerId === ownerId)
    .sort((a, b) => {
      const aLiquid = state.liquidAccount !== null && a.id === state.liquidAccount.id;
      const bLiquid = state.liquidAccount !== null && b.id === state.liquidAccount.id;
      if (aLiquid !== bLiquid) return aLiquid ? -1 : 1;
      const ra = rankMap[a.taxProfile.withdrawalCategory] ?? 99;
      const rb = rankMap[b.taxProfile.withdrawalCategory] ?? 99;
      return ra - rb;
    });

  let raised = 0;
  const draws: SettlementDraw[] = [];
  for (const account of sources) {
    const currentBill = computeTax(runningBase);
    if (raised >= currentBill) break;
    const balance = state.assetBalances.get(account.id) ?? 0;
    if (balance <= 0) continue;

    const basis = Math.max(0, state.basisByAccount.get(account.id) ?? 0);
    const category = account.taxProfile.withdrawalCategory;
    const basisFraction = balance > 0 ? Math.min(1, basis / balance) : 0;
    const gainOf = (gross: Cents): Cents =>
      jurisdiction.taxableWithdrawalCents?.(
        { grossCents: gross, basisCents: basis, balanceCents: balance, category },
        ctx,
      ) ?? gross - Math.round(gross * basisFraction);
    const withGain = (gross: Cents): TaxableByCategory => ({
      ...runningBase,
      [category]: (runningBase[category] ?? 0) + gainOf(gross),
    });
    const need = currentBill - raised;
    const inducedTax = (gross: Cents): Cents => computeTax(withGain(gross)) - currentBill;

    // Least fixed point of `gross = need + inducedTax(gross)`: the same climb as an ordinary
    // gross-up, but here `need` is this person's REMAINING annual bill, not a fixed purchase
    // price — selling enough to cover it is exactly what makes the raised total converge to
    // the bill the sale itself enlarged.
    let gross = Math.min(balance, need);
    for (let i = 0; i < GROSS_UP_ITERATIONS; i++) {
      const wanted = need + inducedTax(gross);
      if (wanted >= balance) {
        gross = balance;
        break;
      }
      if (wanted === gross) break;
      gross = wanted;
    }
    if (gross <= 0) continue;

    const gain = gainOf(gross);
    runningBase = withGain(gross);
    raised += gross;
    state.assetBalances.set(account.id, balance - gross);
    state.basisByAccount.set(account.id, Math.max(0, basis - (gross - gain)));
    draws.push({
      ownerId,
      accountId: account.id,
      label: account.label ?? account.id,
      category,
      grossCents: gross,
      gainCents: gain,
      principalCents: gross - gain,
    });
  }

  return { finalTaxCents: computeTax(runningBase), raisedCents: raised, draws };
}

/**
 * Settle every person's annual tax liability, mutating `state` (asset sales, credit borrows)
 * and `state.taxableIncomeByPersonYear` (folds in the settlement's own induced gains). A no-op
 * outside a year's last processed month, or when nobody owes anything.
 *
 * `isFinalMonth` covers the one way a year can end WITHOUT reaching {@link
 * isAnnualSettlementMonth}'s December: a funding block truncates the run for good before
 * December arrives — the caller knows this at the point it calls settlement, since a blocked
 * month's own draws are already priced (and correctly excluded from this month's taxable base)
 * before the truncating `break`. Without this, a household blocked mid-year would carry its
 * year's accumulated taxable income into a December the run never reaches — a silent violation
 * of "settled once at year-end" for exactly the households a block is most likely to happen to.
 */
export function settleAnnualTax(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  month: number,
  isFinalMonth: boolean,
): AnnualTaxSettlementResult {
  if (!isAnnualSettlementMonth(month) && !isFinalMonth) return EMPTY_RESULT;

  const rankMap: Partial<Record<TaxCategory, number>> = {};
  DEFAULT_LIQUIDATION_ORDER.forEach((category, i) => {
    if (rankMap[category] === undefined) rankMap[category] = i;
  });

  let totalTaxCents = 0;
  let totalRaisedCents = 0;
  let totalShortfallCents = 0;
  const taxByCategoryCents: TaxableByCategory = {};
  const taxBySourceCents: Record<string, Cents> = {};
  const allDraws: SettlementDraw[] = [];

  for (const pid of state.personIds) {
    const key = `${pid}|${ctx.year}`;
    const annualBase = state.taxableIncomeByPersonYear.get(key) ?? {};
    const { finalTaxCents, raisedCents, draws } = settlePerson(
      state,
      jurisdiction,
      ctx,
      pid,
      annualBase,
      rankMap,
    );
    if (finalTaxCents <= 0) continue;

    allDraws.push(...draws);
    totalTaxCents += finalTaxCents;
    totalRaisedCents += raisedCents;
    totalShortfallCents += Math.max(0, finalTaxCents - raisedCents);

    // The base now includes this settlement's own induced gains — the year is over, so
    // nothing downstream reads it again, but keeping it current avoids a stale accumulator.
    const finalBase: TaxableByCategory = { ...annualBase };
    for (const draw of draws) addCategory(finalBase, draw.category, draw.gainCents);
    state.taxableIncomeByPersonYear.set(key, finalBase);

    const perCategory = jurisdiction.computeTaxByCategoryCents(finalBase, ctx);
    // Per person BEFORE aggregating, so an offsetting error in one person's breakdown cannot
    // cancel against another's and slip past the household check.
    assertPersonTaxBreakdownReconciles(pid, finalTaxCents, perCategory);
    for (const [category, cents] of Object.entries(perCategory)) {
      if (cents) addCategory(taxByCategoryCents, category as TaxCategory, cents);
    }

    // The weights `perCategory` apportions against: the year's real sources (a job, a
    // benefit, an account draw) PLUS this settlement's own induced gains, keyed per account so
    // a sale the settlement itself made reads as its own band rather than vanishing into
    // whichever real source shares its category.
    const sourceWeights: SourceTaxable[] = [
      ...(state.taxableBySourceByPersonYear.get(key)?.values() ?? []),
    ];
    for (const draw of draws) {
      if (draw.gainCents > 0) {
        sourceWeights.push({
          key: `tax-settlement:${draw.accountId}`,
          category: draw.category,
          taxableCents: draw.gainCents,
        });
      }
    }
    attributeTaxToSources(perCategory, sourceWeights, taxBySourceCents);
  }

  if (totalTaxCents <= 0) return EMPTY_RESULT;

  assertTaxAttributionReconciles(totalTaxCents, taxBySourceCents);

  // Assets ran out before the bill did: borrow against the household's shared cascade cards,
  // ascending APR — the same cheapest-first policy `applyShortfallCascade` uses for any other
  // obligation the liquid buffer can't cover.
  let borrowedCents = 0;
  let deficit = totalShortfallCents;
  for (const card of state.cascadeCards) {
    if (deficit <= 0) break;
    if (month <= card.startMonth) continue;
    const currentBal = state.liabilityBalances.get(card.id) ?? 0;
    const limit = card.creditLimitCents;
    const available = limit === null ? deficit : Math.max(0, limit - currentBal);
    const borrow = Math.min(deficit, available);
    if (borrow <= 0) continue;
    state.liabilityBalances.set(card.id, currentBal + borrow);
    deficit -= borrow;
    borrowedCents += borrow;
  }

  return {
    totalTaxCents,
    taxByCategoryCents,
    taxBySourceCents,
    draws: allDraws,
    raisedCents: totalRaisedCents,
    borrowedCents,
    uncoveredCents: Math.max(0, deficit),
  };
}
