/**
 * Allocation waterfall — pipeline step 3 in detail.
 *
 * ONE fixed-structure waterfall, never user-rearrangeable. Exactly four levers: each
 * person's pre-tax deferral % (per source `planDescriptor`), the shared-contribution
 * scheme, the goal priority order, and the surplus-cash destination.
 *
 * Per month, in strict order: deferrals → withholding → shared obligations → shared goals →
 * personal goals → surplus. Placement reads `planDescriptor`, taxation reads
 * `taxCategory`, never conflated: non-wage income has no descriptor, so it enters
 * POST-deferral yet still feeds the taxable pool.
 *
 * Pure: a month's resolved figures in, per-account deposits plus household shortfall out.
 * The simulator applies the deposits and routes the shortfall through the cascade.
 */

import { splitEven, type Cents } from "../money/money";
import type { TaxCategory } from "../money/cashFlowSeries";
import { addCategory, type SourceTaxable, type TaxableByCategory } from "./taxAttribution";
import type { SimGoal } from "../goal/goal";
import { requiredContributionCents } from "../goal/requiredContribution";
import type { WageWithholdingRequest } from "../jurisdiction/jurisdiction";
import type {
  IncomeSourceMonth,
  PersonWithholding,
  SourceYearToDate,
  PersonWageYearToDate,
  WaterfallInput,
  WaterfallResult,
} from "./waterfall.types";
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
  PersonWithholding,
  SourceYearToDate,
  PersonWageYearToDate,
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
 * Exported so any caller deriving a source's taxable base outside the waterfall shares one rule
 * with the month that will actually book it.
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
 * booking its interest). Exported alongside {@link deferralForSourceCents}, for the same reason.
 */
export function taxableAfterDeferralCents(src: IncomeSourceMonth, deferredCents: Cents): Cents {
  return Math.max(0, (src.taxableCents ?? src.waterfallInflowCents) - deferredCents);
}

/** The reporting key a source's tax and withholding lines band under. */
function sourceKeyOf(src: IncomeSourceMonth): string {
  return src.sourceId ?? src.taxCategory;
}

const NO_YEAR_TO_DATE: SourceYearToDate = {
  earnedByCategory: {},
  supplementalWagesCents: 0,
  wageWithholdingCents: 0,
  regularWagesCents: 0,
  regularWithholdingCents: 0,
};

const NO_PERSON_YEAR_TO_DATE: PersonWageYearToDate = { wagesCents: 0, withholdingCents: 0 };

/**
 * One source's pay for the month, resolved but not yet withheld against — the hand-off between
 * {@link applyDeferrals}'s two passes.
 */
interface PaidSource {
  readonly src: IncomeSourceMonth;
  readonly sourceKey: string;
  readonly earnedByCategory: TaxableByCategory;
  readonly priorYtd: SourceYearToDate;
  /** POST-deferral, recurring — the figure a multiple-jobs correction extends across the year. */
  readonly regularTaxableCents: Cents;
  /** POST-deferral, one-off. */
  readonly supplementalTaxableCents: Cents;
}

/** Merge two per-category maps into a new one; used to add this month's earnings onto a year-to-date base. */
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

/** What one source contributed to the month, once its deferral and its two withholdings are known. */
interface SourceOutcome {
  readonly key: string;
  readonly ownerId: string;
  /** PRE-deferral earned gross by category — the payroll base, and the year-to-date delta. */
  readonly earnedByCategory: TaxableByCategory;
  /** What the source paid, for the jurisdiction's own category-keyed rules. */
  readonly taxCategory: TaxCategory;
  readonly supplementalWagesCents: Cents;
  /** Everything withheld from this source's pay this month — regular and supplemental together. */
  readonly wageWithholdingCents: Cents;
  /** POST-deferral REGULAR wages — the income-tax base, not the payroll one, and no bonus in it. */
  readonly regularWagesCents: Cents;
  /** The part of {@link wageWithholdingCents} those regular wages alone produced. */
  readonly regularWithholdingCents: Cents;
  readonly payrollTaxCents: Cents;
  /** {@link payrollTaxCents} split across the categories this source earned in. */
  readonly payrollTaxByCategory: TaxableByCategory;
}

