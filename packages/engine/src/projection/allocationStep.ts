import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { TaxCategory } from "../cashFlowSeries";
import { orderBudgetLines, resolveBudgetLineMonthlyCents } from "../budgetLine";
import { runWaterfall, type IncomeSourceMonth } from "./waterfall";
import type { SimState } from "./runState";
import type { SimOwnedSeries } from "./simulate.types";

export function buildIncomeSources(
  incomeSeries: readonly SimOwnedSeries[],
  month: number,
): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  for (const s of incomeSeries) {
    const waterfallInflowCents = s.series.getMonthlyCents(month);
    if (waterfallInflowCents === 0 && s.planDescriptor === undefined) continue;
    sources.push({
      ownerId: s.ownerId,
      waterfallInflowCents,
      taxCategory: s.series.taxCategory ?? "ordinaryIncome",
      planDescriptor: s.planDescriptor,
      // One source per income series, so two jobs read apart rather than collapsing
      // into one `wages` band. Fall back to the owner when a series carries no id.
      sourceId: s.sourceId ?? `income:${s.ownerId}`,
      label: s.label ?? "Income",
    });
  }
  return sources;
}

/**
 * Step 3/6: route this month's income through the allocation waterfall, apply the
 * per-account deposits, then charge any uncovered obligation as a deficit on the first
 * liquid account so the cascade (next) drains liquid assets before reaching for credit.
 * Updates the per-person annual deferral accumulator so caps hold across the year.
 *
 * The waterfall's pre-cascade shortfall is NOT surfaced: it is a cash-flow gap posted
 * against the liquid account, not a funding failure. Only the shortfall surviving
 * {@link applyShortfallCascade} means anything to a caller.
 */
export function allocateMonth(
  state: SimState,
  incomeSources: readonly IncomeSourceMonth[],
  ctx: JurisdictionContext,
  jurisdiction: Jurisdiction,
  sharedObligationCents: Cents,
  month: number,
): {
  taxCents: Cents;
  taxByCategoryCents: Partial<Record<TaxCategory, Cents>> | undefined;
  taxBySourceCents: Readonly<Record<string, Cents>> | undefined;
  deferralBySourceCents: Readonly<Record<string, Cents>>;
  contributions: readonly { accountId: string; monthlyCents: Cents }[];
} {
  // Per person, not per household: the limit (with any age-banded catch-up) depends on
  // the individual's age. Resolved in the room callback below; no birth year → base limit.
  const deferralLimit = jurisdiction.retirementDeferralLimitCents;
  // Sinking-fund pace is growth-aware; unknown account → rate 0, a flat even spread.
  const accountsById = new Map(state.accounts.map((a) => [a.id, a]));

  // In waterfall priority order, so funding draws from discretionary as the tiers imply.
  const contributions = orderBudgetLines(state.contributionLines).flatMap((line) => {
    if (line.target.kind !== "account") return [];
    const accountId = line.target.accountId;
    const monthlyCents = resolveBudgetLineMonthlyCents(line, {
      month,
      year: ctx.year,
      currentBalanceCents: state.assetBalances.get(accountId) ?? 0,
      fundMonthlyRate: accountsById.get(accountId)?.getMonthlyRateAt(month) ?? 0,
    });
    return monthlyCents > 0 ? [{ accountId, monthlyCents }] : [];
  });

  const result = runWaterfall({
    personIds: state.personIds,
    incomeSources,
    sharedObligationCents,
    sharedScheme: state.sharedScheme,
    surplusDestination: state.surplusDestination,
    goals: state.goals,
    contributions,
    nowMonth: month,
    goalFundMonthlyRate: (id) => accountsById.get(id)?.getMonthlyRateAt(month) ?? 0,
    accountBalanceCents: (id) => state.assetBalances.get(id) ?? 0,
    liquidAccountId: state.liquidAccount?.id ?? null,
    computeTaxCents: (taxableByCategory) => jurisdiction.computeTaxCents(taxableByCategory, ctx),
    // Required of every jurisdiction (a zero-tax one returns `{}`), so always wired;
    // `runWaterfall` enforces that a tax-charging month reconciles per source.
    computeTaxByCategoryCents: (taxableByCategory) =>
      jurisdiction.computeTaxByCategoryCents(taxableByCategory, ctx),
    remainingDeferralRoomCents: (pid) => {
      if (deferralLimit === undefined) return Infinity;
      const birthYear = state.personsById.get(pid)?.birthYear;
      const age = birthYear === undefined ? undefined : ctx.year - birthYear;
      const limit = deferralLimit({ year: ctx.year, age });
      const used = state.deferredByPersonYear.get(`${pid}|${ctx.year}`) ?? 0;
      return Math.max(0, limit - used);
    },
  });

  for (const [id, amount] of result.accountDepositsCents) {
    state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) + amount);
    // Post-tax deposits add cost basis; pre-tax deposits (deferrals, employer match) add
    // none — taxed on the way OUT, so basis stays 0 and the whole draw is taxable.
    const acc = accountsById.get(id);
    if (acc !== undefined && !acc.taxProfile.contributionsPreTax) {
      state.basisByAccount.set(id, (state.basisByAccount.get(id) ?? 0) + amount);
    }
  }

  if (result.shortfallCents > 0 && state.liquidAccount !== null) {
    const id = state.liquidAccount.id;
    state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) - result.shortfallCents);
  }

  for (const [pid, amount] of result.deferredByPersonCents) {
    const key = `${pid}|${ctx.year}`;
    state.deferredByPersonYear.set(key, (state.deferredByPersonYear.get(key) ?? 0) + amount);
  }

  // Contributions go back so the caller can unwind any unfundable slice after the cascade.
  return {
    taxCents: result.taxCents,
    taxByCategoryCents: result.taxByCategoryCents,
    taxBySourceCents: result.taxBySourceCents,
    deferralBySourceCents: result.deferralBySourceCents,
    contributions,
  };
}

