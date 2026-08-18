import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { TaxCategory } from "../money/cashFlowSeries";
import { orderBudgetLines, resolveBudgetLineMonthlyCents } from "../budget/budgetLine";
import { runWaterfall, type IncomeSourceMonth, type WaterfallInput } from "./waterfall";
import { addCategory, type TaxableByCategory } from "./taxAttribution";
import { assertTaxAttributionReconciles } from "./waterfallInvariants";
import {
  addFederalTaxPayment,
  NO_FEDERAL_TAX_PAID,
  type FederalTaxPayment,
} from "./federalIncomeTax";
import type { SimState } from "./runState";
import type { SimOwnedSeries } from "./simulate.types";
import type { FinancialObligation } from "./financialObligation";

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
      // One source per income series, so two jobs read apart rather than collapsing into
      // one `wages` band. Fall back to the owner when a series carries no id.
      sourceId: s.sourceId ?? `income:${s.ownerId}`,
      label: s.label ?? "Income",
    });
  }
  return sources;
}

/**
 * A person's remaining pre-tax deferral room for `ctx.year` — the jurisdiction's (possibly
 * age-banded) limit less what they have already deferred. `Infinity` when the jurisdiction caps
 * nothing. Shared with the tax-year projection, which has to take the same deferrals out of
 * scheduled wages to estimate the year's taxable income.
 */
export function remainingDeferralRoomCents(
  state: SimState,
  jurisdiction: Jurisdiction,
  ctx: JurisdictionContext,
  personId: string,
): number {
  const limit = jurisdiction.retirementDeferralLimitCents;
  if (limit === undefined) return Infinity;
  const birthYear = state.personsById.get(personId)?.birthYear;
  const capCents = limit({
    year: ctx.year,
    age: birthYear === undefined ? undefined : ctx.year - birthYear,
  });
  return Math.max(0, capCents - (state.deferredByPersonYear.get(`${personId}|${ctx.year}`) ?? 0));
}

/**
 * The PRIOR tax year's balance, per person, in the April it settles — signed, positive due.
 * Charged as cash alongside this month's instalment (so it is docked from take-home and, if
 * income cannot cover it, funded by the same decumulation any other need is), but deliberately
 * kept OUT of `federalTaxPaidByPersonYear`: that accumulator records what has been paid toward
 * the CURRENT year, and crediting a prior year's balance to it would make this December
 * undercharge by exactly this amount. Empty in every month but April.
 */
type PriorYearSettlements = ReadonlyMap<string, FederalTaxPayment>;

/** A standing contribution line's monthly deposit, resolved for this month. */
interface MonthContribution {
  readonly accountId: string;
  readonly monthlyCents: Cents;
}

/**
 * The month's automatic obligations, split into the shared pool and each person's own —
 * {@link FinancialObligation.ownerId} is the single source of truth for which is which, so the
 * two totals can never drift apart from a parallel scalar. An obligation with no owner (every
 * expense series today, plus a liability owned by nobody on the roster) is shared; only a
 * liability whose owner IS a household member is personal.
 */
function splitAutomaticObligations(
  obligations: readonly FinancialObligation[],
  personIds: readonly string[],
): { sharedObligationCents: Cents; personalCentsByPerson: Map<string, Cents> } {
  const personIdSet = new Set(personIds);
  const personalCentsByPerson = new Map<string, Cents>();
  let sharedObligationCents: Cents = 0;
  for (const o of obligations) {
    if (o.funding.kind !== "automatic") continue;
    if (o.ownerId !== undefined && personIdSet.has(o.ownerId)) {
      personalCentsByPerson.set(o.ownerId, (personalCentsByPerson.get(o.ownerId) ?? 0) + o.amountCents);
    } else {
      sharedObligationCents += o.amountCents;
    }
  }
  return { sharedObligationCents, personalCentsByPerson };
}

