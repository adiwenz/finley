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
 * Step 3/6: route this month's income through the allocation waterfall, applying the
 * per-account deposits to asset balances, then charge any uncovered obligation as a
 * deficit on the first liquid account so the cascade (next) drains liquid assets before
 * reaching for credit. Updates the per-person annual deferral accumulator so caps hold
 * across the year, and returns the tax charged this month, already reflected in take-home.
 *
 * The waterfall's pre-cascade shortfall is NOT surfaced: it is a cash-flow gap, not a
 * funding failure, since it is posted against the liquid account for savings to absorb.
 * Only the shortfall surviving {@link applyShortfallCascade} means anything to a caller.
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
  // The deferral cap is per person, not per household: the limit (with any age-banded
  // catch-up) depends on the individual's age this year. Resolved lazily in the room
  // callback below; no birth year → the base limit.
  const deferralLimit = jurisdiction.retirementDeferralLimitCents;
  // Sinking-fund pace is growth-aware: a goal leaning on its fund's return needs a
  // smaller monthly contribution. Unknown account → rate 0, a flat even spread.
  const accountsById = new Map(state.accounts.map((a) => [a.id, a]));

  // Resolved in waterfall priority order, so funding draws from discretionary in the
  // order the tiers imply.
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
    // Post-tax deposits (surplus sweep, goal funding) add cost basis — already-taxed
    // dollars. Pre-tax deposits (deferrals + employer match into a tax-deferred
    // account) add none: taxed on the way OUT, so basis stays 0 and the whole draw is
    // taxable.
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

  // Resolved contributions go back so the caller can unwind any unfundable slice once
  // the cascade has decided how much of the shortfall genuinely couldn't be met.
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
 * {@link import("./waterfall").runWaterfall}). If neither savings nor any credit card
 * covers that shortfall — an insolvent month — the uncovered slice was still deposited,
 * booking an asset the household never funded and spiking net worth by a contribution
 * it could not make. Reverse exactly that slice, lowest-priority contribution first, so
 * net worth reflects only what moved and the insolvency isn't masked. Removes the
 * unfundable part of both the amount and the cost basis `allocateMonth` added.
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
 * Last month's credited interest as this month's taxable income. `compoundAssets`
 * already credited the cash to each buffer's balance, so these carry
 * `waterfallInflowCents` 0 — the allocation waterfall places nothing (re-injecting
 * would double-credit) and the interest is taxed via `taxableCents`. It IS real
 * household cash, so it also reports {@link IncomeSourceMonth.cashInflowCents}: the
 * cash-flow view shows $500 of interest and its tax netting to $400 while the balance
 * still shows $500 — counted once as a balance credit and once as a cash flow, never
 * twice as a balance. Empty in month 1 (nothing has compounded) and whenever every
 * buffer's return was zero. Interest is ordinary income, so it enters the
 * provisional-income formula and can pull a government benefit into taxability.
 */
export function buildInterestAccrualSources(state: SimState): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  // One source PER ACCOUNT, in the plan's account order (stable, so the cash-flow chart
  // keeps each band's identity across months). A band per cash account is the honest
  // read: an emptied buffer stops booking interest entirely (accrued 0, skipped below)
  // while a still-funded reserve or cash goal keeps earning under its OWN name — one
  // merged "Savings interest" line made a drained account look like it was still
  // earning. The app's Simple view re-collapses every `savingsInterest` band into one
  // (keyed on reportCategory, not the id); Advanced shows them per account.
  for (const acc of state.accounts) {
    const accrued = state.accruedReturnByAccount.get(acc.id);
    if (accrued === undefined || accrued.cents <= 0) continue;
    // Zero allocation-gross (cash already in the balance) but a real cash inflow for
    // the flow view, under a stable per-account id so the chart bands it and deducts
    // its tax. `reportCategory: "savingsInterest"` lets the UI group it without parsing
    // the id, while `taxCategory` keeps it taxed and rolled up as ordinary income. The
    // label is the account's human name (a goal fund reads as its goal), else the id.
    // Other interest kinds (brokerage/bond) will later carry their own provenance.
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
