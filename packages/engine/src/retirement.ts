/**
 * `findRetirementAge` — the household-aware retirement solver (§7).
 *
 * There is exactly ONE survival check and ONE binary search here; every
 * retirement "mode" is that check with different ages pinned vs. searched:
 *
 *  - Mode 1 ("when can *we* retire?", the headline) ties every person's age
 *    together and searches the group down to the earliest age that still lasts.
 *  - Mode 2 ("when can *this person* retire, given the others' plans?") pins
 *    everyone else at their planned age and searches one person.
 *  - Staggered retirement is Mode 2 with someone else's pin set to a
 *    non-matching value — no special code.
 *
 * The check runs on **real** (inflation-adjusted, §0.5) net worth: the scenario
 * is expressed in today's dollars and the portfolio compounds at a *real* return
 * rate, so "the money lasts to life expectancy" is answered in real terms and
 * never inflated by nominal growth (the §0.5 invariant this whole module exists
 * to protect).
 *
 * Withdrawals route through a single replaceable step ({@link WithdrawalStep},
 * §5.3 seam 3): v1 withdraws untaxed, but swapping in "tax by account type"
 * (pre-tax as income, Roth untaxed, taxable as cap gains) is a function swap, not
 * a solver rewrite.
 *
 * The Social Security claiming age is a PINNED INPUT to the check, never a
 * searched dimension (§7): the solver stays one-dimensional (it searches the
 * retirement age only). "Suggest the optimal claiming age" is a future §8
 * recommendation, not a change here.
 */

import type { Cents } from "./money";
import type {
  WithdrawalStep,
  RetirementPerson,
  RetirementScenario,
  RetirementSearch,
  RetirementSolution,
  SurvivalResult,
  RetirementTargetAssessment,
} from "./retirementTypes";

// Re-export the retirement vocabulary so `@finley/engine` consumers still reach
// it through this module; the declarations live in ./retirementTypes.
export type * from "./retirementTypes";

/** v1 withdrawal step: no tax, gross withdrawal equals the net need. */
export const untaxedWithdrawal: WithdrawalStep = (req) => req.netNeededCents;

// ---------------------------------------------------------------------------
// The one survival check (real dollars, annual steps).
// ---------------------------------------------------------------------------

/** Household spending applies while at least one person is still alive. */
function householdAlive(scenario: RetirementScenario, yearOffset: number): boolean {
  return scenario.persons.some((p) => p.currentAge + yearOffset <= p.lifeExpectancy);
}

/** This year's total real income across the household under a given age assignment. */
function incomeAtYear(
  scenario: RetirementScenario,
  ages: ReadonlyMap<string, number>,
  yearOffset: number,
): Cents {
  let total = 0;
  for (const p of scenario.persons) {
    const age = p.currentAge + yearOffset;
    if (age > p.lifeExpectancy) continue; // no longer alive → no income
    if (age < (ages.get(p.id) ?? p.plannedRetirementAge)) {
      total += p.annualEmploymentIncomeCents; // still working
    }
    if (age >= p.ssClaimingAge) {
      total += p.annualSocialSecurityCents; // claiming (independent of working)
    }
  }
  return total;
}

/** Build a `{ personId → number }` map by applying `value` to each household member. */
function mapPersons(
  scenario: RetirementScenario,
  value: (person: RetirementPerson) => number,
): Map<string, number> {
  return new Map(scenario.persons.map((p) => [p.id, value(p)]));
}

/** Each person's actual age in the given year — current ages, for the withdrawal seam. */
function agesInYear(scenario: RetirementScenario, yearOffset: number): Map<string, number> {
  return mapPersons(scenario, (p) => p.currentAge + yearOffset);
}

/** The last year offset the simulation runs to = furthest life expectancy from now. */
function horizonYears(scenario: RetirementScenario): number {
  let max = 0;
  for (const p of scenario.persons) max = Math.max(max, p.lifeExpectancy - p.currentAge);
  return max;
}

/**
 * Simulate the real portfolio forward under an age assignment, starting from
 * `startBalanceCents` at `fromYear`. Each year: apply net cash flow (contribute a
 * surplus, or withdraw a shortfall through the replaceable step), then compound at
 * the real return rate. Returns the running balance at the start of every year (so
 * callers can read the nest egg at a retirement boundary) and the lowest
 * post-flow balance reached.
 */