/**
 * Step 1 — per-source pre-tax deferrals, capped per person against the annual limit, and the two
 * withholdings each source's paycheck bears.
 *
 * Withholding lives HERE, at the source, rather than beside the person's totals, because that is
 * where payroll actually happens: a person with two jobs gets two independent paychecks, each
 * withheld against by an employer that can see only its own wages. Rolling their wages together
 * first and withholding once on the sum would model a payroll system that does not exist, and
 * would quietly erase the multi-employer over-withholding the year's filing exists to refund.
 *
 * Overflow past the deferral cap is not deferred: it stays in the gross and re-enters as taxable.
 */
function applyDeferrals(
  input: WaterfallInput,
  deposits: Map<string, Cents>,
): {
  grossByPerson: Map<string, Cents>;
  taxableByPerson: Map<string, TaxableByCategory>;
  sourceTaxableByPerson: Map<string, SourceTaxable[]>;
  sourceOutcomes: SourceOutcome[];
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
  // POST-deferral per-source taxable weight — the income tax's base, so the year's close can
  // apportion its per-category bill back to the sources that actually produced it (the same
  // {@link attributeTaxToSources} apportionment payroll uses monthly).
  const sourceTaxableByPerson = new Map<string, SourceTaxable[]>();
  const sourceOutcomes: SourceOutcome[] = [];
  const paidSources: PaidSource[] = [];
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
  for (const src of input.incomeSources) {
    grossByPerson.set(src.ownerId, (grossByPerson.get(src.ownerId) ?? 0) + src.waterfallInflowCents);
    const sourceKey = sourceKeyOf(src);

    // Pre-deferral taxable base for this source (gain-only for a returned-basis draw, interest for
    // an accrued booking, full gross for wages) — the same figure the taxable pool bands on, but
    // WITHOUT the deferral haircut, since payroll tax is levied on the whole gross.
    const sourceEarned = src.taxableCents ?? src.waterfallInflowCents;

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

    // Folded into the caller's year-to-date accumulator; the tax it eventually bears is settled
    // annually against what was withheld, never charged against this source here.
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

    if (sourceEarned <= 0) continue;

    const earnedByCategory: TaxableByCategory = {};
    addCategory(earnedByCategory, src.taxCategory, sourceEarned);

    // Withholding runs on the POST-deferral wage — a pre-tax deferral is not income-taxed, so it
    // is not withheld against either — and the supplemental slice is haircut by the deferral in
    // the same proportion, so the two halves still sum to what the paycheck actually paid.
    const supplementalGross = Math.min(Math.max(0, src.supplementalCents ?? 0), sourceEarned);
    const supplementalTaxable = Math.min(
      sourceTaxable,
      Math.round((supplementalGross * sourceTaxable) / sourceEarned),
    );
    paidSources.push({
      src,
      sourceKey,
      earnedByCategory,
      priorYtd: input.priorSourceYearToDate?.(src.ownerId, sourceKey) ?? NO_YEAR_TO_DATE,
      regularTaxableCents: sourceTaxable - supplementalTaxable,
      supplementalTaxableCents: supplementalTaxable,
    });
  }

  withholdPaidSources(input, paidSources, sourceOutcomes);
  return {
    grossByPerson,
    taxableByPerson,
    sourceTaxableByPerson,
    sourceOutcomes,
    deferralBySource,
    deferredByPerson,
    combinedDepositsByPlan,
  };
}

/**
 * Pass two — price every source's withholding, now that the month's pay is settled.
 *
 * Separate from the deferral pass because a person's concurrent jobs are only knowable once ALL of
 * them have been resolved, and a source's pay is only final once its deferral has been taken. The
 * jurisdiction is told what every job of the same provenance is paying this period so it can
 * correct for the brackets they share, and exactly one of them — the highest-paying — is flagged
 * to carry that correction, so it is applied once for the person and not once per employer.
 *
 * `sourceOutcomes` is appended in the caller's original source order; grouping is a lookup, not a
 * reordering, so reporting keys stay where the input put them.
 */