/**
 * Everything the month's waterfall runs on, assembled from `state` but writing NOTHING to it —
 * every closure here reads. Split out from {@link allocateMonth} so the month's cash shortfall can
 * be MEASURED before decumulation ({@link projectObligationShortfallCents}) with the identical
 * arithmetic that will later charge it, rather than estimated a second way beside it. A second
 * estimate is exactly what let payroll tax fall out of the funding gap: the waterfall docked it
 * from take-home, decumulation's own take-home model did not, and the difference reached the
 * borrowing cascade with investments still on the balance sheet.
 */
function planMonthAllocation(
  state: SimState,
  incomeSources: readonly IncomeSourceMonth[],
  ctx: JurisdictionContext,
  jurisdiction: Jurisdiction,
  obligations: readonly FinancialObligation[],
  month: number,
  estimatedTaxPayments: ReadonlyMap<string, FederalTaxPayment>,
  priorYearSettlements: PriorYearSettlements,
): { input: WaterfallInput; contributions: readonly MonthContribution[] } {
  const { sharedObligationCents, personalCentsByPerson } = splitAutomaticObligations(
    obligations,
    state.personIds,
  );
  // Per plan, but banded on the individual's age — the jurisdiction may raise the limit with
  // it. No birth year → the un-banded limit.
  const combinedLimit = jurisdiction.combinedPlanDepositLimitCents;
  /** Age in `ctx.year`; `undefined` when the person has no birth year to band on. */
  const ageOf = (pid: string): number | undefined => {
    const birthYear = state.personsById.get(pid)?.birthYear;
    return birthYear === undefined ? undefined : ctx.year - birthYear;
  };
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

  const input: WaterfallInput = {
    personIds: state.personIds,
    incomeSources,
    sharedObligationCents,
    personalObligationCentsByPerson: (pid) => personalCentsByPerson.get(pid) ?? 0,
    sharedScheme: state.sharedScheme,
    surplusDestination: state.surplusDestination,
    goals: state.goals,
    contributions,
    nowMonth: month,
    goalFundMonthlyRate: (id) => accountsById.get(id)?.getMonthlyRateAt(month) ?? 0,
    accountBalanceCents: (id) => state.assetBalances.get(id) ?? 0,
    liquidAccountId: state.liquidAccount?.id ?? null,
    // Every account this person owns, summed — the fallback split weight when nobody has
    // positive take-home. Same pool `orderedAccountsForPerson` (withdrawal.ts) later draws
    // from, so the split and the draw agree on what "this person's assets" means.
    eligibleAssetsCentsByPerson: (pid) =>
      state.accounts.reduce(
        (sum, acc) => (acc.ownerId === pid ? sum + Math.max(0, state.assetBalances.get(acc.id) ?? 0) : sum),
        0,
      ),
    // The month's federal income-tax CASH: an even twelfth of this year's estimated liability,
    // plus (in April only) the balance left over from the year just closed. Fixed for the month:
    // the waterfall must never re-derive income tax from the income in front of it. Signed, so an
    // April refund raises take-home rather than lowering it.
    estimatedIncomeTaxCents: (pid) =>
      (estimatedTaxPayments.get(pid)?.totalCents ?? 0) +
      (priorYearSettlements.get(pid)?.totalCents ?? 0),
    // Absent seam → no payroll tax; the waterfall then leaves take-home untouched.
    computePayrollTaxCents: jurisdiction.computePayrollTaxCents
      ? (earnedByCategory) => jurisdiction.computePayrollTaxCents!(earnedByCategory, ctx)
      : undefined,
    // Required companion whenever the scalar seam is present (runtime-enforced in the
    // waterfall), so a job's FICA line can be attributed back to it.
    computePayrollTaxByCategoryCents: jurisdiction.computePayrollTaxByCategoryCents
      ? (earnedByCategory) => jurisdiction.computePayrollTaxByCategoryCents!(earnedByCategory, ctx)
      : undefined,
    // Year-to-date earned gross BEFORE this month, so the seam's cumulative figure — and its
    // wage-base cap — build on the running total, not a single month.
    priorEarnedByPersonCents: (pid) => state.earnedByPersonYear.get(`${pid}|${ctx.year}`) ?? {},
    remainingDeferralRoomCents: (pid) => remainingDeferralRoomCents(state, jurisdiction, ctx, pid),
    // Age comes from the person; the accumulator is keyed by the plan.
    remainingCombinedDepositRoomCents: (pid, planKey) => {
      if (combinedLimit === undefined) return Infinity;
      const limit = combinedLimit({ year: ctx.year, age: ageOf(pid) });
      const used = state.combinedDepositsByPlanYear.get(`${planKey}|${ctx.year}`) ?? 0;
      return Math.max(0, limit - used);
    },
  };
  return { input, contributions };
}