function simulateForward(
  scenario: RetirementScenario,
  ages: ReadonlyMap<string, number>,
  startBalanceCents: Cents,
  fromYear: number,
): { readonly enteringByYear: ReadonlyMap<number, Cents>; readonly lowestBalanceCents: Cents } {
  const withdraw = scenario.withdrawalStep ?? untaxedWithdrawal;
  const lastYear = horizonYears(scenario);
  const enteringByYear = new Map<number, Cents>();

  let balance = startBalanceCents;
  let lowest = Infinity;
  for (let year = fromYear; year <= lastYear; year++) {
    enteringByYear.set(year, balance);
    const income = incomeAtYear(scenario, ages, year);
    const expense = householdAlive(scenario, year) ? scenario.annualExpenseCents : 0;
    const net = income - expense;
    if (net >= 0) {
      balance += net;
    } else {
      balance -= withdraw({
        netNeededCents: -net,
        yearOffset: year,
        personAges: agesInYear(scenario, year),
      });
    }
    lowest = Math.min(lowest, balance);
    balance = Math.round(balance * (1 + scenario.realReturnRate));
  }
  return { enteringByYear, lowestBalanceCents: lowest === Infinity ? balance : lowest };
}

/**
 * The core §7 survival check: given a specific retirement age for every person,
 * does the combined real portfolio last to every person's life expectancy? This
 * is the single routine Mode 1, Mode 2, staggered retirement, and target mode all
 * call — they only differ in which ages they hand it.
 */
export function portfolioSurvives(
  scenario: RetirementScenario,
  agesByPersonId: ReadonlyMap<string, number>,
): SurvivalResult {
  const { lowestBalanceCents } = simulateForward(
    scenario,
    agesByPersonId,
    scenario.startingPortfolioCents,
    0,
  );
  return { survives: lowestBalanceCents >= 0, lowestBalanceCents };
}

// ---------------------------------------------------------------------------
// The one binary search — modes are just which ages get pinned.
// ---------------------------------------------------------------------------

/** Every person retires at the same searched age (Mode 1). */
function groupAges(scenario: RetirementScenario, age: number): Map<string, number> {
  return mapPersons(scenario, () => age);
}

/** The searched person retires at `age`; everyone else at their planned age (Mode 2). */
function personAges(
  scenario: RetirementScenario,
  personId: string,
  age: number,
): Map<string, number> {
  return mapPersons(scenario, (p) => (p.id === personId ? age : p.plannedRetirementAge));
}

/** Inclusive [lo, hi] age bounds for the searched dimension. */
function searchBounds(
  scenario: RetirementScenario,
  search: RetirementSearch,
): { readonly lo: number; readonly hi: number } {
  if (search.mode === "person") {
    const target = scenario.persons.find((p) => p.id === search.personId);
    if (!target) return { lo: 1, hi: 0 }; // empty range → no feasible age
    return { lo: target.currentAge, hi: target.lifeExpectancy };
  }
  // Group: the one age must be reachable by all (≥ everyone's current age) and a
  // real retirement age for all (≤ the shortest life expectancy).
  let lo = 0;
  let hi = Infinity;
  for (const p of scenario.persons) {
    lo = Math.max(lo, p.currentAge);
    hi = Math.min(hi, p.lifeExpectancy);
  }
  return { lo, hi };
}

/** Build the full age assignment for a searched age under the given mode. */
function agesForSearch(
  scenario: RetirementScenario,
  search: RetirementSearch,
  age: number,
): Map<string, number> {
  return search.mode === "group"
    ? groupAges(scenario, age)
    : personAges(scenario, search.personId, age);
}

/**
 * Lowest integer age in [lo, hi] that survives, or null if even `hi` fails.
 * Survival is monotonic in the retirement age (retiring later means more
 * contribution years and fewer withdrawal years, so it never *hurts*), so a
 * binary search finds the threshold.
 */
