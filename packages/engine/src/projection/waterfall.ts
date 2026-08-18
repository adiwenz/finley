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

import { splitEven, type Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import {
  addCategory,
  attributeTaxToSources,
  type SourceTaxable,
  type TaxableByCategory,
} from "./taxAttribution";
import type { SimGoal } from "../goal/goal";
import { requiredContributionCents } from "../goal/requiredContribution";
import type { IncomeSourceMonth, WaterfallInput, WaterfallResult } from "./waterfall.types";
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
 * Pre-tax deferral this source takes: its plan's fraction of gross, clamped to the person's
 * remaining annual room. Overflow past the cap is not deferred and stays taxable.
 *
 * Exported because the tax-year projection ({@link
 * import("./taxYearProjection").projectKnownTaxYear}) has to derive the same taxable base from
 * the same compiled series MONTHS before this waterfall runs on them; sharing the rule is what
 * keeps a monthly estimate from being computed off a base the actual month will never book.
 */
export function deferralForSourceCents(
  src: IncomeSourceMonth,
  remainingRoomCents: number,
): Cents {
  if (!src.planDescriptor || src.waterfallInflowCents <= 0) return 0;
  const desired = Math.round(src.waterfallInflowCents * src.planDescriptor.deferralFraction);
  return Math.max(0, Math.min(desired, remainingRoomCents));
}

/**
 * A source's taxable base once its deferral is out. `taxableCents` overrides the gross when
 * taxable differs from cash (a returned-basis draw books only its gain, an accrued-interest
 * booking its interest). Shared with the projection — see {@link deferralForSourceCents}.
 */
export function taxableAfterDeferralCents(src: IncomeSourceMonth, deferredCents: Cents): Cents {
  return Math.max(0, (src.taxableCents ?? src.waterfallInflowCents) - deferredCents);
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
  sourceEarnedByPerson: Map<string, SourceTaxable[]>;
  sourceTaxableByPerson: Map<string, SourceTaxable[]>;
  deferralBySource: Map<string, Cents>;
  deferredByPerson: Map<string, Cents>;
  combinedDepositsByPlan: Map<string, Cents>;
} {
  const roomRemaining = new Map<string, number>();
  for (const pid of input.personIds) roomRemaining.set(pid, input.remainingDeferralRoomCents(pid));
  // Keyed by plan, not person — the combined limit applies to each plan separately. Filled
  // lazily: the plan keys are only known once we walk the income sources.
  const combinedRoomRemaining = new Map<string, number>();

  const grossByPerson = new Map<string, Cents>();
  const taxableByPerson = new Map<string, TaxableByCategory>();
  // Pre-deferral gross by category, the payroll-tax base: FICA ignores 401(k) deferrals, so
  // this is accumulated BEFORE the deferral is subtracted (unlike `taxableByPerson`).
  const earnedGrossByPerson = new Map<string, TaxableByCategory>();
  // This month's PRE-deferral earned amount per source, unhaircut by any deferral — the
  // weight the payroll-tax breakdown apportions by.
  const sourceEarnedByPerson = new Map<string, SourceTaxable[]>();
  // POST-deferral per-source taxable weight — mirrors `sourceEarnedByPerson` (payroll's
  // pre-deferral weight) but for income tax's base, so the year's close can later
  // apportion its per-category bill back to the sources that actually produced the year's
  // taxable income (the same {@link attributeTaxToSources} apportionment payroll uses monthly).
  const sourceTaxableByPerson = new Map<string, SourceTaxable[]>();
  const deferralBySource = new Map<string, Cents>();
  const deferredByPerson = new Map<string, Cents>();
  const combinedDepositsByPlan = new Map<string, Cents>();
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

    const room = roomRemaining.get(src.ownerId) ?? Infinity;
    const deferred = deferralForSourceCents(src, room);
    if (src.planDescriptor) {
      if (deferred > 0) {
        roomRemaining.set(src.ownerId, room - deferred);
        deferredByPerson.set(src.ownerId, (deferredByPerson.get(src.ownerId) ?? 0) + deferred);
        deferralBySource.set(sourceKey, (deferralBySource.get(sourceKey) ?? 0) + deferred);
        // The combined limit bounds deferral + match for THIS plan. `sourceKey` is the
        // bucket, so a second job brings its own room rather than sharing this one's.
        //
        // MODELLING POLICY (Finley's choice, not something any jurisdiction dictates): when
        // the combined limit binds, the employee's deferral is preserved whole and the
        // employer match absorbs the whole cut. Rationale is mechanical, not legal — the
        // deferral has already been subtracted from taxable income above, so trimming it
        // here would move the tax base and cascade through the rest of the month, whereas
        // employer money touches neither take-home nor tax. A consequence worth naming: if a
        // jurisdiction sets the combined limit BELOW the deferral limit, deferral alone can
        // exceed it. That is accepted — the deferral is never trimmed here.
        //
        // The match also RESERVES the employee's remaining deferral room for the rest of the
        // year. Without it a greedy early match eats the limit, and later deferrals — never
        // trimmed, per the policy above — would breach it. Conservative across several
        // plans: each holds room for deferral that may land in another.
        let combinedRoom = combinedRoomRemaining.get(sourceKey);
        if (combinedRoom === undefined) {
          combinedRoom = input.remainingCombinedDepositRoomCents(src.ownerId, sourceKey);
          combinedRoomRemaining.set(sourceKey, combinedRoom);
        }
        // An uncapped deferral limit reserves nothing — there is no bounded future deferral
        // to protect, and reserving `Infinity` would zero out every match.
        const reservedForDeferral = Number.isFinite(room) ? room - deferred : 0;
        const desiredMatch = Math.round(deferred * (src.planDescriptor.employerMatchFraction ?? 0));
        const match = Math.max(
          0,
          Math.min(desiredMatch, combinedRoom - deferred - reservedForDeferral),
        );
        const added = deferred + match;
        combinedRoomRemaining.set(sourceKey, Math.max(0, combinedRoom - added));
        combinedDepositsByPlan.set(sourceKey, (combinedDepositsByPlan.get(sourceKey) ?? 0) + added);
        addDeposit(deposits, src.planDescriptor.fundAccountId, added);
      }
    }

    // Folded into the caller's year-to-date accumulator; the tax it eventually bears is
    // settled annually, never charged against this source here (see {@link computeTakeHome}).
    const sourceTaxable = taxableAfterDeferralCents(src, deferred);
    addCategory(taxableFor(src.ownerId), src.taxCategory, sourceTaxable);
    if (sourceTaxable > 0) {
      let taxableList = sourceTaxableByPerson.get(src.ownerId);
      if (taxableList === undefined) {
        taxableList = [];
        sourceTaxableByPerson.set(src.ownerId, taxableList);
      }
      taxableList.push({ key: sourceKey, category: src.taxCategory, taxableCents: sourceTaxable });
    }
  }
  return {
    grossByPerson,
    taxableByPerson,
    earnedGrossByPerson,
    sourceEarnedByPerson,
    sourceTaxableByPerson,
    deferralBySource,
    deferredByPerson,
    combinedDepositsByPlan,
  };
}

