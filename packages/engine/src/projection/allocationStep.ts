import type { Cents } from "../money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { TaxCategory } from "../cashFlowSeries";
import { orderBudgetLines, resolveBudgetLineMonthlyCents } from "../budgetLine";
import { runWaterfall, type IncomeSourceMonth } from "./waterfall";
import type { SimState } from "./runState";
import type { SimOwnedSeries } from "./simulate.types";

/** This month's income sources for the waterfall — one per active income series. */
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
      // Report each income series as its own source, so two jobs read apart
      // rather than collapsing into one `wages` band. Fall back to the owner when a
      // series carries no id (positional labelling is the reporting layer's job).
      sourceId: s.sourceId ?? `income:${s.ownerId}`,
      label: s.label ?? "Income",
    });
  }
  return sources;
}

/**
 * Step 3/6: route this month's income through the allocation waterfall.
 * Applies the waterfall's per-account deposits (pre-tax deferrals + match, goal
 * funding, and the surplus destination) to the asset balances, then charges any
 * uncovered obligation as a deficit on the first liquid account so the
 * cascade (called next) drains liquid assets before reaching for credit.
 *
 * Returns the tax charged this month (already reflected in take-home) — the
 * chokepoint is the only place to observe it. The waterfall's own pre-cascade shortfall
 * is deliberately NOT surfaced: it is a cash-flow gap, not a funding failure, since it
 * is posted against the liquid account for savings to absorb. The only shortfall that
 * means anything to a caller is the one that survives {@link applyShortfallCascade}.
 *
 * The per-person annual deferral accumulator is updated so caps hold across the year.
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
  // The deferral cap is per person, not per household: the annual limit (with any
  // age-banded catch-up) depends on the individual's age this year. Resolve
  // it lazily inside the room callback so each person's birth year drives their
  // own catch-up; a person with no birth year gets the base limit (age omitted).
  const deferralLimit = jurisdiction.retirementDeferralLimitCents;
  // The sinking-fund pace is growth-aware: a goal that leans on its fund's own
  // return needs a smaller monthly contribution. Look the fund's monthly rate up by
  // account id (0 for an unknown account → a flat even spread).
  const accountsById = new Map(state.accounts.map((a) => [a.id, a]));

  // Standing account contributions: resolve each line's amount for THIS month
  // (literal / fill-to-limit / goal-paced) against its own target account's live
  // balance and rate, in waterfall priority order, so the funding step draws them from
  // discretionary in the order the tiers imply. Zero-amount lines (out of span, or a
  // goal-paced line past its deadline) drop out.
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
    // Per-category breakdown — required of every jurisdiction (a zero-tax one
    // returns `{}`), so it is always wired; `runWaterfall` enforces that a tax-charging month
    // reconciles per source.
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
    // Post-tax deposits (surplus sweep, goal funding) add cost basis — they are
    // dollars the household has already paid tax on. Pre-tax deposits
    // (deferrals + employer match into a tax-deferred account) add none: that money
    // is taxed on the way OUT, so its basis stays 0 and the whole draw is taxable.
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

  // Return the resolved contributions so the caller can unwind any unfundable slice once
  // the cascade has decided how much of the month's shortfall genuinely couldn't be met.
  return {
    taxCents: result.taxCents,
    taxByCategoryCents: result.taxByCategoryCents,
    taxBySourceCents: result.taxBySourceCents,
    deferralBySourceCents: result.deferralBySourceCents,
    contributions,
  };
}

/**
 * Undo the phantom part of a COMMITTED contribution. A contribution deposits its
 * FULL amount into the target account and returns the unfunded remainder as a shortfall
 * (see {@link import("./waterfall").runWaterfall}). When even savings and every credit
 * card can't cover that shortfall — the month is insolvent — the uncovered slice was still
 * deposited, which would book an asset the household never actually funded (net worth
 * spiking by a contribution it could not make). Reverse exactly that slice, lowest-priority
 * contribution first, so net worth reflects only what was really moved and the insolvency
 * isn't masked by a phantom balance. `allocateMonth` added the full amount and its cost
 * basis; this removes the unfundable part of both.
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
 * Last month's credited interest as this month's taxable income. The
 * cash was already credited to each buffer's balance by `compoundAssets`, so these carry
 * `waterfallInflowCents` 0 — the ALLOCATION waterfall places nothing (re-injecting it would
 * double-credit the account), and the interest is taxed through the seam via
 * `taxableCents`. But it IS real household cash, so it also reports its interest as
 * {@link IncomeSourceMonth.cashInflowCents}: the cash-flow view then shows $500 of
 * interest and its tax, netting to $400, while the balance still shows the full $500 —
 * the money is counted once as a balance credit and once as a cash flow, never twice as
 * a balance. One source per (owner, tax category): two cash accounts one person holds,
 * each keyed independently in the accrual map, combine into a single booking of their
 * shared category so the seam sees the owner's whole interest at once. Empty in month 1
 * (nothing has compounded yet) and whenever every buffer's return was zero. Interest is
 * ordinary income, so it lands in the provisional-income formula and can pull a
 * government benefit into taxability.
 */
export function buildInterestAccrualSources(state: SimState): IncomeSourceMonth[] {
  const accountsById = new Map(state.accounts.map((a) => [a.id, a]));
  const byOwnerCategory = new Map<
    string,
    { ownerId: string; category: TaxCategory; cents: Cents }
  >();
  for (const [accountId, accrued] of state.accruedReturnByAccount) {
    if (accrued.cents <= 0) continue;
    const acc = accountsById.get(accountId);
    if (acc === undefined) continue;
    const category = accrued.category;
    const key = `${acc.ownerId} ${category}`;
    const entry = byOwnerCategory.get(key);
    if (entry === undefined) {
      byOwnerCategory.set(key, { ownerId: acc.ownerId, category, cents: accrued.cents });
    } else {
      entry.cents += accrued.cents;
    }
  }
  const sources: IncomeSourceMonth[] = [];
  for (const { ownerId, category, cents } of byOwnerCategory.values()) {
    // Zero allocation-gross (the cash is already in the balance, so the waterfall places
    // nothing) but a real cash inflow for the flow view: the interest is genuine household
    // cash, reported under a stable id so the cash-flow chart bands it and deducts its tax.
    // `reportCategory: "savingsInterest"` marks it as savings-account interest explicitly, so
    // the UI groups it without parsing the id — while `taxCategory` keeps it taxed (and
    // rolled up) as the ordinary income it is. Other interest kinds (brokerage/bond) will
    // later carry their own provenance rather than folding in here.
    sources.push({
      ownerId,
      waterfallInflowCents: 0,
      cashInflowCents: cents,
      taxCategory: category,
      taxableCents: cents,
      reportCategory: "savingsInterest",
      sourceId: `interest:${ownerId}:${category}`,
      label: "Savings interest",
    });
  }
  return sources;
}