function lowestFeasibleAge(
  lo: number,
  hi: number,
  survivesAt: (age: number) => boolean,
): number | null {
  if (lo > hi) return null;
  if (!survivesAt(hi)) return null;
  let a = lo;
  let b = hi;
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    if (survivesAt(mid)) b = mid;
    else a = mid + 1;
  }
  return a;
}

/**
 * Solve mode (§7): the earliest age the searched dimension can retire and still
 * have the real portfolio last. Mode 1 (group) and Mode 2 (person) differ only in
 * {@link RetirementSearch}; staggered retirement is Mode 2 with a non-matching pin
 * on someone else (already baked into their `plannedRetirementAge`).
 */
export function findRetirementAge(
  scenario: RetirementScenario,
  search: RetirementSearch = { mode: "group" },
): RetirementSolution {
  const { lo, hi } = searchBounds(scenario, search);
  const age = lowestFeasibleAge(lo, hi, (candidate) =>
    portfolioSurvives(scenario, agesForSearch(scenario, search, candidate)).survives,
  );
  return {
    search,
    earliestFeasibleAge: age,
    agesByPersonId: age === null ? new Map() : agesForSearch(scenario, search, age),
  };
}

// ---------------------------------------------------------------------------
// Target mode (§7.1) — same check, run the other direction.
// ---------------------------------------------------------------------------

/**
 * The nest egg required at the retirement boundary to fund withdrawals to life
 * expectancy under a given age assignment — the minimum starting balance for the
 * withdrawal phase [fromYear, horizon] that still survives. Found by bisection so
 * it stays correct even when the withdrawal step is non-linear (a future taxable
 * step). Returns 0 when the phase never needs the portfolio (income covers spend).
 */
function requiredNestEggCents(
  scenario: RetirementScenario,
  ages: ReadonlyMap<string, number>,
  fromYear: number,
): Cents {
  const survivesWith = (balance: Cents): boolean =>
    simulateForward(scenario, ages, balance, fromYear).lowestBalanceCents >= 0;

  if (survivesWith(0)) return 0;

  // Upper bound: every remaining year withdraws the full grossed-up expense with
  // no income and no growth help — a safe over-estimate of the nest egg needed.
  const withdraw = scenario.withdrawalStep ?? untaxedWithdrawal;
  const lastYear = horizonYears(scenario);
  let hi = 0;
  for (let year = fromYear; year <= lastYear; year++) {
    hi += withdraw({
      netNeededCents: scenario.annualExpenseCents,
      yearOffset: year,
      personAges: agesInYear(scenario, year),
    });
  }

  let lo = 0;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (survivesWith(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Year offset of the first retirement under an age assignment (the nest-egg boundary). */
function firstRetirementYear(
  scenario: RetirementScenario,
  ages: ReadonlyMap<string, number>,
): number {
  let first = Infinity;
  for (const p of scenario.persons) {
    const retireAge = ages.get(p.id) ?? p.plannedRetirementAge;
    first = Math.min(first, Math.max(0, retireAge - p.currentAge));
  }
  return first === Infinity ? 0 : first;
}

/**
 * Target mode (§7.1): the user pins a desired retirement age and the tool reports
 * how close the plan is and — when the pin is unreachable — the honest nearest
 * feasible age. This is retirement as a fixed-date horizon goal: same §7 check, run
 * the other direction, no new survival logic.
 */
export function assessRetirementTarget(
  scenario: RetirementScenario,
  targetAge: number,
  search: RetirementSearch = { mode: "group" },
): RetirementTargetAssessment {
  const ages = agesForSearch(scenario, search, targetAge);
  const feasible = portfolioSurvives(scenario, ages).survives;

  const boundary = firstRetirementYear(scenario, ages);
  const available =
    simulateForward(scenario, ages, scenario.startingPortfolioCents, 0).enteringByYear.get(
      boundary,
    ) ?? scenario.startingPortfolioCents;
  const required = requiredNestEggCents(scenario, ages, boundary);
  const onTrackFraction = required <= 0 ? 1 : Math.max(0, available / required);

  const nearestFeasibleAge = feasible ? targetAge : findRetirementAge(scenario, search).earliestFeasibleAge;

  return { targetAge, feasible, onTrackFraction, nearestFeasibleAge };
}