/**
 * Undo the phantom part of a COMMITTED contribution. A contribution deposits its FULL
 * amount and returns the unfunded remainder as a shortfall (see
 * {@link import("./waterfall").runWaterfall}); if neither savings nor credit covers that
 * shortfall, the uncovered slice was still deposited, booking an asset the household
 * never funded. Reverse exactly that slice, lowest-priority contribution first, removing
 * both the amount and the cost basis `allocateMonth` added.
 */
export function unwindUnfundedContributions(
  state: SimState,
  contributions: readonly { accountId: string; monthlyCents: Cents }[],
  uncoveredCents: Cents,
): void {
  if (uncoveredCents <= 0) return;
  const accountsById = new Map(state.accounts.map((a) => [a.id, a]));
  let remaining = uncoveredCents;
  for (let i = contributions.length - 1; i >= 0 && remaining > 0; i--) {
    const c = contributions[i];
    const cut = Math.min(remaining, c.monthlyCents);
    if (cut <= 0) continue;
    state.assetBalances.set(c.accountId, (state.assetBalances.get(c.accountId) ?? 0) - cut);
    const acc = accountsById.get(c.accountId);
    if (acc !== undefined && !acc.taxProfile.contributionsPreTax) {
      state.basisByAccount.set(c.accountId, Math.max(0, (state.basisByAccount.get(c.accountId) ?? 0) - cut));
    }
    remaining -= cut;
  }
}

/**
 * Last month's credited interest as this month's taxable income. `compoundAssets` already
 * credited the cash to each buffer's balance, so these carry `waterfallInflowCents` 0 —
 * re-injecting would double-credit — and are taxed via `taxableCents`. It IS real
 * household cash, so it also reports {@link IncomeSourceMonth.cashInflowCents}: counted
 * once as a balance credit and once as a cash flow, never twice as a balance. Empty in
 * month 1 and whenever every buffer's return was zero. Interest is ordinary income, so it
 * enters the provisional-income formula and can pull a benefit into taxability.
 */
export function buildInterestAccrualSources(state: SimState): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  // One source PER ACCOUNT, in the plan's account order (stable, so the cash-flow chart
  // keeps each band's identity across months). An emptied buffer then stops booking
  // interest entirely while a still-funded reserve keeps earning under its OWN name; one
  // merged "Savings interest" line made a drained account look like it was still earning.
  // The app's Simple view re-collapses `savingsInterest` bands (keyed on reportCategory).
  for (const acc of state.accounts) {
    const accrued = state.accruedReturnByAccount.get(acc.id);
    if (accrued === undefined || accrued.cents <= 0) continue;
    // `reportCategory` lets the UI group these without parsing the id; `taxCategory`
    // keeps them taxed and rolled up as ordinary income. Other interest kinds
    // (brokerage/bond) will later carry their own provenance.
    sources.push({
      ownerId: acc.ownerId,
      waterfallInflowCents: 0,
      cashInflowCents: accrued.cents,
      taxCategory: accrued.category,
      taxableCents: accrued.cents,
      reportCategory: "savingsInterest",
      sourceId: `interest:${acc.id}`,
      label: acc.label ?? acc.id,
    });
  }
  return sources;
}