/**
 * What this month is SHORT on its automatic obligations, before decumulation sells anything — the
 * figure {@link import("./withdrawal").buildWithdrawalSources} liquidates against.
 *
 * The same waterfall the month is really allocated by ({@link runWaterfall}), run on the same
 * inputs, over the income the household has WITHOUT decumulation. So the gap it reports is net of
 * every deduction that will actually be taken — pre-tax deferrals, payroll tax, this year's
 * income-tax instalment and April's settled balance alike — because it is the same subtraction,
 * not a second model of it. Anything the waterfall later learns to dock is netted here the day it
 * is added, with nothing to keep in step.
 *
 * PURE: `runWaterfall` computes deposits and returns them, and this discards them without applying
 * any. Only {@link allocateMonth} writes, and it runs the waterfall again over the income
 * decumulation has by then added — so no deposit, deferral or accumulator is touched twice.
 *
 * The OBLIGATION shortfall alone, excluding the contribution slice: an unaffordable standing
 * contribution is deliberately not asset-funded (see `contributionsNotAssetFunded` in
 * {@link import("./assumptions")}), so counting it here would start selling investments to keep
 * saving into other investments.
 */
export function projectObligationShortfallCents(
  state: SimState,
  incomeSources: readonly IncomeSourceMonth[],
  ctx: JurisdictionContext,
  jurisdiction: Jurisdiction,
  obligations: readonly FinancialObligation[],
  month: number,
  estimatedTaxPayments: ReadonlyMap<string, FederalTaxPayment>,
  priorYearSettlements: PriorYearSettlements,
): {
  totalCents: Cents;
  /** See {@link import("./waterfall").WaterfallResult.obligationShortfallByPersonCents}. */
  byPersonCents: ReadonlyMap<string, Cents>;
} {
  const { input } = planMonthAllocation(
    state,
    incomeSources,
    ctx,
    jurisdiction,
    obligations,
    month,
    estimatedTaxPayments,
    priorYearSettlements,
  );
  const result = runWaterfall(input);
  return {
    totalCents: result.obligationShortfallCents,
    byPersonCents: result.obligationShortfallByPersonCents,
  };
}

/**
 * Step 3/6: route this month's income through the allocation waterfall, apply the
 * per-account deposits, then charge any uncovered obligation as a deficit on the first
 * liquid account so the cascade (next) drains liquid assets before reaching for credit.
 * Updates the per-person annual deferral accumulator so caps hold across the year.
 *
 * The waterfall's pre-cascade shortfall is not surfaced: it is a cash-flow gap posted
 * against the liquid account, not a funding failure. Only the shortfall surviving
 * {@link applyShortfallCascade} means anything to a caller.
 *
 * This is the month's ONLY economic write. The identical waterfall has already run once, over the
 * pre-decumulation income, purely to size the gap ({@link projectObligationShortfallCents}); by
 * here the sources it was short against are in `incomeSources` and the run is authoritative.
 */
