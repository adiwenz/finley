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
  PAY_PERIODS_PER_YEAR,
  type FederalTaxPayment,
} from "./federalIncomeTax";
import type { SimState } from "./runState";
import { isPersonActiveAt, type SimOwnedSeries } from "./simulate.types";
import type { FinancialObligation } from "./financialObligation";

export function buildIncomeSources(
  incomeSeries: readonly SimOwnedSeries[],
  month: number,
): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  for (const s of incomeSeries) {
    const waterfallInflowCents = s.series.getMonthlyCents(month);
    if (waterfallInflowCents === 0 && s.planDescriptor === undefined) continue;
    const supplementalCents = s.supplementalByMonth?.get(month) ?? 0;
    sources.push({
      ownerId: s.ownerId,
      waterfallInflowCents,
      ...(supplementalCents > 0 ? { supplementalCents } : {}),
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
 * nothing.
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
 * Charged as cash alongside this month's withholding (so it is docked from take-home and, if
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
/**
 * The account a person's own surplus lands in: theirs, of the same KIND as the household's
 * chosen destination.
 *
 * Kind is matched on the destination account's own shape — whether it takes the waterfall's
 * deposits (`liquid`) and how a withdrawal from it is taxed — rather than on an id convention,
 * so it keeps working for accounts this module never names. The household's choice is a kind
 * ("savings" or "brokerage"), resolved to the primary's concrete id at the plan boundary; this
 * resolves the same kind for everyone else.
 *
 * Null when the person holds no account of that kind, which the waterfall reads as "leave this
 * share to the household destination" rather than as an error.
 */
function surplusAccountIdFor(state: SimState, personId: string): string | null {
  const destId =
    state.surplusDestination.kind === "swept"
      ? state.surplusDestination.accountId
      : (state.liquidAccount?.id ?? null);
  if (destId === null) return null;
  const dest = state.accounts.find((a) => a.id === destId);
  if (dest === undefined) return null;
  if (dest.ownerId === personId) return destId;
  const own = state.accounts.find(
    (a) =>
      a.ownerId === personId &&
      a.liquid === dest.liquid &&
      a.taxProfile.withdrawalCategory === dest.taxProfile.withdrawalCategory &&
      a.taxProfile.forcedDistributionEligible === dest.taxProfile.forcedDistributionEligible,
  );
  return own?.id ?? null;
}

/**
 * The month's authored shared-expense percentages, over the members `householdMemberIds` names.
 *
 * The split rides on the RELATIONSHIP, so it is stored on the partner and the primary takes what
 * is left: while a partnership is running the partner has their authored percent and the primary
 * the remainder, and the moment nobody is partnered the primary has all of it. Sequential
 * partners are therefore independent by construction — Casey's percent is Casey's own, and
 * Blake's leaving takes Blake's with it.
 *
 * Nothing here reads a balance, a paycheck, or an age. That is the whole point.
 */
function sharedSharePercentOf(
  state: SimState,
  memberIds: readonly string[],
): (personId: string) => number {
  let partnerTotal = 0;
  for (const pid of memberIds) {
    const percent = state.personsById.get(pid)?.sharedExpensePercent;
    if (percent !== undefined) partnerTotal += Math.max(0, Math.min(100, percent));
  }
  const primaryShare = Math.max(0, 100 - partnerTotal);
  return (pid) => {
    const percent = state.personsById.get(pid)?.sharedExpensePercent;
    return percent === undefined ? primaryShare : Math.max(0, Math.min(100, percent));
  };
}

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

  const memberIds = state.personIds.filter((pid) => {
    const person = state.personsById.get(pid);
    return person === undefined || isPersonActiveAt(person, month);
  });
  const input: WaterfallInput = {
    personIds: state.personIds,
    // The shared budget is split across the household as it stands this month, not across every
    // person the run has ever known — see {@link WaterfallInput.householdMemberIds}. Someone with
    // income but no roster entry counts: they are being paid into this household.
    householdMemberIds: memberIds,
    incomeSources,
    sharedObligationCents,
    personalObligationCentsByPerson: (pid) => personalCentsByPerson.get(pid) ?? 0,
    sharedSharePercentOf: sharedSharePercentOf(state, memberIds),
    surplusDestination: state.surplusDestination,
    goals: state.goals,
    contributions,
    nowMonth: month,
    goalFundMonthlyRate: (id) => accountsById.get(id)?.getMonthlyRateAt(month) ?? 0,
    accountBalanceCents: (id) => state.assetBalances.get(id) ?? 0,
    liquidAccountId: state.liquidAccount?.id ?? null,
    surplusAccountIdForPerson: (pid) => surplusAccountIdFor(state, pid),
    // Income-tax withholding, computed by the waterfall per WAGE SOURCE from that source's own
    // pay. The waterfall never prices a year; this seam prices one paycheck.
    computeWageWithholdingCents: jurisdiction.computeWageWithholdingCents
      ? (request) => jurisdiction.computeWageWithholdingCents!(request, ctx)
      : undefined,
    payPeriodsPerYear: PAY_PERIODS_PER_YEAR,
    // Periods left in the CALENDAR year, this one included — the horizon a mid-year correction
    // has to spread itself over. Absolute month modulo the year is the month-of-year, because a
    // projection always opens in January.
    periodsRemainingInTaxYear: PAY_PERIODS_PER_YEAR - (month % PAY_PERIODS_PER_YEAR),
    // The prior year's settled balance, in the filing month only — signed, so a refund raises
    // take-home rather than lowering it. Kept apart from this month's withholding because it pays
    // a DIFFERENT year and must never be credited against this one.
    settlementCashCents: (pid) => priorYearSettlements.get(pid)?.totalCents ?? 0,
    // Absent seam → no payroll tax; the waterfall then leaves take-home untouched.
    computePayrollWithholdingCents: jurisdiction.computePayrollWithholdingCents
      ? (earnedByCategory) => jurisdiction.computePayrollWithholdingCents!(earnedByCategory, ctx)
      : undefined,
    // Required companion whenever the scalar seam is present (runtime-enforced in the
    // waterfall), so a job's FICA line can be attributed back to it.
    computePayrollWithholdingByCategoryCents: jurisdiction.computePayrollWithholdingByCategoryCents
      ? (earnedByCategory) =>
          jurisdiction.computePayrollWithholdingByCategoryCents!(earnedByCategory, ctx)
      : undefined,
    // One wage source's year-to-date facts BEFORE this month, held per source because that is
    // where every cap and band a real employer applies actually binds.
    priorSourceYearToDate: (pid, sourceKey) =>
      state.sourceYearToDate.get(`${pid}|${ctx.year}`)?.get(sourceKey) ?? {
        earnedByCategory: {},
        supplementalWagesCents: 0,
        wageWithholdingCents: 0,
        regularWagesCents: 0,
        regularWithholdingCents: 0,
      },
    // The same facts rolled up across the person's sources in one category — what the EMPLOYEE
    // knows and no employer does. Every source the year has seen counts, including one that has
    // already stopped paying, so a correction made in July still accounts for a job that ran to
    // June. Which categories are wages stays the jurisdiction's call: the roll-up just matches on
    // the category the caller asked about. REGULAR pay only, on both sides: a bonus is withheld
    // by its own method when it is paid, and letting it into this basis would have the months
    // after it withhold as though the person had been given a raise.
    priorPersonWageYearToDate: (pid, taxCategory) => {
      let wagesCents = 0;
      let withholdingCents = 0;
      for (const ytd of state.sourceYearToDate.get(`${pid}|${ctx.year}`)?.values() ?? []) {
        if (ytd.taxCategory !== taxCategory) continue;
        wagesCents += ytd.regularWagesCents;
        withholdingCents += ytd.regularWithholdingCents;
      }
      return { wagesCents, withholdingCents };
    },
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
 * every deduction that will actually be taken — pre-tax deferrals, payroll tax, this month's
 * income-tax withholding and April's settled balance alike — because it is the same subtraction,
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
  priorYearSettlements: PriorYearSettlements,
  /**
   * {@link import("./withdrawal").WithdrawalPlan.liquidDrawdownByAccountCents} — the OWNER-AWARE
   * prediction of which liquid accounts absorb this month's residual, in what proportion.
   * `result.shortfallCents` below is charged across exactly these accounts in that same
   * proportion (cumulative-rounded to land on the real total to the cent), rather than dumped
   * onto one arbitrarily-first liquid account regardless of whose it is. Absent, or every
   * predicted share 0 (no liquid account exists, or decumulation was never run — e.g. the
   * pre-decumulation sizing pass, which never charges anything), falls back to {@link
   * SimState.liquidAccount} — the household's single designated buffer, if it has one at all.
   */
  liquidDrawdownByAccountCents?: ReadonlyMap<string, Cents>,
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
  /**
   * The slice of `taxCents` (and of `taxBySourceCents`) that is the PRIOR year's settled balance
   * rather than this month's withholding — SIGNED, so a refund is negative. 0 outside April and
   * whenever nothing was left to settle. Reporting only: it is already inside `taxCents`, stated
   * separately so a consumer can tell the money a paycheck withheld from the money a filing
   * settled without re-deriving either.
   */
  taxSettlementCents: Cents;
  /** Per-source attribution of {@link taxSettlementCents}, signed and summing to it. `{}` when 0. */
  taxSettlementBySourceCents: Readonly<Record<string, Cents>>;
  /**
   * The same balance per PERSON, signed and summing to {@link taxSettlementCents} — positive is
   * that person's bill, negative is their refund.
   *
   * Kept per person rather than reported as the household net, because the household files as
   * separate single filers and the net erases both figures it is made of: one partner owing
   * $1,000 while the other is refunded $300 is $1,000 of tax paid and $300 refunded, not $700 of
   * tax. Whose liability it is, whose cash moves, and whose accounts end up funding a shortfall
   * are three separate questions, and netting answers none of them.
   */
  taxSettlementByPersonCents: Readonly<Record<string, Cents>>;
  deferralBySourceCents: Readonly<Record<string, Cents>>;
  contributions: readonly MonthContribution[];
  /** The pre-cascade shortfall this month posted to the liquid account (obligations + contributions). */
  shortfallCents: Cents;
  /** The obligation-only slice of `shortfallCents` — see {@link WaterfallResult.obligationShortfallCents}. */
  obligationShortfallCents: Cents;
  /** See {@link WaterfallResult.leftoverByPersonCents}. */
  leftoverByPersonCents: Readonly<Record<string, Cents>>;
  /** Each person's pre-tax deferral — what {@link leftoverByPersonCents} has already put away. */
  deferredByPersonCents: Readonly<Record<string, Cents>>;
  /** See {@link WaterfallResult.netCashFlowByPersonCents}. */
  netCashFlowByPersonCents: Readonly<Record<string, Cents>>;
  /** See {@link WaterfallResult.obligationChargedByPersonCents}. */
  obligationChargedByPersonCents: Readonly<Record<string, Cents>>;
  /** See {@link WaterfallResult.obligationFundedByPersonCents}. */
  obligationFundedByPersonCents: Readonly<Record<string, Cents>>;
} {
  const { input, contributions } = planMonthAllocation(
    state,
    incomeSources,
    ctx,
    jurisdiction,
    obligations,
    month,
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

  if (result.shortfallCents > 0) {
    const predicted = [...(liquidDrawdownByAccountCents ?? [])].filter(([, cents]) => cents > 0);
    const totalPredicted = predicted.reduce((sum, [, cents]) => sum + cents, 0);
    if (totalPredicted > 0) {
      // Cumulative-rounded to the real total, same technique as `proportionalSplit` (waterfall.ts):
      // every account's share is a whole-cent slice of `result.shortfallCents`, and the shares
      // sum to it exactly regardless of any rounding-sized gap between the prediction and the
      // real waterfall's own figure.
      let prevCum = 0;
      let acc = 0;
      for (const [id, cents] of predicted) {
        acc += cents;
        const cum = Math.round((result.shortfallCents * acc) / totalPredicted);
        const share = cum - prevCum;
        prevCum = cum;
        if (share === 0) continue;
        state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) - share);
      }
    } else if (state.liquidAccount !== null) {
      const id = state.liquidAccount.id;
      state.assetBalances.set(id, (state.assetBalances.get(id) ?? 0) - result.shortfallCents);
    }
  }

  for (const [pid, amount] of result.deferredByPersonCents) {
    const key = `${pid}|${ctx.year}`;
    state.deferredByPersonYear.set(key, (state.deferredByPersonYear.get(key) ?? 0) + amount);
  }

  // Fold this month's per-source payroll facts into the year-to-date accumulator, so next month's
  // wage base, surtax threshold and supplemental band all bind on the running total of the source
  // that paid them.
  for (const [pid, deltasBySource] of result.sourceYearToDateDeltas) {
    const key = `${pid}|${ctx.year}`;
    let running = state.sourceYearToDate.get(key);
    if (running === undefined) {
      running = new Map();
      state.sourceYearToDate.set(key, running);
    }
    for (const [sourceKey, delta] of deltasBySource) {
      const prior = running.get(sourceKey);
      if (prior === undefined) {
        running.set(sourceKey, { ...delta, earnedByCategory: { ...delta.earnedByCategory } });
        continue;
      }
      const earnedByCategory = { ...prior.earnedByCategory };
      for (const [category, cents] of Object.entries(delta.earnedByCategory)) {
        if (cents) addCategory(earnedByCategory, category as TaxCategory, cents);
      }
      running.set(sourceKey, {
        earnedByCategory,
        supplementalWagesCents: prior.supplementalWagesCents + delta.supplementalWagesCents,
        wageWithholdingCents: prior.wageWithholdingCents + delta.wageWithholdingCents,
        regularWagesCents: prior.regularWagesCents + delta.regularWagesCents,
        regularWithholdingCents: prior.regularWithholdingCents + delta.regularWithholdingCents,
        taxCategory: delta.taxCategory ?? prior.taxCategory,
      });
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
  // is what payroll withheld, unrelated to this figure; December reads the
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

  // Credit what was WITHHELD TOWARD THIS YEAR, so the year's close reconciles the liability
  // against a real running total. Only the withholding counts: a prior year's balance settled this
  // month pays a liability this year's close knows nothing about, and crediting it here would make
  // this December undercharge by exactly that amount.
  const taxByCategoryCents: TaxableByCategory = {};
  const taxBySourceCents: Record<string, Cents> = {};
  for (const [pid, withheld] of result.wageWithholdingByPerson) {
    if (withheld.totalCents === 0) continue;
    const key = `${pid}|${ctx.year}`;
    state.federalTaxPaidByPersonYear.set(
      key,
      addFederalTaxPayment(state.federalTaxPaidByPersonYear.get(key) ?? NO_FEDERAL_TAX_PAID, {
        totalCents: withheld.totalCents,
        byCategoryCents: withheld.byCategoryCents,
        bySourceCents: { ...withheld.bySourceCents },
      }),
    );
  }
  // The breakdowns, in contrast, describe the CASH this month charged — withholding and prior-year
  // balance alike — because that is what `taxCents` is and what the per-source haircut has to
  // reconcile against. A settled balance bands under the sources that produced the income it
  // taxes, which are last year's; a source no longer paying this month is stranded and spread
  // across the month's real ones downstream ({@link import("./reportFlows").buildFlows}).
  for (const withheld of result.wageWithholdingByPerson.values()) {
    for (const [category, cents] of Object.entries(withheld.byCategoryCents)) {
      if (cents) addCategory(taxByCategoryCents, category as TaxCategory, cents);
    }
    for (const [source, cents] of Object.entries(withheld.bySourceCents)) {
      if (cents) taxBySourceCents[source] = (taxBySourceCents[source] ?? 0) + cents;
    }
  }
  // The settled slice, kept as its own reporting figure on the way past. Signed throughout: a
  // refund is a negative charge here exactly as it is in `taxCents`, and clamping it anywhere in
  // the engine would lose the only record that the filing produced money back.
  let taxSettlementCents: Cents = 0;
  const taxSettlementBySourceCents: Record<string, Cents> = {};
  const taxSettlementByPersonCents: Record<string, Cents> = {};
  for (const [personId, payment] of priorYearSettlements) {
    if (payment.totalCents === 0) continue;
    taxSettlementByPersonCents[personId] =
      (taxSettlementByPersonCents[personId] ?? 0) + payment.totalCents;
    taxSettlementCents += payment.totalCents;
    for (const [category, cents] of Object.entries(payment.byCategoryCents)) {
      if (cents) addCategory(taxByCategoryCents, category as TaxCategory, cents);
    }
    for (const [source, cents] of Object.entries(payment.bySourceCents)) {
      if (cents) taxBySourceCents[source] = (taxBySourceCents[source] ?? 0) + cents;
      if (cents) {
        taxSettlementBySourceCents[source] = (taxSettlementBySourceCents[source] ?? 0) + cents;
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
    taxSettlementCents,
    taxSettlementBySourceCents,
    taxSettlementByPersonCents,
    deferralBySourceCents: result.deferralBySourceCents,
    contributions,
    shortfallCents: result.shortfallCents,
    obligationShortfallCents: result.obligationShortfallCents,
    leftoverByPersonCents: Object.fromEntries(result.leftoverByPersonCents),
    deferredByPersonCents: Object.fromEntries(result.deferredByPersonCents),
    netCashFlowByPersonCents: Object.fromEntries(result.netCashFlowByPersonCents),
    obligationChargedByPersonCents: Object.fromEntries(result.obligationChargedByPersonCents),
    obligationFundedByPersonCents: Object.fromEntries(result.obligationFundedByPersonCents),
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
