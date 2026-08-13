/**
 * The tax year's DECEMBER RECONCILIATION: the year's actual taxable income priced once, minus
 * the estimated installments already paid across the twelve months ({@link
 * import("./runState").SimState.federalTaxPaidByPersonYear}). Only that difference is charged
 * or refunded here — small or zero for a household whose income was all scheduled, larger for
 * a year containing an endogenous taxable withdrawal the estimate could not have known about.
 * A negative difference is a single refund THIS month; earlier months are never rewritten.
 *
 * Also the ONE place a taxable withdrawal is still grossed up. Every other month sells exactly
 * what an obligation needs (see {@link import("./withdrawal").buildWithdrawalSources}, {@link
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
import { orderedLiquidationAccounts } from "./withdrawal";
import {
  addCategory,
  attributeTaxToSources,
  type SourceTaxable,
  type TaxableByCategory,
} from "./taxAttribution";
import { assertTaxAttributionReconciles } from "./waterfallInvariants";
import { annualFederalTax, NO_FEDERAL_TAX_PAID } from "./federalIncomeTax";

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
  /**
   * Σ of every person's reconciliation — final annual liability (after this settlement's own
   * induced gains) minus what they already paid in estimated installments. SIGNED: negative is
   * a household refund, and the year's monthly charges plus this equal the year's actual tax.
   */
  readonly totalTaxCents: Cents;
  /** {@link totalTaxCents} per {@link TaxCategory}, summed across persons; signed likewise. */
  readonly taxByCategoryCents: TaxableByCategory;
  /**
   * Household tax per income SOURCE, summed across persons — keyed like {@link
   * import("./waterfall.types").WaterfallResult.taxBySourceCents} (`sourceId` falling back to
   * tax category), so the chart that bands tax by source can show WHERE the year's liability
   * actually came from. The year's ACTUAL tax apportioned by source, MINUS what the estimated
   * installments already attributed to each — signed, like {@link totalTaxCents}, and summing
   * to it. Apportioned within each person/category by {@link
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
  /** Refunded to the household's liquid account — Σ of the negative reconciliations. */
  readonly refundedCents: Cents;
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
  refundedCents: 0,
  raisedCents: 0,
  borrowedCents: 0,
  uncoveredCents: 0,
};

/**
 * One person's recursive solve: sell from `sources` (already ordered) until the cash raised
 * covers what is still DUE — the current annual bill less the estimated installments already
 * paid — where the bill itself grows as each sale's gain stacks onto `runningBase`. Mutates
 * `state.assetBalances`/`basisByAccount` for every account it draws from. Returns the person's
 * FINAL annual liability (post-settlement, NOT the difference) and what was actually raised;
 * the caller nets the payments off it and resolves any gap through credit.
 */
