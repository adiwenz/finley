/**
 * The payment SCHEDULE against a real progressive schedule, end to end through the public
 * `Projection` surface. The engine's own tax tests run on flat-rate fixtures, where a year's tax
 * is linear in income and so a twelve-way split reconciles by arithmetic; only a bracketed
 * jurisdiction can show that the instalments and the year-end reconciliation are pricing through
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
 * it and December has something real to reconcile.
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

describe("federal income tax — instalments and reconciliation under US-2026", () => {
  it("charges, over the year, exactly the annual liability on the year's actual taxable income", () => {
    const result = run();
    for (const year of [0, 1, 2]) {
      const months = result.series.months.slice(year * 12, year * 12 + 12);
      const charged = months.reduce((s, m) => s + (m.flows?.taxCents ?? 0), 0);
      // The invariant, to the cent: the twelve instalments plus December's true-up ARE the
      // jurisdiction's annual tax on the year's income. Nothing is lost to the twelve-way split,
      // and the progressive brackets are applied once, to the whole year.
      expect(charged).toBe(
        usJurisdiction.computeTaxCents(actualAnnualBase(result, year), { year: START_YEAR + year }),
      );
    }
  });

  it("paces eleven equal instalments and settles the unpredictable income in December", () => {
    const months = run().series.months.slice(0, 12);
    const taxes = months.map((m) => m.flows?.taxCents ?? 0);
    // Wages are known at the year's start, so the first eleven months are one figure (±1¢ of
    // cumulative rounding) — no drift as income accrues, which is what YTD annualization did.
    for (const tax of taxes.slice(0, 11)) expect(Math.abs(tax - taxes[0]!)).toBeLessThanOrEqual(1);
    // The interest was unknowable, so December is larger — but by the tax on a year's interest,
    // not by a year's tax.
    expect(taxes[11]!).toBeGreaterThan(taxes[0]!);
    expect(taxes[11]!).toBeLessThan(2 * taxes[0]!);
  });
});