/**
 * Step 2 — payroll tax, plus the month's ESTIMATED federal income-tax installment. The
 * installment is a fixed figure the caller supplies ({@link
 * WaterfallInput.estimatedIncomeTaxCents}); this function never prices tax itself, because the
 * liability is annual and only the caller knows the year (see {@link
 * import("../jurisdiction/jurisdiction").Jurisdiction.computeTaxCents}'s ANNUAL contract). So
 * take-home is gross minus deferral minus payroll tax minus that installment, while
 * `taxableByPerson` rides back to the caller UNCHARGED — the year's actual liability is
 * reconciled against the installments once the year closes, not derived from this month's income.
 */
function computeTakeHome(
  input: WaterfallInput,
  grossByPerson: Map<string, Cents>,
  taxableByPerson: Map<string, TaxableByCategory>,
  earnedGrossByPerson: Map<string, TaxableByCategory>,
  sourceEarnedByPerson: Map<string, SourceTaxable[]>,
  deferredByPerson: Map<string, Cents>,
): {
  taxCents: Cents;
  payrollTaxCents: Cents;
  payrollTaxBySourceCents: Record<string, Cents>;
  takeHomeByPerson: Map<string, Cents>;
} {
  const payrollSeam = input.computePayrollTaxCents;
  const payrollBreakdownSeam = input.computePayrollTaxByCategoryCents;
  let taxCents: Cents = 0;
  let payrollTaxCents: Cents = 0;
  const payrollTaxBySourceCents: Record<string, Cents> = {};
  const takeHomeByPerson = new Map<string, Cents>();
  for (const pid of input.personIds) {
    const gross = grossByPerson.get(pid) ?? 0;
    const deferral = deferredByPerson.get(pid) ?? 0;
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
    const estimatedIncomeTax = input.estimatedIncomeTaxCents?.(pid) ?? 0;
    taxCents += estimatedIncomeTax;
    takeHomeByPerson.set(pid, gross - deferral - payrollTax - estimatedIncomeTax);
  }
  // Every person's taxable base is present, even an all-zero one, so the caller's fold into
  // the annual accumulator never has to special-case a person with no income this month.
  for (const pid of input.personIds) {
    if (!taxableByPerson.has(pid)) taxableByPerson.set(pid, {});
  }
  return { taxCents, payrollTaxCents, payrollTaxBySourceCents, takeHomeByPerson };
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
 * Split `totalCents` across `personIds` proportional to `weightOf`, cumulative-rounded so the
 * shares sum to `totalCents` exactly. All-zero weight (nobody to split by — no income, or no
 * `eligibleAssetsCentsByPerson` seam) leaves every share 0, same as a non-positive `totalCents`:
 * the caller reads the gap between "assigned" and `totalCents` as unattributed, not lost.
 */
function proportionalSplit(
  totalCents: Cents,
  personIds: readonly string[],
  weightOf: (pid: string) => number,
): Map<string, Cents> {
  const shareByPerson = new Map<string, Cents>();
  const totalWeight = personIds.reduce((sum, pid) => sum + Math.max(0, weightOf(pid)), 0);
  if (totalCents <= 0 || totalWeight <= 0) {
    for (const pid of personIds) shareByPerson.set(pid, 0);
    return shareByPerson;
  }
  let prevCum = 0;
  let acc = 0;
  for (const pid of personIds) {
    acc += Math.max(0, weightOf(pid));
    const cum = Math.round((totalCents * acc) / totalWeight);
    shareByPerson.set(pid, cum - prevCum);
    prevCum = cum;
  }
  return shareByPerson;
}

/**
 * Step 3 — split shared obligations by the scheme, then take each person's share out of
 * their take-home. Only positive take-home contributes; an uncovered share becomes a
 * household shortfall, never silently absorbed by the other partner.
 *
 * While the household has ANY positive take-home, the split is proportional to it (§ Household
 * funding, step 1). Only when nobody has positive take-home does it fall back to each person's
 * {@link WaterfallInput.eligibleAssetsCentsByPerson} (step 2) — the same {@link proportionalSplit}
 * cumulative-rounding technique, just weighted by assets instead of income. No seam (or nobody
 * with assets either) leaves the obligation entirely unattributed to a person — still counted in
 * `shortfallCents`, just not in {@link obligationShortfallByPersonCents}, which decumulation reads
 * only as a PREFERENCE for whose accounts to try first, never as the total it must cover.
 *
 * A NEGATIVE take-home is a real cash need: deductions (`deferralCents + taxCents`)
 * exceeded the cash that reached the waterfall (`waterfallInflowCents`) — usually tax on
 * cash credited OUTSIDE the waterfall, though the treatment is cause-agnostic. It is the
 * HOUSEHOLD's to pay, so the combined discretionary pool covers it first and only the
 * uncoverable part falls to the cascade — left unattributed to a person for the same reason.
 * Clamping it to 0 overstated the ending balance and kept an unpayable bill from ever
 * surfacing as insolvency.
 */
function splitSharedObligation(
  input: WaterfallInput,
  takeHomeByPerson: Map<string, Cents>,
): {
  leftoverByPerson: Map<string, Cents>;
  totalDiscretionary: Cents;
  shortfallCents: Cents;
  obligationShortfallByPersonCents: Map<string, Cents>;
} {
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
  } else {
    const weightOf =
      totalPositive > 0
        ? (pid: string) => positiveTakeHome.get(pid) ?? 0
        : (pid: string) => input.eligibleAssetsCentsByPerson?.(pid) ?? 0;
    for (const [pid, share] of proportionalSplit(
      input.sharedObligationCents,
      input.personIds,
      weightOf,
    )) {
      shareByPerson.set(pid, share);
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
  // Unassigned obligation is unmet. Only an all-zero-weight fallback leaves any; whenever a
  // split actually ran (income or assets), `proportionalSplit`'s cumulative rounding sums the
  // shares to the obligation exactly and this term is 0.
  const assignedShare = [...shareByPerson.values()].reduce((s, v) => s + v, 0);
  shortfallCents += Math.max(0, input.sharedObligationCents - assignedShare);
  const coveredByDiscretionary = Math.min(unfundedDeductionsCents, totalDiscretionary);
  totalDiscretionary -= coveredByDiscretionary;
  shortfallCents += unfundedDeductionsCents - coveredByDiscretionary;

  // A SEPARATE, preference-only split of the now-finalized `shortfallCents`, weighted the same
  // way as the real split but independently FLOORED rather than cumulative-rounded: two people
  // with IDENTICAL weight get the IDENTICAL target from the identical formula, with no
  // positional tie-break to land the odd cent on one of them arbitrarily (the cumulative
  // rounding `shareByPerson` needs to stay cent-exact for the real allocation above cannot make
  // that promise). Never overshoots `shortfallCents` — at most `personIds.length − 1` cents go
  // unattributed, folded into the scalar total same as any other unattributed shortfall.
  const shortfallWeightOf =
    totalPositive > 0
      ? (pid: string) => positiveTakeHome.get(pid) ?? 0
      : (pid: string) => input.eligibleAssetsCentsByPerson?.(pid) ?? 0;
  const totalShortfallWeight = input.personIds.reduce(
    (sum, pid) => sum + Math.max(0, shortfallWeightOf(pid)),
    0,
  );
  const obligationShortfallByPersonCents = new Map<string, Cents>(
    input.personIds.map((pid) => [
      pid,
      totalShortfallWeight > 0
        ? Math.floor((shortfallCents * Math.max(0, shortfallWeightOf(pid))) / totalShortfallWeight)
        : 0,
    ]),
  );

  return { leftoverByPerson, totalDiscretionary, shortfallCents, obligationShortfallByPersonCents };
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
    sourceEarnedByPerson,
    sourceTaxableByPerson,
    deferralBySource,
    deferredByPerson,
    combinedDepositsByPlan,
  } = applyDeferrals(input, deposits);
  const { taxCents, payrollTaxCents, payrollTaxBySourceCents, takeHomeByPerson } = computeTakeHome(
    input,
    grossByPerson,
    taxableByPerson,
    earnedGrossByPerson,
    sourceEarnedByPerson,
    deferredByPerson,
  );
  const {
    leftoverByPerson,
    totalDiscretionary,
    shortfallCents,
    obligationShortfallByPersonCents,
  } = splitSharedObligation(input, takeHomeByPerson);
  const contributionShortfall = fundGoalsAndContributions(
    input,
    leftoverByPerson,
    totalDiscretionary,
    deposits,
  );

  // Payroll tax charged must be fully attributed, or the cash-flow chart overstates
  // take-home. Fail loudly on an incomplete jurisdiction rather than falling back. Income
  // tax has no such check here — this function is handed a scalar installment, and the caller
  // that priced it owns its category/source splits (see {@link computeTakeHome}).
  assertPayrollTaxAttributionReconciles(payrollTaxCents, payrollTaxBySourceCents);

  return {
    taxCents,
    payrollTaxCents,
    payrollTaxBySourceCents,
    earnedThisMonthByPersonCents: earnedGrossByPerson,
    taxByCategoryCents: {},
    taxBySourceCents: {},
    taxableByPersonCents: taxableByPerson,
    taxableBySourcePersonCents: sourceTaxableByPerson,
    deferralBySourceCents: Object.fromEntries(deferralBySource),
    deferredByPersonCents: deferredByPerson,
    combinedDepositsByPlanCents: combinedDepositsByPlan,
    accountDepositsCents: deposits,
    shortfallCents: shortfallCents + contributionShortfall,
    obligationShortfallCents: shortfallCents,
    obligationShortfallByPersonCents,
  };
}