function settlePerson(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  ownerId: string,
  annualBase: TaxableByCategory,
  paidCents: Cents,
): {
  finalTaxCents: Cents;
  finalBase: TaxableByCategory;
  raisedCents: Cents;
  draws: SettlementDraw[];
} {
  // The SCALAR seam, not {@link annualFederalTax}: this is the climb's marginal-tax probe, run
  // many times per account, and the per-category breakdown it would also compute is unused
  // here. The caller prices the settled base through the shared function once, at the end.
  const computeTax = (base: TaxableByCategory): Cents => jurisdiction.computeTaxCents(base, ctx);
  let runningBase: TaxableByCategory = { ...annualBase };
  const initialTax = computeTax(runningBase);
  // Nothing left to fund: either the year owes nothing, or the installments already covered it
  // (an overpayment the caller turns into a refund). No sale, so the base is untouched.
  if (initialTax - paidCents <= 0) {
    return { finalTaxCents: initialTax, finalBase: runningBase, raisedCents: 0, draws: [] };
  }

  const sources = orderedLiquidationAccounts(
    state.accounts.filter((a) => a.ownerId === ownerId),
    state.liquidAccount?.id ?? null,
  );

  let raised = 0;
  const draws: SettlementDraw[] = [];
  for (const account of sources) {
    const currentBill = computeTax(runningBase);
    // What the sale has to fund is the bill NET of the year's installments; the induced-tax
    // climb below is unaffected, since a constant `paidCents` cancels out of a difference.
    const currentDue = currentBill - paidCents;
    if (raised >= currentDue) break;
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
    const need = currentDue - raised;
    const inducedTax = (gross: Cents): Cents => computeTax(withGain(gross)) - currentBill;

    // Least fixed point of `gross = need + inducedTax(gross)`: the same climb as an ordinary
    // gross-up, but here `need` is this person's REMAINING unpaid bill, not a fixed purchase
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

  return {
    finalTaxCents: computeTax(runningBase),
    finalBase: runningBase,
    raisedCents: raised,
    draws,
  };
}

/**
 * Reconcile every person's annual tax liability against the estimated installments they
 * already paid, mutating `state` (asset sales, credit borrows, a refund to the liquid account)
 * and `state.taxableIncomeByPersonYear` (folds in the settlement's own induced gains). A no-op
 * outside a year's last processed month, or when the estimate happened to land exactly.
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

  let totalTaxCents = 0;
  let totalRaisedCents = 0;
  let totalShortfallCents = 0;
  let refundedCents = 0;
  const taxByCategoryCents: TaxableByCategory = {};
  const taxBySourceCents: Record<string, Cents> = {};
  const allDraws: SettlementDraw[] = [];

  for (const pid of state.personIds) {
    const key = `${pid}|${ctx.year}`;
    const annualBase = state.taxableIncomeByPersonYear.get(key) ?? {};
    const paid = state.federalTaxPaidByPersonYear.get(key) ?? NO_FEDERAL_TAX_PAID;
    const { finalTaxCents, finalBase, raisedCents, draws } = settlePerson(
      state,
      jurisdiction,
      ctx,
      pid,
      annualBase,
      paid.totalCents,
    );
    // The whole point of the year: charge (or refund) only the gap between what the year
    // actually owes and what its estimated installments already collected.
    const reconciliationCents = finalTaxCents - paid.totalCents;
    if (reconciliationCents === 0) continue;

    allDraws.push(...draws);
    totalTaxCents += reconciliationCents;
    totalRaisedCents += raisedCents;
    totalShortfallCents += Math.max(0, reconciliationCents - raisedCents);
    refundedCents += Math.max(0, -reconciliationCents);

    // The base now includes this settlement's own induced gains — the year is over, so
    // nothing downstream reads it again, but keeping it current avoids a stale accumulator.
    state.taxableIncomeByPersonYear.set(key, finalBase);

    // The same annual pricing the year's estimate came from, so `finalTaxCents − paid` is a
    // difference of two comparable figures. Reconciles the breakdown per person BEFORE
    // aggregating, so an offsetting error in one person's cannot cancel against another's.
    const { byCategoryCents: perCategory } = annualFederalTax(jurisdiction, ctx, pid, finalBase);

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
    const actualBySource: Record<string, Cents> = {};
    attributeTaxToSources(perCategory, sourceWeights, actualBySource);

    // Both breakdowns are differences against what was already charged, so the year's twelve
    // monthly figures plus this one sum to the actual annual tax — category by category and
    // source by source, not merely in total.
    for (const category of new Set([
      ...Object.keys(perCategory),
      ...Object.keys(paid.byCategoryCents),
    ]) as Set<TaxCategory>) {
      addCategory(
        taxByCategoryCents,
        category,
        (perCategory[category] ?? 0) - (paid.byCategoryCents[category] ?? 0),
      );
    }
    for (const source of new Set([
      ...Object.keys(actualBySource),
      ...Object.keys(paid.bySourceCents),
    ])) {
      const cents = (actualBySource[source] ?? 0) - (paid.bySourceCents[source] ?? 0);
      if (cents !== 0) taxBySourceCents[source] = (taxBySourceCents[source] ?? 0) + cents;
    }
  }

  // Nothing to report only when nobody moved: two people whose reconciliations cancel still
  // owe a bill and a refund, and both must actually happen.
  if (totalTaxCents === 0 && allDraws.length === 0 && refundedCents === 0 && totalShortfallCents === 0) {
    return EMPTY_RESULT;
  }

  assertTaxAttributionReconciles(totalTaxCents, taxBySourceCents);

  // A net overpayment comes back as cash, into the same account an ordinary surplus lands in.
  // Household-level, not per person: the liquid buffer is where the shortfall cascade already
  // charges everyone's obligations. No liquid account → the refund has nowhere to land and is
  // dropped, exactly as the waterfall drops a surplus with no destination.
  if (refundedCents > 0 && state.liquidAccount !== null) {
    const id = state.liquidAccount.id;
    state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) + refundedCents);
  }

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
    refundedCents,
    raisedCents: totalRaisedCents,
    borrowedCents,
    uncoveredCents: Math.max(0, deficit),
  };
}
