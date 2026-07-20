import type { Cents } from "../money";
import type { Jurisdiction, GovernmentBenefitClaim, GovernmentBenefitContext } from "../jurisdiction";
import { addEarnings, toEarningsRecord, type EarningsAccumulator } from "../earningsRecord";
import { priceGovernmentBenefitBaseMonthlyCents } from "../socialSecurityBenefit";
import type { TaxCategory } from "../cashFlowSeries";
import type { IncomeSourceMonth } from "./waterfall";
import type { SimPerson, SimOwnedSeries } from "./simulate";

/** Default government-benefit claiming age (full retirement age) when unspecified (§5.4). */
export const DEFAULT_BENEFIT_CLAIMING_AGE = 67;

/**
 * The slice of the simulator's state that the Social Security bookkeeping reads.
 * A structural view over `SimState` — declaring it here (rather than importing the
 * whole mutable `SimState`) keeps that state object private to the simulator while
 * this module stays independently testable.
 */
export interface EarningsState {
  /**
   * Per-person lifetime SS-covered earnings accumulator (§5.4), seeded from the
   * §4.6 pre-now summary and folded into each month.
   */
  readonly earningsByPerson: Map<string, EarningsAccumulator>;
  /** Every person by id — SS accumulation/claiming reads birthYear + benefitClaimingAge. */
  readonly personsById: ReadonlyMap<string, SimPerson>;
  /**
   * The frozen BASE government retirement benefit (nominal cents, eligibility-age
   * dollars) per person: the seam's `PIA × claimingFactor`, held as an OPAQUE number
   * the engine never re-derives. The benefit actually paid each year is this base run
   * through the jurisdiction's COLA seam ({@link Jurisdiction.colaAdjustedBenefitCents}).
   * Absent until claimed.
   */
  readonly ssMonthlyBenefitByPerson: Map<string, Cents>;
  /**
   * Per-person marker: the latest COMPLETED calendar year already folded into the
   * cached base (§5.4, Phase 5). Drives recompute-while-working — see
   * {@link buildSocialSecuritySources}. Absent until the first base is computed.
   */
  readonly lastComputedThroughYear: Map<string, number>;
}

/**
 * Which income tax categories count toward the covered-earnings record is a
 * jurisdiction fact, not an engine one (§5.4) — it moved onto the {@link
 * Jurisdiction.isCoveredEarnings} seam. When a jurisdiction omits the predicate,
 * the engine falls back to a documented bookkeeping-only default: `wages` only.
 * (US supplies `wages || ordinaryIncome`; the null jurisdiction never reads the
 * record, so the fallback is moot there.)
 */
function coversEarnings(jurisdiction: Jurisdiction, taxCategory: TaxCategory): boolean {
  return jurisdiction.isCoveredEarnings?.(taxCategory) ?? taxCategory === "wages";
}

/**
 * Fold this month's covered wage income into each owner's lifetime earnings
 * accumulator (§5.4). Pure bookkeeping over the same per-source gross the waterfall
 * sees, tagged by taxCategory (default `ordinaryIncome`); the jurisdiction decides
 * which categories are covered via {@link coversEarnings}.
 */
export function accumulateEarnings(
  earningsByPerson: Map<string, EarningsAccumulator>,
  incomeSeries: readonly SimOwnedSeries[],
  month: number,
  year: number,
  jurisdiction: Jurisdiction,
): void {
  for (const s of incomeSeries) {
    const acc = earningsByPerson.get(s.ownerId);
    if (acc === undefined) continue; // income owner not on the roster — no SS record
    if (!coversEarnings(jurisdiction, s.series.taxCategory ?? "ordinaryIncome")) continue;
    addEarnings(acc, year, s.series.getMonthlyCents(month));
  }
}

/**
 * The first month a person is claiming Social Security: benefits begin in the
 * calendar year they turn their claiming age (§5.4). Returns null when the person
 * has no birth year (SS not modelled). May be ≤ 0 (already claiming at "now").
 */
