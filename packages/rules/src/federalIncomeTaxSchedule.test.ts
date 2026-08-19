/**
 * The payment SCHEDULE against a real progressive schedule, end to end through the public
 * `Projection` surface. The engine's own tax tests run on flat-rate fixtures, where a year's tax
 * is linear in income; only a bracketed jurisdiction can show that monthly withholding plus the
 * following April's balance price through the one annual seam rather than through a schedule that
 * happens to agree by arithmetic.
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
 * a flat real salary keep the year's wages exact; the interest is the point — it accrues on
 * balances the funding waterfall builds month by month, so the year-start estimate cannot know
 * it and each year has a real balance left to settle the following April.
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

describe("federal income tax — instalments and the following April's balance, under US-2026", () => {
  /**
   * A tax year's balance, as charged: April's tax less the ordinary instalment its neighbours pay.
   * April is the one month carrying tax from two years at once — its own year's twelfth and the
   * previous year's whole remainder — so March is the reference for what the twelfth alone is.
   * Good to the cent: two instalments of one estimate differ only by the cumulative rounding that
   * makes twelve of them sum exactly, which is the whole tolerance the caller allows.
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
      const instalments =
        months.reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0) -
        balanceSettledIn(result, year * 12 + 3);
      // THE INVARIANT, to the cent: the twelve instalments plus the balance settled the FOLLOWING
      // April are the jurisdiction's annual tax on the year's income. Nothing is lost to the
      // twelve-way split, and the progressive brackets are applied once, to the whole year.
      const charged = instalments + balanceSettledIn(result, (year + 1) * 12 + 3);
      const liability = usJurisdiction.computeTaxCents(actualAnnualBase(result, year), {
        year: START_YEAR + year,
      });
      // Exact but for the cent `balanceSettledIn` reads off a neighbouring instalment rather than
      // the same one; the engine's own suite pins this identity to the cent on fixtures where the
      // estimate is recoverable outright.
      expect(Math.abs(charged - liability), `year ${year}`).toBeLessThanOrEqual(1);
    }
  });

  it("withholds smoothly on wages every month, settling only the unwithheld remainder in April", () => {
    const result = run();
    const taxes = result.series.months.slice(0, 16).map((m) => m.flows?.taxCents ?? 0);

    // A level salary withholds a level amount: the annualized run rate is the same $96k every
    // month, so each month charges a twelfth of the tax on it. Cent-level rounding aside, no
    // month is distinguishable from its neighbours — the balance never builds up on money that
    // was never the household's.
    const inYear = taxes.slice(0, 12);
    for (const tax of inYear) expect(tax).toBeGreaterThan(0);
    expect(Math.max(...inYear) - Math.min(...inYear)).toBeLessThanOrEqual(1);

    // April 2027 (month 15) carries its own twelfth PLUS 2026's balance. That balance is the tax
    // on the year's interest alone — nobody withholds against a savings account — so it is real
    // but small next to the withholding beside it, not a year's liability landing at once.
    const balance = taxes[15]! - taxes[14]!;
    expect(balance).toBeGreaterThan(0);
    expect(balance).toBeLessThan(taxes[14]!);
  });
});