function withholdPaidSources(
  input: WaterfallInput,
  paidSources: readonly PaidSource[],
  sourceOutcomes: SourceOutcome[],
): void {
  interface PersonCategoryContext {
    readonly concurrentRegularWagesCents: readonly Cents[];
    readonly bearerKey: string;
    readonly personYtd: PersonWageYearToDate;
  }
  const grouped = new Map<string, PaidSource[]>();
  for (const paid of paidSources) {
    const key = `${paid.src.ownerId}|${paid.src.taxCategory}`;
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [paid]);
    else group.push(paid);
  }
  const contexts = new Map<string, PersonCategoryContext>();
  for (const [key, group] of grouped) {
    // Highest-paying first, ties broken on the source key so the bearer is stable month to month
    // rather than flipping between two equal jobs and jittering their paycheques.
    const ordered = [...group].sort(
      (a, b) =>
        b.regularTaxableCents - a.regularTaxableCents || a.sourceKey.localeCompare(b.sourceKey),
    );
    const first = ordered[0]!;
    contexts.set(key, {
      concurrentRegularWagesCents: ordered.map((p) => p.regularTaxableCents),
      bearerKey: first.sourceKey,
      personYtd:
        input.priorPersonWageYearToDate?.(first.src.ownerId, first.src.taxCategory) ??
        NO_PERSON_YEAR_TO_DATE,
    });
  }

  for (const paid of paidSources) {
    const { src, sourceKey, priorYtd } = paid;
    const context = contexts.get(`${src.ownerId}|${src.taxCategory}`)!;
    const request: WageWithholdingRequest = {
      taxCategory: src.taxCategory,
      regularWagesCents: paid.regularTaxableCents,
      supplementalWagesCents: paid.supplementalTaxableCents,
      priorSupplementalWagesCents: priorYtd.supplementalWagesCents,
      priorRegularWithholdingCents: priorYtd.regularWithholdingCents,
      payPeriodsPerYear: input.payPeriodsPerYear,
      remainingPayPeriods: input.periodsRemainingInTaxYear,
      concurrentRegularWagesCents: context.concurrentRegularWagesCents,
      bearsMultipleJobsAdjustment: context.bearerKey === sourceKey,
      priorPersonWagesCents: context.personYtd.wagesCents,
      priorPersonWithholdingCents: context.personYtd.withholdingCents,
    };
    const withhold = (r: WageWithholdingRequest): Cents =>
      Math.max(0, input.computeWageWithholdingCents?.(r) ?? 0);
    const wageWithholdingCents = withhold(request);
    // What the same paycheck would have withheld with no bonus on it. That, not the total, is what
    // the year-to-date carries forward, so the bonus cannot come back around as a bigger regular
    // deduction in the months after it. Only asked when there IS a bonus to take back out.
    const regularWithholdingCents =
      paid.supplementalTaxableCents === 0
        ? wageWithholdingCents
        : Math.min(wageWithholdingCents, withhold({ ...request, supplementalWagesCents: 0 }));
    const { payrollTaxCents, payrollTaxByCategory } = payrollTaxForSource(
      input,
      priorYtd.earnedByCategory,
      paid.earnedByCategory,
    );
    sourceOutcomes.push({
      key: sourceKey,
      ownerId: src.ownerId,
      earnedByCategory: paid.earnedByCategory,
      taxCategory: src.taxCategory,
      // Only the supplemental wages a jurisdiction would actually see on a payslip advance the
      // year-to-date band, so the deferral haircut is carried here too.
      supplementalWagesCents: paid.supplementalTaxableCents,
      wageWithholdingCents,
      regularWagesCents: paid.regularTaxableCents,
      regularWithholdingCents,
      payrollTaxCents,
      payrollTaxByCategory,
    });
  }
}

/**
 * One source's payroll tax this month: the seam on that SOURCE's year-to-date earnings after this
 * month minus the seam on its year-to-date before it. Per source because a real employer applies
 * every cap to its own wages alone. 0 when the jurisdiction supplies no payroll seam.
 *
 * When a breakdown seam is also supplied, the SAME after-minus-before difference is taken per
 * category, so the split is right even though a capped component means the increment is not
 * simply this month's earned amount times a flat rate.
 */