export function allocateMonth(
  state: SimState,
  incomeSources: readonly IncomeSourceMonth[],
  ctx: JurisdictionContext,
  jurisdiction: Jurisdiction,
  obligations: readonly FinancialObligation[],
  month: number,
  estimatedTaxPayments: ReadonlyMap<string, FederalTaxPayment>,
  priorYearSettlements: PriorYearSettlements,
): {
  taxCents: Cents;
  payrollTaxCents: Cents;
  payrollTaxBySourceCents: Readonly<Record<string, Cents>>;
  taxByCategoryCents: Partial<Record<TaxCategory, Cents>> | undefined;
  /**
   * The month's income-tax CASH apportioned back to the sources whose income it was sized from —
   * a genuine same-month haircut, since every cent of it really was deducted from this month's
   * take-home. In April that includes the prior year's settled balance, apportioned across the
   * sources of the year it taxes.
   */
  taxBySourceCents: Readonly<Record<string, Cents>>;
  deferralBySourceCents: Readonly<Record<string, Cents>>;
  contributions: readonly MonthContribution[];
  /** The pre-cascade shortfall this month posted to the liquid account (obligations + contributions). */
  shortfallCents: Cents;
  /** The obligation-only slice of `shortfallCents` — see {@link WaterfallResult.obligationShortfallCents}. */
  obligationShortfallCents: Cents;
} {
  const { input, contributions } = planMonthAllocation(
    state,
    incomeSources,
    ctx,
    jurisdiction,
    obligations,
    month,
    estimatedTaxPayments,
    priorYearSettlements,
  );
  const accountsById = new Map(state.accounts.map((a) => [a.id, a]));
  const result = runWaterfall(input);

  for (const [id, amount] of result.accountDepositsCents) {
    state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) + amount);
    // Post-tax deposits add cost basis; pre-tax deposits (deferrals, employer match) add
    // none — taxed on the way out, so the whole later draw is taxable.
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

  // Fold this month's earned gross into the year-to-date accumulator so next month's payroll
  // base — and the OASDI cap it settles against — is current.
  for (const [pid, earned] of result.earnedThisMonthByPersonCents) {
    const key = `${pid}|${ctx.year}`;
    const running = state.earnedByPersonYear.get(key);
    if (running === undefined) {
      state.earnedByPersonYear.set(key, { ...earned });
    } else {
      for (const [category, cents] of Object.entries(earned)) {
        if (cents) running[category as TaxCategory] = (running[category as TaxCategory] ?? 0) + cents;
      }
    }
  }

  for (const [planKey, amount] of result.combinedDepositsByPlanCents) {
    const key = `${planKey}|${ctx.year}`;
    state.combinedDepositsByPlanYear.set(
      key,
      (state.combinedDepositsByPlanYear.get(key) ?? 0) + amount,
    );
  }

  // Fold this month's taxable income into the year-to-date accumulator. What the month CHARGED
  // is an installment on the year's estimate, unrelated to this figure; December reads the
  // complete total once, so the month a dollar landed in never changes the annual liability.
  for (const [pid, taxable] of result.taxableByPersonCents) {
    const key = `${pid}|${ctx.year}`;
    let running = state.taxableIncomeByPersonYear.get(key);
    if (running === undefined) {
      running = {};
      state.taxableIncomeByPersonYear.set(key, running);
    }
    for (const [category, cents] of Object.entries(taxable)) {
      if (cents) addCategory(running, category as TaxCategory, cents);
    }
  }

  // The per-SOURCE mirror of the fold above — same running total, kept by source instead of
  // category, so December can apportion its per-category bill back to the sources that
  // actually produced it.
  for (const [pid, sources] of result.taxableBySourcePersonCents) {
    const key = `${pid}|${ctx.year}`;
    let running = state.taxableBySourceByPersonYear.get(key);
    if (running === undefined) {
      running = new Map();
      state.taxableBySourceByPersonYear.set(key, running);
    }
    for (const s of sources) {
      const existing = running.get(s.key);
      if (existing === undefined) running.set(s.key, { ...s });
      else running.set(s.key, { ...existing, taxableCents: existing.taxableCents + s.taxableCents });
    }
  }

  // Record what was paid TOWARD THIS YEAR, so the year's close reconciles against the real
  // running total rather than re-deriving "twelve installments" and missing a year that started
  // mid-estimate. Only the instalment counts: a prior year's balance settled this month pays a
  // liability this year's close knows nothing about.
  const taxByCategoryCents: TaxableByCategory = {};
  const taxBySourceCents: Record<string, Cents> = {};
  for (const [pid, payment] of estimatedTaxPayments) {
    if (payment.totalCents === 0) continue;
    const key = `${pid}|${ctx.year}`;
    state.federalTaxPaidByPersonYear.set(
      key,
      addFederalTaxPayment(state.federalTaxPaidByPersonYear.get(key) ?? NO_FEDERAL_TAX_PAID, payment),
    );
  }
  // The breakdowns, in contrast, describe the CASH this month charged — instalment and prior-year
  // balance alike — because that is what `taxCents` is and what the per-source haircut has to
  // reconcile against. A settled balance bands under the sources that produced the income it
  // taxes, which are last year's; a source no longer paying this month is stranded and spread
  // across the month's real ones downstream ({@link import("./reportFlows").buildFlows}).
  for (const payments of [estimatedTaxPayments, priorYearSettlements]) {
    for (const [, payment] of payments) {
      if (payment.totalCents === 0) continue;
      for (const [category, cents] of Object.entries(payment.byCategoryCents)) {
        if (cents) addCategory(taxByCategoryCents, category as TaxCategory, cents);
      }
      for (const [source, cents] of Object.entries(payment.bySourceCents)) {
        if (cents) taxBySourceCents[source] = (taxBySourceCents[source] ?? 0) + cents;
      }
    }
  }
  assertTaxAttributionReconciles(result.taxCents, taxBySourceCents);

  // Contributions go back so the caller can unwind any unfundable slice after the cascade.
  return {
    taxCents: result.taxCents,
    payrollTaxCents: result.payrollTaxCents,
    payrollTaxBySourceCents: result.payrollTaxBySourceCents,
    taxByCategoryCents,
    taxBySourceCents,
    deferralBySourceCents: result.deferralBySourceCents,
    contributions,
    shortfallCents: result.shortfallCents,
    obligationShortfallCents: result.obligationShortfallCents,
  };
}

