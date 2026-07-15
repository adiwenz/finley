import type { Cents } from "../money";
import type { Jurisdiction } from "../jurisdiction";
import { addEarnings, toEarningsRecord, type EarningsAccumulator } from "../earningsRecord";
import { priceSocialSecurityMonthlyCents } from "../socialSecurityBenefit";
import type { TaxCategory } from "../cashFlowSeries";
import type { IncomeSourceMonth } from "./waterfall";
import type { Person, OwnedSeries } from "./simulate";

/** Default Social Security claiming age (full retirement age) when unspecified (§5.4). */
export const DEFAULT_SS_CLAIMING_AGE = 67;

/**
 * Age of first Social Security eligibility (62 under US law). COLAs apply to a
 * worker's benefit every year from this age onward — whether or not they have
 * claimed — so a benefit claimed later must be COLA-bridged across the
 * (claimingAge − 62) years between eligibility and the claim (see
 * {@link buildSocialSecuritySources}). Without the bridge, delaying a claim
 * silently forfeits those COLAs and cancels most of the delayed-retirement
 * credit. Pairs with {@link DEFAULT_SS_CLAIMING_AGE}.
 */
const SS_ELIGIBILITY_AGE = 62;

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
  /** Every person by id — SS accumulation/claiming reads birthYear + ssClaimingAge. */
  readonly personsById: ReadonlyMap<string, Person>;
  /**
   * The monthly Social Security benefit (nominal cents) as of each person's claim
   * year: the seam's eligibility-dollar PIA, COLA-bridged forward across the years
   * from age-62 eligibility to the claim (see {@link buildSocialSecuritySources}).
   * The benefit actually paid grows from here by the annual cost-of-living
   * adjustment (COLA) each further year post-claim. Absent until claimed.
   */
  readonly ssMonthlyBenefitByPerson: Map<string, Cents>;
}

/**
 * Income tax categories that count as SS-covered earnings for the {@link
 * EarningsRecord}. Wages/self-employment are covered; Social Security itself
 * (would be circular), capital gains, and tax-exempt income are not (§5.4).
 */
function isCoveredEarnings(taxCategory: TaxCategory): boolean {
  return taxCategory === "wages" || taxCategory === "ordinaryIncome";
}

/**
 * Fold this month's covered wage income into each owner's lifetime earnings
 * accumulator (§5.4). Pure bookkeeping — no jurisdiction knowledge. Uses the same
 * per-source gross the waterfall sees, tagged by taxCategory (default
 * `ordinaryIncome`, which counts as covered).
 */
export function accumulateEarnings(
  earningsByPerson: Map<string, EarningsAccumulator>,
  incomeSeries: readonly OwnedSeries[],
  month: number,
  year: number,
): void {
  for (const s of incomeSeries) {
    const acc = earningsByPerson.get(s.ownerId);
    if (acc === undefined) continue; // income owner not on the roster — no SS record
    if (!isCoveredEarnings(s.series.taxCategory ?? "ordinaryIncome")) continue;
    addEarnings(acc, year, s.series.getMonthlyCents(month));
  }
}

/**
 * The first month a person is claiming Social Security: benefits begin in the
 * calendar year they turn their claiming age (§5.4). Returns null when the person
 * has no birth year (SS not modelled). May be ≤ 0 (already claiming at "now").
 */
function ssClaimStartMonth(person: Person, startYear: number): number | null {
  if (person.birthYear === undefined) return null;
  const claimingAge = person.ssClaimingAge ?? DEFAULT_SS_CLAIMING_AGE;
  return 12 * (person.birthYear + claimingAge - startYear);
}

/**
 * This month's Social Security income sources (§5.4) — one per claiming person.
 * The *base* benefit is computed once at the claiming month from the frozen
 * earnings record via the jurisdiction seam (0 when the jurisdiction supplies
 * none). Each full year after claiming, the paid benefit is inflated from that
 * base by the cost-of-living adjustment (`colaRate`, the sim's CPI) so it keeps
 * pace with inflating expenses rather than eroding in real terms (§0.5, §5.4).
 * Carries `taxCategory:"socialSecurity"` and NO planDescriptor, so it enters the
 * waterfall post-deferral and is taxed by the SS rule, never as wages.
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
  // SS is only partially taxable (§5.4): attach the jurisdiction's taxable share
  // so the waterfall taxes just that slice and pays the whole benefit as take-home.
  // Absent seam → fully taxable (1), matching pre-partial-taxation behaviour.
  const taxableFraction = jurisdiction.socialSecurityTaxableFraction?.({ year }) ?? 1;
  for (const person of state.personsById.values()) {
    const claimStart = ssClaimStartMonth(person, startYear);
    if (claimStart === null || month < claimStart) continue;

    let benefit = state.ssMonthlyBenefitByPerson.get(person.id);
    if (benefit === undefined) {
      const claimingAge = person.ssClaimingAge ?? DEFAULT_SS_CLAIMING_AGE;
      const record = toEarningsRecord(state.earningsByPerson.get(person.id) ?? new Map());
      const piaCents = priceSocialSecurityMonthlyCents(jurisdiction, {
        record,
        claimYear: year,
        claimingAge,
        currentAge: year - person.birthYear!,
      });
      // The seam returns the benefit in age-62 (first-eligibility) dollars. COLAs
      // apply from eligibility whether or not the person has claimed, so bridge the
      // (claimingAge − 62) years between eligibility and the claim before paying it
      // — otherwise delaying a claim forfeits those COLAs and cancels most of the
      // delayed-retirement credit (§5.4).
      const eligibilityColaYears = Math.max(0, claimingAge - SS_ELIGIBILITY_AGE);
      benefit = Math.round(piaCents * Math.pow(1 + colaRate, eligibilityColaYears));
      state.ssMonthlyBenefitByPerson.set(person.id, benefit);
    }
    if (benefit <= 0) continue;
    // Inflate the base by the COLA for each full year elapsed since claiming —
    // a yearly step, matching how Social Security applies its annual COLA.
    const yearsSinceClaim = Math.floor((month - claimStart) / 12);
    const paid = Math.round(benefit * Math.pow(1 + colaRate, yearsSinceClaim));
    sources.push({
      ownerId: person.id,
      grossCents: paid,
      taxCategory: "socialSecurity",
      taxableFraction,
    });
  }
  return sources;
}
