/**
 * The payment SCHEDULE against a real progressive schedule, end to end through the public
 * `Projection` surface. The engine's own tax tests run on flat-rate fixtures, where a year's tax
 * is linear in income and so a twelve-way split reconciles by arithmetic; only a bracketed
 * jurisdiction can show that the instalments and the year's closing balance are pricing through
 * one annual seam rather than two schedules that happen to agree.
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

  it("paces twelve equal instalments and settles the unpredictable income the following April", () => {
    const result = run();
    const taxes = result.series.months.slice(0, 16).map((m) => m.flows?.taxCents ?? 0);
    // Wages are known at the year's start, so all TWELVE months are one figure (±1¢ of cumulative
    // rounding) — no drift as income accrues, which is what YTD annualization did, and no December
    // true-up either. April carries the previous year's balance, and 2026 has no previous year.
    for (const tax of taxes.slice(0, 12)) expect(Math.abs(tax - taxes[0]!)).toBeLessThanOrEqual(1);
    // The interest was unknowable, so 2026 leaves a balance — settled in April 2027, on top of
    // that year's own instalment. Larger than an ordinary month, but by the tax on a year of
    // interest, not by a year's tax.
    expect(taxes[15]!).toBeGreaterThan(taxes[14]!);
    expect(taxes[15]!).toBeLessThan(2 * taxes[14]!);
  });
});