function payrollTaxForSource(
  input: WaterfallInput,
  priorEarnedByCategory: TaxableByCategory,
  earnedThisMonth: TaxableByCategory,
): { payrollTaxCents: Cents; payrollTaxByCategory: TaxableByCategory } {
  const seam = input.computePayrollWithholdingCents;
  if (seam === undefined) return { payrollTaxCents: 0, payrollTaxByCategory: {} };
  const after = mergeCategories(priorEarnedByCategory, earnedThisMonth);
  const payrollTaxCents = seam(after) - seam(priorEarnedByCategory);
  const breakdownSeam = input.computePayrollWithholdingByCategoryCents;
  if (breakdownSeam === undefined) return { payrollTaxCents, payrollTaxByCategory: {} };
  const breakdownAfter = breakdownSeam(after);
  const breakdownBefore = breakdownSeam(priorEarnedByCategory);
  const payrollTaxByCategory: TaxableByCategory = {};
  for (const category of new Set([
    ...Object.keys(breakdownAfter),
    ...Object.keys(breakdownBefore),
  ]) as Set<TaxCategory>) {
    const increment = (breakdownAfter[category] ?? 0) - (breakdownBefore[category] ?? 0);
    if (increment) addCategory(payrollTaxByCategory, category, increment);
  }
  return { payrollTaxCents, payrollTaxByCategory };
}

/**
 * Step 2 — take-home: gross, less the pre-tax deferral, less the two amounts payroll withheld,
 * less (in the filing month only) the balance the prior year settled at.
 *
 * Nothing here PRICES a year. Income tax is annual and this function sees one month, so it charges
 * exactly what payroll took out of the month's paychecks — a figure computed per source in
 * {@link applyDeferrals} from that source's own pay. `taxableByPerson` rides back to the caller
 * UNCHARGED: the year's actual liability is reconciled against these withholdings once the year
 * closes, never derived from this month's income.
 */
