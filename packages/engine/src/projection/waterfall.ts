/**
 * Allocation waterfall — pipeline step 3 in detail.
 *
 * ONE fixed-structure waterfall, never user-rearrangeable. Exactly four levers: each
 * person's pre-tax deferral % (per source `planDescriptor`), the shared-contribution
 * scheme, the goal priority order, and the surplus-cash destination.
 *
 * Per month, in strict order: deferrals → tax → shared obligations → shared goals →
 * personal goals → surplus. Placement reads `planDescriptor`, taxation reads
 * `taxCategory`, never conflated: non-wage income has no descriptor, so it enters
 * POST-deferral yet still feeds the taxable pool.
 *
 * Pure: a month's resolved figures in, per-account deposits plus household shortfall out.
 * The simulator applies the deposits and routes the shortfall through the cascade.
 */

import { splitEven, type Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";
import {
  addCategory,
  attributeTaxToSources,
  type SourceTaxable,
  type TaxableByCategory,
} from "./taxAttribution";
import type { SimGoal } from "../goal";
import { requiredContributionCents } from "../requiredContribution";
import type { WaterfallInput, WaterfallResult } from "./waterfall.types";
import {
  assertPersonTaxBreakdownReconciles,
  assertTaxAttributionReconciles,
  assertPersonPayrollTaxBreakdownReconciles,
  assertPayrollTaxAttributionReconciles,
} from "./waterfallInvariants";

// Re-exported so the engine barrel keeps exposing them.
export {
  assertPersonTaxBreakdownReconciles,
  assertTaxAttributionReconciles,
  assertPersonPayrollTaxBreakdownReconciles,
  assertPayrollTaxAttributionReconciles,
};

// Re-exported so existing importers keep resolving them here.
export type {
  PlanDescriptor,
  IncomeSourceMonth,
  SharedContributionScheme,
  SurplusDestination,
  WaterfallInput,
  WaterfallResult,
} from "./waterfall.types";

function addDeposit(map: Map<string, Cents>, accountId: string, amount: Cents): void {
  if (amount === 0) return;
  map.set(accountId, (map.get(accountId) ?? 0) + amount);
}

/**
 * Step 1 — per-source pre-tax deferrals, capped per person against the annual limit.
 * Overflow past the cap is not deferred: it stays in the gross and re-enters as taxable.
 */
function applyDeferrals(
  input: WaterfallInput,
  deposits: Map<string, Cents>,
): {
  grossByPerson: Map<string, Cents>;
  taxableByPerson: Map<string, TaxableByCategory>;
  earnedGrossByPerson: Map<string, TaxableByCategory>;
  sourceTaxableByPerson: Map<string, SourceTaxable[]>;
  sourceEarnedByPerson: Map<string, SourceTaxable[]>;
  deferralBySource: Map<string, Cents>;
  deferredByPerson: Map<string, Cents>;
} {
  const roomRemaining = new Map<string, number>();
  for (const pid of input.personIds) roomRemaining.set(pid, input.remainingDeferralRoomCents(pid));

  const grossByPerson = new Map<string, Cents>();
  const taxableByPerson = new Map<string, TaxableByCategory>();
  // Pre-deferral gross by category, the payroll-tax base: FICA ignores 401(k) deferrals, so
  // this is accumulated BEFORE the deferral is subtracted (unlike `taxableByPerson`).
  const earnedGrossByPerson = new Map<string, TaxableByCategory>();
  // Keyed by `sourceId` ?? tax category — the key the income side bands on.
  const sourceTaxableByPerson = new Map<string, SourceTaxable[]>();
  // This month's PRE-deferral earned amount per source, mirroring `sourceTaxableByPerson`
  // but unhaircut by any deferral — the weight the payroll-tax breakdown apportions by.
  const sourceEarnedByPerson = new Map<string, SourceTaxable[]>();
  const deferralBySource = new Map<string, Cents>();
  const deferredByPerson = new Map<string, Cents>();
  const taxableFor = (pid: string): TaxableByCategory => {
    let m = taxableByPerson.get(pid);
    if (m === undefined) {
      m = {};
      taxableByPerson.set(pid, m);
    }
    return m;
  };
  const earnedGrossFor = (pid: string): TaxableByCategory => {
    let m = earnedGrossByPerson.get(pid);
    if (m === undefined) {
      m = {};
      earnedGrossByPerson.set(pid, m);
    }
    return m;
  };
  for (const src of input.incomeSources) {
    grossByPerson.set(src.ownerId, (grossByPerson.get(src.ownerId) ?? 0) + src.waterfallInflowCents);
    const sourceKey = src.sourceId ?? src.taxCategory;

    // Pre-deferral taxable base for this source (gain-only for a returned-basis draw,
    // interest for an accrued booking, full gross for wages) — the same figure the taxable
    // pool bands on, but recorded here WITHOUT the deferral haircut, since payroll tax is
    // levied on the whole gross. The seam later filters to earned categories.
    const sourceEarned = src.taxableCents ?? src.waterfallInflowCents;
    addCategory(earnedGrossFor(src.ownerId), src.taxCategory, sourceEarned);
    if (sourceEarned > 0) {
      let earnedList = sourceEarnedByPerson.get(src.ownerId);
      if (earnedList === undefined) {
        earnedList = [];
        sourceEarnedByPerson.set(src.ownerId, earnedList);
      }
      earnedList.push({ key: sourceKey, category: src.taxCategory, taxableCents: sourceEarned });
    }

    let deferred = 0;
    if (src.planDescriptor && src.waterfallInflowCents > 0) {
      const desired = Math.round(src.waterfallInflowCents * src.planDescriptor.deferralFraction);
      const room = roomRemaining.get(src.ownerId) ?? Infinity;
      deferred = Math.max(0, Math.min(desired, room));
      if (deferred > 0) {
        roomRemaining.set(src.ownerId, room - deferred);
        deferredByPerson.set(src.ownerId, (deferredByPerson.get(src.ownerId) ?? 0) + deferred);
        deferralBySource.set(sourceKey, (deferralBySource.get(sourceKey) ?? 0) + deferred);
        const match = Math.round(deferred * (src.planDescriptor.employerMatchFraction ?? 0));
        addDeposit(deposits, src.planDescriptor.fundAccountId, deferred + match);
      }
    }

    // `taxableCents` overrides the gross when taxable differs from cash (returned-basis
    // draw, accrued interest). The whole gross is still paid out as take-home below.
    const sourceTaxable = Math.max(0, (src.taxableCents ?? src.waterfallInflowCents) - deferred);
    addCategory(taxableFor(src.ownerId), src.taxCategory, sourceTaxable);
    // The weight equals what was added to the category total, so the per-source split
    // reconciles to the category tax.
    if (sourceTaxable > 0) {
      let list = sourceTaxableByPerson.get(src.ownerId);
      if (list === undefined) {
        list = [];
        sourceTaxableByPerson.set(src.ownerId, list);
      }
      list.push({ key: sourceKey, category: src.taxCategory, taxableCents: sourceTaxable });
    }
  }
  return {
    grossByPerson,
    taxableByPerson,
    earnedGrossByPerson,
    sourceTaxableByPerson,
    sourceEarnedByPerson,
    deferralBySource,
    deferredByPerson,
  };
}

/**
 * Step 2 — tax each person's taxable-by-category map through the single seam.
 * `computeTaxCents` is called ONCE per person and nowhere else, so no tax logic lives in
 * allocation code. Take-home is charged against the FULL gross, so a partially-taxed
 * benefit still pays its whole check.
 */
function computeTakeHome(
  input: WaterfallInput,
  grossByPerson: Map<string, Cents>,
  taxableByPerson: Map<string, TaxableByCategory>,
  earnedGrossByPerson: Map<string, TaxableByCategory>,
  sourceTaxableByPerson: Map<string, SourceTaxable[]>,
  sourceEarnedByPerson: Map<string, SourceTaxable[]>,
  deferredByPerson: Map<string, Cents>,
): {
  taxCents: Cents;
  payrollTaxCents: Cents;
  payrollTaxBySourceCents: Record<string, Cents>;
  takeHomeByPerson: Map<string, Cents>;
  taxByCategoryCents: TaxableByCategory;
  taxBySourceCents: Record<string, Cents>;
} {
  const breakdownSeam = input.computeTaxByCategoryCents;
  const payrollSeam = input.computePayrollTaxCents;
  const payrollBreakdownSeam = input.computePayrollTaxByCategoryCents;
  let taxCents: Cents = 0;
  let payrollTaxCents: Cents = 0;
  // The breakdown seam is required; a zero-tax jurisdiction returns `{}`.
  const taxByCategoryCents: TaxableByCategory = {};
  const taxBySourceCents: Record<string, Cents> = {};
  const payrollTaxBySourceCents: Record<string, Cents> = {};
  const takeHomeByPerson = new Map<string, Cents>();
  for (const pid of input.personIds) {
    const gross = grossByPerson.get(pid) ?? 0;
    const deferral = deferredByPerson.get(pid) ?? 0;
    const taxable = taxableByPerson.get(pid) ?? {};
    // Charged against the scalar total; the breakdown is a reporting re-description whose
    // Σ equals this same figure.
    const tax = input.computeTaxCents(taxable);
    taxCents += tax;
    const perCategory = breakdownSeam(taxable);
    // Per person BEFORE aggregating, so offsetting errors can't cancel in the household
    // total and slip past the household check.
    assertPersonTaxBreakdownReconciles(pid, tax, perCategory);
    for (const [category, cents] of Object.entries(perCategory)) {
      if (cents) addCategory(taxByCategoryCents, category as TaxCategory, cents);
    }
    attributeTaxToSources(perCategory, sourceTaxableByPerson.get(pid) ?? [], taxBySourceCents);
    // Payroll tax is the cumulative-after minus cumulative-before difference, so a capped
    // component (OASDI's wage base) stops once year-to-date earnings clear the ceiling.
    // Monotone non-decreasing in earnings, so the difference is never a credit.
    const { payrollTax, perCategoryIncrement } = payrollTaxForPerson(
      input,
      payrollSeam,
      payrollBreakdownSeam,
      pid,
      earnedGrossByPerson.get(pid),
    );
    payrollTaxCents += payrollTax;
    if (payrollBreakdownSeam !== undefined) {
      // Per person BEFORE aggregating — same reasoning as the income-tax check above.
      assertPersonPayrollTaxBreakdownReconciles(pid, payrollTax, perCategoryIncrement);
      // Distributes this person's incremental payroll charge back to the sources that
      // generated it, weighted within each EARNED category by earned amount — the cumulative
      // per-person cap already settled by `payrollTaxForPerson` is untouched, only the
      // resulting total is being split up, never recomputed per source.
      attributeTaxToSources(
        perCategoryIncrement,
        sourceEarnedByPerson.get(pid) ?? [],
        payrollTaxBySourceCents,
      );
    }
    takeHomeByPerson.set(pid, gross - deferral - tax - payrollTax);
  }
  return {
    taxCents,
    payrollTaxCents,
    payrollTaxBySourceCents,
    takeHomeByPerson,
    taxByCategoryCents,
    taxBySourceCents,
  };
}

/** Merge two per-category maps into a new one; used to add this month's earnings onto the year-to-date base. */
function mergeCategories(
  a: TaxableByCategory | undefined,
  b: TaxableByCategory | undefined,
): TaxableByCategory {
  const out: TaxableByCategory = { ...(a ?? {}) };
  for (const [category, cents] of Object.entries(b ?? {})) {
    if (cents) addCategory(out, category as TaxCategory, cents);
  }
  return out;
}

/**
 * One person's payroll tax this month: the seam on their year-to-date earnings AFTER this
 * month minus the seam on the year-to-date BEFORE it. 0 when the jurisdiction supplies no
 * payroll seam or the person earned nothing. When a breakdown seam is also supplied, the
 * SAME after-minus-before difference is taken per category, so `perCategoryIncrement`
 * apportions correctly even though a capped component means the increment is not simply
 * this month's earned amount times a flat rate.
 */
function payrollTaxForPerson(
  input: WaterfallInput,
  payrollSeam: WaterfallInput["computePayrollTaxCents"],
  payrollBreakdownSeam: WaterfallInput["computePayrollTaxByCategoryCents"],
  pid: string,
  earnedThisMonth: TaxableByCategory | undefined,
): { payrollTax: Cents; perCategoryIncrement: TaxableByCategory } {
  if (payrollSeam === undefined || earnedThisMonth === undefined) {
    return { payrollTax: 0, perCategoryIncrement: {} };
  }
  const prior = input.priorEarnedByPersonCents?.(pid) ?? {};
  const after = mergeCategories(prior, earnedThisMonth);
  const payrollTax = payrollSeam(after) - payrollSeam(prior);
  if (payrollBreakdownSeam === undefined) return { payrollTax, perCategoryIncrement: {} };
  const breakdownAfter = payrollBreakdownSeam(after);
  const breakdownBefore = payrollBreakdownSeam(prior);
  const perCategoryIncrement: TaxableByCategory = {};
  const categories = new Set([...Object.keys(breakdownAfter), ...Object.keys(breakdownBefore)]);
  for (const category of categories) {
    const increment = (breakdownAfter[category as TaxCategory] ?? 0) - (breakdownBefore[category as TaxCategory] ?? 0);
    if (increment) addCategory(perCategoryIncrement, category as TaxCategory, increment);
  }
  return { payrollTax, perCategoryIncrement };
}

/**
 * Step 3 — split shared obligations by the scheme, then take each person's share out of
 * their take-home. Only positive take-home contributes; an uncovered share becomes a
 * household shortfall, never silently absorbed by the other partner.
 *
 * A NEGATIVE take-home is a real cash need: deductions (`deferralCents + taxCents`)
 * exceeded the cash that reached the waterfall (`waterfallInflowCents`) — usually tax on
 * cash credited OUTSIDE the waterfall, though the treatment is cause-agnostic. It is the
 * HOUSEHOLD's to pay, so the combined discretionary pool covers it first and only the
 * uncoverable part falls to the cascade. Clamping it to 0 overstated the ending balance
 * and kept an unpayable bill from ever surfacing as insolvency.
 */
function splitSharedObligation(
  input: WaterfallInput,
  takeHomeByPerson: Map<string, Cents>,
): { leftoverByPerson: Map<string, Cents>; totalDiscretionary: Cents; shortfallCents: Cents } {
  const positiveTakeHome = new Map<string, Cents>();
  let totalPositive: Cents = 0;
  let unfundedDeductionsCents: Cents = 0;
  for (const pid of input.personIds) {
    const rawTakeHomeCents = takeHomeByPerson.get(pid) ?? 0;
    positiveTakeHome.set(pid, Math.max(0, rawTakeHomeCents));
    totalPositive += Math.max(0, rawTakeHomeCents);
    unfundedDeductionsCents += Math.max(0, -rawTakeHomeCents);
  }

  const shareByPerson = new Map<string, Cents>();
  if (input.sharedObligationCents <= 0) {
    for (const pid of input.personIds) shareByPerson.set(pid, 0);
  } else if (input.sharedScheme === "even") {
    const shares = splitEven(input.sharedObligationCents, Math.max(1, input.personIds.length));
    input.personIds.forEach((pid, i) => shareByPerson.set(pid, shares[i] ?? 0));
  } else if (totalPositive <= 0) {
    // 0/0 guard: nobody can contribute, so the whole obligation is a shortfall.
    for (const pid of input.personIds) shareByPerson.set(pid, 0);
  } else {
    // Cumulative rounding so the shares sum to the obligation exactly.
    let prevCum = 0;
    let acc = 0;
    for (const pid of input.personIds) {
      acc += positiveTakeHome.get(pid) ?? 0;
      const cum = Math.round((input.sharedObligationCents * acc) / totalPositive);
      shareByPerson.set(pid, cum - prevCum);
      prevCum = cum;
    }
  }

  let shortfallCents: Cents = 0;
  const leftoverByPerson = new Map<string, Cents>();
  let totalDiscretionary: Cents = 0;
  for (const pid of input.personIds) {
    const th = positiveTakeHome.get(pid) ?? 0;
    const share = shareByPerson.get(pid) ?? 0;
    const covered = Math.min(share, th);
    shortfallCents += share - covered;
    const leftover = th - covered;
    leftoverByPerson.set(pid, leftover);
    totalDiscretionary += leftover;
  }
  // Unassigned obligation is unmet. Only the zero-income branch leaves any; elsewhere the
  // shares sum to the obligation and this term is 0.
  const assignedShare = [...shareByPerson.values()].reduce((s, v) => s + v, 0);
  shortfallCents += Math.max(0, input.sharedObligationCents - assignedShare);
  const coveredByDiscretionary = Math.min(unfundedDeductionsCents, totalDiscretionary);
  totalDiscretionary -= coveredByDiscretionary;
  shortfallCents += unfundedDeductionsCents - coveredByDiscretionary;

  return { leftoverByPerson, totalDiscretionary, shortfallCents };
}

/**
 * Steps 4–6 — the deadline-paced (sinking-fund) goal loop, then the surplus.
 *
 * The deadline sets the pace, priority is scarcity triage: each dated goal is funded to its
 * {@link requiredContributionCents} pace and no more, so when every pace fits the order is a
 * no-op and only scarcity makes priority decide who falls behind. (Strict fill-order let
 * each priority-0 goal soak up every dollar until full.)
 *
 * Standing contributions fund between the two goal passes — after every dated pace, before
 * the `asap` fill — so a fill-order goal cannot starve a standing saving.
 *
 * Returns the contribution shortfall for the caller to fold into the household shortfall.
 */
function fundGoalsAndContributions(
  input: WaterfallInput,
  leftoverByPerson: Map<string, Cents>,
  totalDiscretionary: Cents,
  deposits: Map<string, Cents>,
): Cents {
  const orderedGoals = [...input.goals].sort((a, b) => a.priority - b.priority);
  const nowMonth = input.nowMonth ?? 0;
  const rateOf = input.goalFundMonthlyRate ?? (() => 0);

  let sharedPoolRemaining = totalDiscretionary;
  const personalRemaining = new Map<string, Cents>(leftoverByPerson);
  let goalDepositsTotal: Cents = 0;

  // A personal goal draws the owner's leftover, still capped by the shared pool.
  const fundGoalUpTo = (goal: SimGoal, cap: Cents): void => {
    if (cap <= 0) return;
    const current = input.accountBalanceCents(goal.fundAccountId);
    const need = Math.max(0, goal.targetCents - current);
    const want = Math.min(need, cap);
    if (want <= 0) return;

    const owner = goal.scope === "personal" ? goal.ownerId : undefined;
    if (goal.scope === "personal" && owner === undefined) return;
    const available =
      owner === undefined
        ? sharedPoolRemaining
        : Math.min(personalRemaining.get(owner) ?? 0, sharedPoolRemaining);
    const fund = Math.min(want, available);
    if (fund <= 0) return;

    addDeposit(deposits, goal.fundAccountId, fund);
    goalDepositsTotal += fund;
    sharedPoolRemaining -= fund;
    if (owner !== undefined) {
      personalRemaining.set(owner, (personalRemaining.get(owner) ?? 0) - fund);
    }
  };

  // Pass 1 — dated goals funded to their sinking-fund pace, in priority order.
  for (const goal of orderedGoals) {
    if (goal.targetDate === "asap") continue;
    const current = input.accountBalanceCents(goal.fundAccountId);
    const monthsRemaining = goal.targetDate - nowMonth;
    const pace = requiredContributionCents(
      goal.targetCents,
      current,
      monthsRemaining,
      rateOf(goal.fundAccountId),
    );
    fundGoalUpTo(goal, pace);
  }

  // A COMMITTED monthly outflow, not a sweep of what's left: the full $X always lands in
  // the account and the part the pool cannot cover is BORROWED via the cascade, so
  // over-saving breaks the plan exactly as unaffordable spending does. Conserving: the
  // borrowed part is both deposited and subtracted back.
  //
  // Disclosed simplification `contributionsNotAssetFunded` (projection/assumptions.ts): that
  // shortfall reaches savings/credit only. Unaffordable SPENDING is funded by selling
  // investments in `simulate.ts` before this runs; a contribution never liquidates holdings,
  // so it can flip the plan insolvent while investment balances remain.
  let contributionShortfall: Cents = 0;
  for (const c of input.contributions ?? []) {
    const wanted = Math.max(0, c.monthlyCents);
    if (wanted <= 0) continue;
    addDeposit(deposits, c.accountId, wanted);
    const funded = Math.min(wanted, sharedPoolRemaining);
    goalDepositsTotal += funded;
    sharedPoolRemaining -= funded;
    contributionShortfall += wanted - funded;
  }

  // Pass 2 — asap goals have no deadline and so no pace: fill-order from the remainder.
  for (const goal of orderedGoals) {
    if (goal.targetDate !== "asap") continue;
    fundGoalUpTo(goal, Infinity);
  }

  // Surplus destination: the exact leftover after every pace (conservation).
  const surplusCents = totalDiscretionary - goalDepositsTotal;
  if (surplusCents > 0) {
    const destId =
      input.surplusDestination.kind === "swept"
        ? input.surplusDestination.accountId
        : input.liquidAccountId;
    if (destId !== null) addDeposit(deposits, destId, surplusCents);
  }
  return contributionShortfall;
}

/** Run one month through the phases named in the module doc. */
export function runWaterfall(input: WaterfallInput): WaterfallResult {
  const deposits = new Map<string, Cents>();

  const {
    grossByPerson,
    taxableByPerson,
    earnedGrossByPerson,
    sourceTaxableByPerson,
    sourceEarnedByPerson,
    deferralBySource,
    deferredByPerson,
  } = applyDeferrals(input, deposits);
  const {
    taxCents,
    payrollTaxCents,
    payrollTaxBySourceCents,
    takeHomeByPerson,
    taxByCategoryCents,
    taxBySourceCents,
  } = computeTakeHome(
    input,
    grossByPerson,
    taxableByPerson,
    earnedGrossByPerson,
    sourceTaxableByPerson,
    sourceEarnedByPerson,
    deferredByPerson,
  );
  const { leftoverByPerson, totalDiscretionary, shortfallCents } = splitSharedObligation(
    input,
    takeHomeByPerson,
  );
  const contributionShortfall = fundGoalsAndContributions(
    input,
    leftoverByPerson,
    totalDiscretionary,
    deposits,
  );

  // Tax charged must be fully attributed, or the cash-flow chart overstates take-home.
  // Fail loudly on an incomplete jurisdiction rather than falling back.
  assertTaxAttributionReconciles(taxCents, taxBySourceCents);
  assertPayrollTaxAttributionReconciles(payrollTaxCents, payrollTaxBySourceCents);

  return {
    taxCents,
    payrollTaxCents,
    payrollTaxBySourceCents,
    earnedThisMonthByPersonCents: earnedGrossByPerson,
    taxByCategoryCents,
    taxBySourceCents,
    deferralBySourceCents: Object.fromEntries(deferralBySource),
    deferredByPersonCents: deferredByPerson,
    accountDepositsCents: deposits,
    shortfallCents: shortfallCents + contributionShortfall,
  };
}
