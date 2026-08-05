import type { Cents } from "../money/money";
import type { Jurisdiction, GovernmentBenefitClaim, GovernmentBenefitContext } from "../jurisdiction/jurisdiction";
import { addEarnings, toEarningsRecord, type EarningsAccumulator } from "../job/earningsRecord";
import { priceGovernmentBenefitBaseMonthlyCents } from "../jurisdiction/governmentBenefit";
import type { TaxCategory } from "../money/cashFlowSeries";
import type { IncomeSourceMonth } from "./waterfall";
import type { SimOwnedSeries } from "./simulate";
import { isHouseholdMemberAt, type SimPerson } from "./simulate.types";

/**
 * The slice of `SimState` the government-benefit bookkeeping reads. A structural view, not
 * an import of the mutable `SimState`, so that state stays private to the simulator while
 * this module stays independently testable.
 */
export interface EarningsState {
  /** Per-person lifetime covered-earnings accumulator, seeded pre-now, folded monthly. */
  readonly earningsByPerson: Map<string, EarningsAccumulator>;
  /** Accumulation and claiming read `birthYear` + `benefitClaimingAge`. */
  readonly personsById: ReadonlyMap<string, SimPerson>;
  /**
   * The frozen BASE benefit per person (nominal cents, eligibility-age dollars): the seam's
   * `PIA × claimingFactor`, OPAQUE — the engine never re-derives it. What is paid each year
   * is this base run through {@link Jurisdiction.colaAdjustedBenefitCents}. Absent until
   * claimed.
   */
  readonly governmentBenefitBaseByPerson: Map<string, Cents>;
  /**
   * The latest COMPLETED calendar year already folded into the cached base; drives
   * recompute-while-working. Absent until the first base is computed.
   */
  readonly lastComputedThroughYear: Map<string, number>;
}

/**
 * Which tax categories count toward the covered-earnings record is a jurisdiction fact,
 * carried on {@link Jurisdiction.isCoveredEarnings}; without it the engine falls back to
 * `wages` only. (US supplies `wages || ordinaryIncome`; the null jurisdiction never reads
 * the record, so the fallback is moot there.)
 */
function coversEarnings(jurisdiction: Jurisdiction, taxCategory: TaxCategory): boolean {
  return jurisdiction.isCoveredEarnings?.(taxCategory) ?? taxCategory === "wages";
}

/**
 * Fold this month's covered income into each owner's lifetime accumulator, over the same
 * per-source gross the waterfall sees.
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
    if (acc === undefined) continue; // income owner not on the roster — no covered-earnings record
    if (!coversEarnings(jurisdiction, s.series.taxCategory ?? "ordinaryIncome")) continue;
    addEarnings(acc, year, s.series.getMonthlyCents(month));
  }
}

/**
 * The first benefit month: the calendar year the person turns their already-resolved
 * claiming age. Null when they have no birth year (benefit not modelled); may be ≤ 0
 * (already claiming at "now").
 */
function benefitClaimStartMonth(
  person: SimPerson,
  startYear: number,
  claimingAge: number,
): number | null {
  if (person.birthYear === undefined) return null;
  return 12 * (person.birthYear + claimingAge - startYear);
}

/**
 * This month's government retirement benefit sources, one per claiming person. The *base*
 * is priced once at the claiming month from the frozen earnings record via the
 * jurisdiction's base seam (0 when it supplies none or the eligibility gate fails), then
 * held OPAQUE; each year's paid benefit is that base run through the COLA seam. The engine
 * sees neither the COLA formula nor the eligibility age — `rules` owns the single
 * `(1 + colaRate)^(currentAge − eligibilityAge)` factor. Sources carry NO planDescriptor,
 * so they enter the waterfall post-deferral at the FULL gross and are taxed by the
 * jurisdiction's benefit-inclusion rule, never as wages.
 */
export function buildGovernmentBenefitSources(
  state: EarningsState,
  jurisdiction: Jurisdiction,
  month: number,
  startYear: number,
  colaRate: number,
): IncomeSourceMonth[] {
  const sources: IncomeSourceMonth[] = [];
  const year = startYear + Math.floor(month / 12);
  for (const person of state.personsById.values()) {
    // Membership first: a benefit belongs to the household on exactly the terms a wage does, and
    // the roster is everyone who was EVER a member — it is never pruned, because the earnings a
    // departed partner banked while they were here still happened. What stops is the paying. A
    // separated partner used to keep contributing their whole benefit for the rest of the
    // projection, since this loop was the one income path that never asked.
    if (!isHouseholdMemberAt(person, month)) continue;
    // And the benefit stops at the member's own expectancy — a dead member draws nothing, even
    // as household spending runs on to fund the survivor. A wage is not gated here: it ends where
    // its job was authored to, whatever the expectancy. Absent bound leaves it unbounded (legacy).
    if (person.lifeEndMonthExclusive !== undefined && month >= person.lifeEndMonthExclusive) continue;
    // The person's own pin, else the jurisdiction's default (full retirement age) — never a
    // hardcoded engine age. With neither, the benefit isn't timed at all.
    const claimingAge = person.benefitClaimingAge ?? jurisdiction.defaultBenefitClaimingAge;
    if (claimingAge === undefined) continue;
    const claimStart = benefitClaimStartMonth(person, startYear, claimingAge);
    if (claimStart === null || month < claimStart) continue;
    const currentAge = year - person.birthYear!;

    // Recompute-while-working: priced once at claim, then again only when a newer completed
    // year adds covered earnings — so claiming and working on bumps the benefit while a
    // retire-then-claim base stays frozen, and a static record never re-prices.
    // NOTE (Retirement Earnings Test): only the UPSIDE of working past claim is modelled;
    //   the offsetting pre-FRA earnings-test withholding is out of scope.
    const latestCompletedYear = year - 1;
    const marker = state.lastComputedThroughYear.get(person.id);
    const acc = state.earningsByPerson.get(person.id);
    let base = state.governmentBenefitBaseByPerson.get(person.id);
    const recordGrew =
      marker !== undefined &&
      latestCompletedYear > marker &&
      (acc?.get(latestCompletedYear) ?? 0) > 0;
    if (base === undefined || recordGrew) {
      // `currentAge` advances on recompute so `rules` indexes the grown record to the same
      // age-60 year.
      const claim: GovernmentBenefitClaim = {
        record: toEarningsRecord(acc ?? new Map()),
        claimYear: year,
        claimingAge,
        currentAge,
      };
      base = priceGovernmentBenefitBaseMonthlyCents(jurisdiction, claim);
      state.governmentBenefitBaseByPerson.set(person.id, base);
      state.lastComputedThroughYear.set(person.id, latestCompletedYear);
    }
    if (base <= 0) continue;
    // The COLA factor also folds in the eligibility-age→claim bridge.
    const ctx: GovernmentBenefitContext = { year, currentAge, colaRate };
    const paid = jurisdiction.colaAdjustedBenefitCents?.(base, ctx) ?? base;
    sources.push({
      ownerId: person.id,
      waterfallInflowCents: paid,
      taxCategory: "governmentRetirementBenefit",
      // Reported per person, so a two-earner household shows each benefit.
      sourceId: `benefit:${person.id}`,
      label: "Government benefit",
    });
  }
  return sources;
}