function computeTakeHome(
  input: WaterfallInput,
  grossByPerson: Map<string, Cents>,
  taxableByPerson: Map<string, TaxableByCategory>,
  sourceOutcomes: readonly SourceOutcome[],
  deferredByPerson: Map<string, Cents>,
): {
  taxCents: Cents;
  wageWithholdingCents: Cents;
  wageWithholdingBySourceCents: Record<string, Cents>;
  wageWithholdingByPerson: Map<string, PersonWithholding>;
  payrollTaxCents: Cents;
  payrollTaxBySourceCents: Record<string, Cents>;
  sourceYearToDateDeltas: Map<string, Map<string, SourceYearToDate>>;
  takeHomeByPerson: Map<string, Cents>;
} {
  let wageWithholdingCents: Cents = 0;
  let payrollTaxCents: Cents = 0;
  const wageWithholdingBySourceCents: Record<string, Cents> = {};
  const wageWithholdingByPerson = new Map<string, PersonWithholding>();
  const payrollTaxBySourceCents: Record<string, Cents> = {};
  const payrollTaxByPerson = new Map<string, Cents>();
  const sourceYearToDateDeltas = new Map<string, Map<string, SourceYearToDate>>();

  for (const outcome of sourceOutcomes) {
    wageWithholdingCents += outcome.wageWithholdingCents;
    payrollTaxCents += outcome.payrollTaxCents;
    if (outcome.wageWithholdingCents !== 0) {
      wageWithholdingBySourceCents[outcome.key] =
        (wageWithholdingBySourceCents[outcome.key] ?? 0) + outcome.wageWithholdingCents;
      const running = wageWithholdingByPerson.get(outcome.ownerId);
      const byCategoryCents = mergeCategories(running?.byCategoryCents, undefined);
      addCategory(byCategoryCents, outcome.taxCategory, outcome.wageWithholdingCents);
      const bySourceCents = { ...(running?.bySourceCents ?? {}) };
      bySourceCents[outcome.key] =
        (bySourceCents[outcome.key] ?? 0) + outcome.wageWithholdingCents;
      wageWithholdingByPerson.set(outcome.ownerId, {
        totalCents: (running?.totalCents ?? 0) + outcome.wageWithholdingCents,
        byCategoryCents,
        bySourceCents,
      });
    }
    if (outcome.payrollTaxCents !== 0) {
      payrollTaxBySourceCents[outcome.key] =
        (payrollTaxBySourceCents[outcome.key] ?? 0) + outcome.payrollTaxCents;
      payrollTaxByPerson.set(
        outcome.ownerId,
        (payrollTaxByPerson.get(outcome.ownerId) ?? 0) + outcome.payrollTaxCents,
      );
      if (input.computePayrollWithholdingByCategoryCents !== undefined) {
        assertPersonPayrollTaxBreakdownReconciles(
          outcome.ownerId,
          outcome.payrollTaxCents,
          outcome.payrollTaxByCategory,
        );
      }
    }
    let byPerson = sourceYearToDateDeltas.get(outcome.ownerId);
    if (byPerson === undefined) {
      byPerson = new Map();
      sourceYearToDateDeltas.set(outcome.ownerId, byPerson);
    }
    const existing = byPerson.get(outcome.key);
    byPerson.set(
      outcome.key,
      existing === undefined
        ? {
            earnedByCategory: { ...outcome.earnedByCategory },
            supplementalWagesCents: outcome.supplementalWagesCents,
            wageWithholdingCents: outcome.wageWithholdingCents,
            regularWagesCents: outcome.regularWagesCents,
            regularWithholdingCents: outcome.regularWithholdingCents,
            taxCategory: outcome.taxCategory,
          }
        : {
            earnedByCategory: mergeCategories(existing.earnedByCategory, outcome.earnedByCategory),
            supplementalWagesCents:
              existing.supplementalWagesCents + outcome.supplementalWagesCents,
            wageWithholdingCents: existing.wageWithholdingCents + outcome.wageWithholdingCents,
            regularWagesCents: existing.regularWagesCents + outcome.regularWagesCents,
            regularWithholdingCents:
              existing.regularWithholdingCents + outcome.regularWithholdingCents,
            taxCategory: outcome.taxCategory,
          },
    );
  }

  let taxCents: Cents = wageWithholdingCents;
  const takeHomeByPerson = new Map<string, Cents>();
  for (const pid of input.personIds) {
    const settlementCents = input.settlementCashCents?.(pid) ?? 0;
    taxCents += settlementCents;
    takeHomeByPerson.set(
      pid,
      (grossByPerson.get(pid) ?? 0) -
        (deferredByPerson.get(pid) ?? 0) -
        (payrollTaxByPerson.get(pid) ?? 0) -
        (wageWithholdingByPerson.get(pid)?.totalCents ?? 0) -
        settlementCents,
    );
  }
  // Every person's taxable base is present, even an all-zero one, so the caller's fold into
  // the annual accumulator never has to special-case a person with no income this month.
  for (const pid of input.personIds) {
    if (!taxableByPerson.has(pid)) taxableByPerson.set(pid, {});
  }
  return {
    taxCents,
    wageWithholdingCents,
    wageWithholdingBySourceCents,
    wageWithholdingByPerson,
    payrollTaxCents,
    payrollTaxBySourceCents,
    sourceYearToDateDeltas,
    takeHomeByPerson,
  };
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
    // Funding window closes the month after the deadline: the deadline month itself still
    // paces normally (any remaining gap is due in full), but nothing funds it after that.
    if (nowMonth > goal.targetDate) continue;
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
    sourceTaxableByPerson,
    sourceOutcomes,
    deferralBySource,
    deferredByPerson,
    combinedDepositsByPlan,
  } = applyDeferrals(input, deposits);
  const {
    taxCents,
    wageWithholdingCents,
    wageWithholdingBySourceCents,
    wageWithholdingByPerson,
    payrollTaxCents,
    payrollTaxBySourceCents,
    sourceYearToDateDeltas,
    takeHomeByPerson,
  } = computeTakeHome(input, grossByPerson, taxableByPerson, sourceOutcomes, deferredByPerson);
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

  // Payroll tax charged must be fully attributed, or the cash-flow chart overstates take-home.
  // Fail loudly on an incomplete jurisdiction rather than falling back. Income-tax withholding
  // needs no such check: it is computed per source to begin with, so its split is exact rather
  // than apportioned, and the April settlement rides on the caller's own splits.
  assertPayrollTaxAttributionReconciles(payrollTaxCents, payrollTaxBySourceCents);

  return {
    taxCents,
    wageWithholdingCents,
    wageWithholdingBySourceCents,
    wageWithholdingByPerson,
    payrollTaxCents,
    payrollTaxBySourceCents,
    sourceYearToDateDeltas,
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
  };
}