/**
 * Undo the phantom part of a committed contribution. A contribution deposits its full amount
 * and returns the unfunded remainder as a shortfall (see
 * {@link import("./waterfall").runWaterfall}); if neither savings nor credit covers that
 * shortfall, the uncovered slice was still deposited, booking an asset the household never
 * funded. Reverse exactly that slice, lowest-priority contribution first, removing both the
 * amount and the cost basis `allocateMonth` added.
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
 * re-injecting would double-credit — and are taxed via `taxableCents`. It is real household
 * cash, so it also reports {@link IncomeSourceMonth.cashInflowCents}. Empty in month 1 and
 * whenever every buffer's return was zero. Interest is ordinary income, so it enters the
 * provisional-income formula and can pull a benefit into taxability.
 */
export function buildInterestAccrualSources(state: SimState): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  // One source per account, in the plan's account order (stable, so the cash-flow chart
  // keeps each band's identity across months). One merged "Savings interest" line made a
  // drained account look like it was still earning. The app's Simple view re-collapses
  // `savingsInterest` bands (keyed on reportCategory).
  for (const acc of state.accounts) {
    const accrued = state.accruedReturnByAccount.get(acc.id);
    if (accrued === undefined || accrued.cents <= 0) continue;
    // `reportCategory` lets the UI group these without parsing the id; `taxCategory` keeps
    // them taxed as ordinary income.
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
