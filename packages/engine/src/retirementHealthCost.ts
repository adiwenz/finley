/**
 * The retirement survival check's health-cost term (§5.4): each person's real
 * annual health cost as the §7 forward simulation steps year by year. Split out of
 * `retirement.ts` as its own concern — the solver ([simulateForward]) imports
 * `healthExpenseAtYear` as one of the per-year cost terms it sums, alongside the
 * income term.
 *
 * This is one of THREE engine-side health pieces, kept apart on purpose (see
 * `earlyRetireeHealthCheck.ts` for the map): this file is the survival-loop cost
 * PROJECTION, `earlyRetireeHealthCheck.ts` is the pre-65 honesty CHECK, and the US
 * dollar figures live in `rules`. It stays pure and takes resolved real cents off
 * {@link RetirementPerson} — no jurisdiction reach-in — the same discipline the
 * solver and the honesty check follow.
 *
 * Today its only consumer is the retirement solver, so it is typed on
 * `RetirementPerson`. If a second consumer appears (e.g. the §5 projection sim
 * wanting the same per-person real health line), that is the moment to narrow the
 * input to a flat scalar shape and generalise — not before.
 */

import type { Cents } from "./money";
import type { RetirementPerson } from "./retirementTypes";

/**
 * One person's real health cost this year (§5.4): the pre-Medicare figure while
 * below their enrolment age, the authored residual at/after it (unset enrolment age
 * → the pre-Medicare figure runs for life). Whichever is in force compounds at the
 * person's real health growth rate from year 0. 0 once they are no longer alive, or
 * when they carry no health cost.
 */
export function personHealthAtYear(person: RetirementPerson, yearOffset: number): Cents {
  const age = person.currentAge + yearOffset;
  if (age > person.lifeExpectancy) return 0; // health ends with the person
  const enrolled =
    person.medicareEligibilityAge !== undefined && age >= person.medicareEligibilityAge;
  const base = enrolled
    ? (person.postMedicareHealthAnnualCents ?? 0)
    : (person.annualHealthExpenseCents ?? 0);
  if (base <= 0) return 0;
  return Math.round(base * Math.pow(1 + (person.healthRealGrowthRate ?? 0), yearOffset));
}

/** The household's total real health cost this year — each living person's own line. */
export function healthExpenseAtYear(
  persons: readonly RetirementPerson[],
  yearOffset: number,
): Cents {
  let total = 0;
  for (const p of persons) total += personHealthAtYear(p, yearOffset);
  return total;
}
