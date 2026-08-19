/**
 * The withholding arithmetic on its own — annualize, price, prorate, and charge the difference.
 * The end-to-end behaviour it produces is pinned in {@link import("./taxWithholding.test")}; this
 * file pins the three properties that make it safe to run monthly: it is exact for a level
 * earner, it never goes backwards, and it sees nothing but the categories a payer withholds on.
 */
import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import {
  cumulativeWithholdingByCategoryCents,
  monthlyWithholdingByCategoryCents,
  monthsElapsedInTaxYear,
  totalOfCategories,
  withheldCategoriesOnly,
} from "./withholding";

const ctx: JurisdictionContext = { year: 2026 };

/** 30% above a $30,000 exemption — progressive enough that annualizing is a real approximation. */
const progressive: Jurisdiction = {
  id: "progressive",
  computeTaxCents: (byCat) =>
    Math.round(Math.max(0, (byCat.wages ?? 0) - dollarsToCents(30_000)) * 0.3),
  computeTaxByCategoryCents: (byCat) => {
    const tax = Math.round(Math.max(0, (byCat.wages ?? 0) - dollarsToCents(30_000)) * 0.3);
    return tax > 0 ? { wages: tax } : {};
  },
  isWithheldCategory: (category) => category === "wages",
};

describe("monthsElapsedInTaxYear", () => {
  it("counts the months the tax year has completed, restarting each January", () => {
    expect(monthsElapsedInTaxYear(0)).toBe(1);
    expect(monthsElapsedInTaxYear(11)).toBe(12);
    expect(monthsElapsedInTaxYear(12)).toBe(1);
    expect(monthsElapsedInTaxYear(15)).toBe(4);
  });
});

describe("withheldCategoriesOnly", () => {
  it("keeps only what a payer withholds against, dropping gains and pre-tax draws", () => {
    const base = withheldCategoriesOnly(progressive, {
      wages: dollarsToCents(5_000),
      capitalGains: dollarsToCents(9_000),
      ordinaryIncome: dollarsToCents(50_000),
    });
    expect(base).toEqual({ wages: dollarsToCents(5_000) });
  });

  it("withholds on nothing when the jurisdiction declines the seam entirely", () => {
    const noWithholding: Jurisdiction = { ...progressive, isWithheldCategory: undefined };
    expect(withheldCategoriesOnly(noWithholding, { wages: dollarsToCents(5_000) })).toEqual({});
  });
});

describe("cumulativeWithholdingByCategoryCents", () => {
  it("is exact and even for a level earner — a twelfth of the year's tax at every month", () => {
    // $5,000/mo annualizes to the same $60,000 in every month, so the cumulative figure is a
    // straight line: `annualTax($60k) = $9,000`, times the elapsed fraction of the year.
    for (let month = 0; month < 12; month++) {
      const ytd = { wages: dollarsToCents(5_000) * (month + 1) };
      const cumulative = cumulativeWithholdingByCategoryCents(progressive, ctx, ytd, month);
      expect(totalOfCategories(cumulative), `month ${month}`).toBe(
        Math.round((dollarsToCents(9_000) * (month + 1)) / 12),
      );
    }
  });

  it("takes a mid-year raise from the month it happens, never before it", () => {
    // Six months at $5,000, then a raise to $10,000. July's run rate is (30k + 10k) × 12/7,
    // higher than June's — and June's own figure is untouched by a raise it never saw.
    const june = cumulativeWithholdingByCategoryCents(
      progressive,
      ctx,
      { wages: dollarsToCents(30_000) },
      5,
    );
    const july = cumulativeWithholdingByCategoryCents(
      progressive,
      ctx,
      { wages: dollarsToCents(40_000) },
      6,
    );
    expect(totalOfCategories(june)).toBe(dollarsToCents(4_500));
    expect(totalOfCategories(july)).toBeGreaterThan(dollarsToCents(5_250));
  });

  it("charges nothing before anything has been earned", () => {
    expect(cumulativeWithholdingByCategoryCents(progressive, ctx, {}, 4)).toEqual({});
  });
});

describe("monthlyWithholdingByCategoryCents", () => {
  it("charges the difference against what the year has already withheld", () => {
    const increment = monthlyWithholdingByCategoryCents(
      progressive,
      ctx,
      { wages: dollarsToCents(30_000) },
      { wages: dollarsToCents(3_750) },
      5,
    );
    // $4,500 due through June, $3,750 already collected — June charges the $750 gap.
    expect(increment).toEqual({ wages: dollarsToCents(750) });
  });

  it("stops rather than refunding when the run rate falls mid-year", () => {
    // Earnings stopped after June: the annualized figure drops every month afterward, so the
    // cumulative due falls below what is already collected. Withholding goes to zero and stays
    // there — never negative, so no month can undo an earlier month's charge.
    const increment = monthlyWithholdingByCategoryCents(
      progressive,
      ctx,
      { wages: dollarsToCents(30_000) },
      { wages: dollarsToCents(4_500) },
      11,
    );
    expect(totalOfCategories(increment)).toBe(0);
  });
});