function ssClaimStartMonth(person: SimPerson, startYear: number): number | null {
  if (person.birthYear === undefined) return null;
  const claimingAge = person.benefitClaimingAge ?? DEFAULT_BENEFIT_CLAIMING_AGE;
  return 12 * (person.birthYear + claimingAge - startYear);
}

/**
 * This month's government retirement benefit income sources (§5.4) — one per
 * claiming person. The *base* benefit is priced once at the claiming month from the
 * frozen earnings record via the jurisdiction's base seam (0 when the jurisdiction
 * supplies none or the eligibility gate fails), then held OPAQUE. Each year the paid
 * benefit is the base run through the jurisdiction's COLA seam — the engine never
 * sees the COLA formula nor the eligibility age; `rules` owns the single
 * `(1 + colaRate)^(currentAge − eligibilityAge)` factor that replaces the old
 * split of an eligibility bridge plus a post-claim forward COLA. Carries
 * `taxCategory:"governmentRetirementBenefit"` and NO planDescriptor, so it enters
 * the waterfall post-deferral and is taxed by the jurisdiction's own benefit-
 * inclusion rule at the §5.3 chokepoint, never as wages. The engine passes the FULL
 * benefit gross — the inclusion % lives in `computeTaxCents`, not here.
 */
export function buildSocialSecuritySources(
  state: EarningsState,
  jurisdiction: Jurisdiction,
  month: number,
  startYear: number,
  colaRate: number,
): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  const year = startYear + Math.floor(month / 12);
  for (const person of state.personsById.values()) {
    const claimStart = ssClaimStartMonth(person, startYear);
    if (claimStart === null || month < claimStart) continue;
    const currentAge = year - person.birthYear!;

    // Recompute-while-working (§5.4, Phase 5): the base is priced once at claim, then
    // AGAIN only when a newer completed year has added covered earnings — a person who
    // claims and keeps working bumps their benefit, while a retire-then-claim base
    // stays frozen. `latestCompletedYear` is the last fully-elapsed calendar year; a
    // recompute fires when it exceeds the per-person marker AND that year is on the
    // record with covered earnings, so a static record never re-prices.
    // NOTE → #81 (Retirement Earnings Test): this models only the UPSIDE of working
    //   past claim (a higher benefit); the offsetting earnings-test withholding that
    //   would temporarily reduce benefits for a working claimant before FRA is out of
    //   scope here and tracked separately.
    const latestCompletedYear = year - 1;
    const marker = state.lastComputedThroughYear.get(person.id);
    const acc = state.earningsByPerson.get(person.id);
    let base = state.ssMonthlyBenefitByPerson.get(person.id);
    const recordGrew =
      marker !== undefined &&
      latestCompletedYear > marker &&
      (acc?.get(latestCompletedYear) ?? 0) > 0;
    if (base === undefined || recordGrew) {
      const claimingAge = person.benefitClaimingAge ?? DEFAULT_BENEFIT_CLAIMING_AGE;
      // The live seam input (§5.4): the frozen record plus the who/when the
      // jurisdiction's benefit formula needs. `currentAge` advances on recompute so
      // `rules` indexes the grown record to the same age-60 year.
      const claim: GovernmentBenefitClaim = {
        record: toEarningsRecord(acc ?? new Map()),
        claimYear: year,
        claimingAge,
        currentAge,
      };
      base = priceGovernmentBenefitBaseMonthlyCents(jurisdiction, claim);
      state.ssMonthlyBenefitByPerson.set(person.id, base);
      state.lastComputedThroughYear.set(person.id, latestCompletedYear);
    }
    if (base <= 0) continue;
    // Grow the opaque base forward by the jurisdiction's COLA seam (one cheap call
    // per year). The single COLA factor folds in the old age-62→claim bridge, so
    // the engine no longer knows the eligibility age or the bridge formula.
    const ctx: GovernmentBenefitContext = { year, currentAge, colaRate };
    const paid = jurisdiction.colaAdjustedBenefitCents?.(base, ctx) ?? base;
    sources.push({
      ownerId: person.id,
      grossCents: paid,
      taxCategory: "governmentRetirementBenefit",
    });
  }
  return sources;
}
