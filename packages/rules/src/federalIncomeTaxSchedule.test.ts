/**
 * The payment SCHEDULE against real US-2026 rules, end to end through the public `Projection`
 * surface. The engine's own tax tests run on flat-rate fixtures where withholding and liability
 * agree by arithmetic; only real brackets and a real Publication 15-T table can show that a year's
 * withholding and its April balance come from two genuinely different computations that
 * nevertheless add up to the one annual liability.
 */
import { describe, it, expect } from "vitest";
import {
  Projection,
  CURRENT_FORMAT_VERSION,
  dollarsToCents,
  type Plan,
  type TaxCategory,
  type ProjectionResult,
} from "@finley/engine";
import { usJurisdiction } from "./index";

const START_YEAR = 2026;
const BIRTH_YEAR = START_YEAR - 40;

/**
 * $96k of salary, no deferral and no expenses, with cash savings earning 4%. Zero inflation and
 * a flat real salary keep the year's wages exact; the interest is the point — no payroll system
 * withholds against a bank's interest credit, so each year leaves a real balance for the
 * following April to settle.
 */
const plan: Plan = {
  budgetLines: [],
  openingBalanceCents: dollarsToCents(50_000),
  savingsReturnPct: 4,
  retirementReturnPct: 0,
  brokerageReturnPct: 0,
  sharedScheme: "proportional",
  goals: [],
  inflationPct: 0,
  primary: {
    id: "p1",
    name: "Single filer",
    birthYear: BIRTH_YEAR,
    lifeExpectancy: 85,
    benefitClaimingAge: 67,
    jobs: [
      {
        id: "job-main",
        ownerId: "p1",
        startYear: BIRTH_YEAR + 22,
        endYear: BIRTH_YEAR + 65,
        salary: {
          startingSalaryCents: dollarsToCents(96_000),
          currentSalaryCents: dollarsToCents(96_000),
          realGrowthPct: 0,
        },
      },
    ],
  },
};

const run = (): ProjectionResult =>
  Projection.fromState(
    {
      scenario: { plan, ledger: { events: [], nextSequenceNumber: 0 } },
      startYear: START_YEAR,
      nextSeq: 1,
      version: CURRENT_FORMAT_VERSION,
    },
    usJurisdiction,
  ).run(usJurisdiction);

/** The year's ACTUAL taxable income, per category, as the run itself reported it. */
function actualAnnualBase(
  result: ProjectionResult,
  year: number,
): Partial<Record<TaxCategory, number>> {
  const base: Partial<Record<TaxCategory, number>> = {};
  for (const month of result.series.months.slice(year * 12, year * 12 + 12)) {
    for (const [category, cents] of Object.entries(month.flows?.cashFlowIncomeByCategoryCents ?? {})) {
      base[category as TaxCategory] = (base[category as TaxCategory] ?? 0) + cents;
    }
  }
  return base;
}

describe("federal income tax — paycheck withholding and the following April's balance, under US-2026", () => {
  /**
   * A tax year's balance, as charged: April's tax less the ordinary withholding its neighbours
   * bear. April is the one month carrying tax from two years at once — its own paycheck's
   * withholding and the previous year's whole remainder — so March is the reference for what the
   * withholding alone is. Exact on a level salary, which withholds the same figure every month.
   */
  const balanceSettledIn = (result: ProjectionResult, april: number): number => {
    const at = (m: number): number => result.series.months[m]?.flows?.taxCents ?? 0;
    return at(april) - at(april - 1);
  };

  it("charges, over the year and its April, exactly the annual liability on the year's actual income", () => {
    const result = run();
    for (const year of [0, 1, 2]) {
      const months = result.series.months.slice(year * 12, year * 12 + 12);
      // The year's own charges, with any prior-year balance April settled taken back out — that
      // one belongs to the year before this one.
      const withheld =
        months.reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0) -
        balanceSettledIn(result, year * 12 + 3);
      // THE INVARIANT: the year's withholding plus the balance settled the FOLLOWING April are the
      // jurisdiction's annual tax on the year's income. Publication 15-T priced the first from
      // twelve individual paycheques and the brackets priced the second once, over the whole year,
      // and the two still add up.
      const charged = withheld + balanceSettledIn(result, (year + 1) * 12 + 3);
      const liability = usJurisdiction.computeTaxCents(actualAnnualBase(result, year), {
        year: START_YEAR + year,
      });
      // Exact but for the cent `balanceSettledIn` reads off a neighbouring month's withholding
      // rather than the same one; the engine's own suite pins this identity to the cent on
      // fixtures where the withholding is recoverable outright.
      expect(Math.abs(charged - liability), `year ${year}`).toBeLessThanOrEqual(1);
    }
  });

  it("withholds twelve identical paycheques and settles the un-withheld income the following April", () => {
    const result = run();
    const taxes = result.series.months.slice(0, 16).map((m) => m.flows?.taxCents ?? 0);
    // A level salary makes every paycheck identical, so all TWELVE months withhold exactly the
    // same figure — no drift as the year's income accrues, and no December true-up. April carries
    // the previous year's balance, and 2026 has no previous year.
    for (const tax of taxes.slice(0, 12)) expect(tax).toBe(taxes[0]);
    expect(taxes[0]).toBeGreaterThan(0);
    // The savings interest is the part no paycheck could withhold against, so April 2027 is
    // visibly heavier than March: it carries 2026's whole interest bill on top of its own
    // withholding.
    expect(taxes[15]).toBeGreaterThan(taxes[14]!);
  });

  it("withholds a salaried year to within a rounding residue of what it actually owes", () => {
    // The Publication 15-T percentage method exists to land here: an ordinary salaried filer with
    // nothing else going on should neither owe nor be owed much in April. The interest is the only
    // thing driving 2026's balance, so it bounds how far withholding alone missed.
    const result = run();
    const withheld = result.series.months
      .slice(0, 12)
      .reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0);
    const wagesLiability = usJurisdiction.computeTaxCents(
      { wages: actualAnnualBase(result, 0).wages ?? 0 },
      { year: START_YEAR },
    );
    expect(Math.abs(withheld - wagesLiability)).toBeLessThan(dollarsToCents(20));
  });
});
