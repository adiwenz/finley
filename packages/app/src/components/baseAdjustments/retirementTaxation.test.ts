/**
 * Integration demo (issue #110 follow-up): Social Security IS taxed — and the SS band's
 * take-home reflects it — once there's enough *other* taxable income in retirement to push
 * the benefit over the standard deduction. In the default plan SS sits below that threshold
 * (retirement is funded by non-taxable savings drawdowns), so SS take-home == gross and the
 * "Pre-tax (gross)" toggle leaves the SS band still; this scenario is the counter-example
 * that proves the pipeline handles a taxed benefit end-to-end.
 */
import { it, expect } from "vitest";
import { Projection, RETIREMENT_ID, dollarsToCents, type Plan } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { START_YEAR } from "../../config";

// A solvent retiree whose retirement is funded by pre-tax 401(k) withdrawals (taxable
// ordinary income) on top of Social Security: a higher salary plus a 15% deferral build the
// pre-tax balance, everything else is the default plan.
const DEMO_PLAN: Plan = {
  ...PLAN_DEFAULTS,
  jobs: [
    {
      ...PLAN_DEFAULTS.jobs[0]!,
      salary: { startingSalaryCents: dollarsToCents(12_000) * 12, realGrowthPct: 0 },
      deferral: { deferralFraction: 0.15, fundAccountId: RETIREMENT_ID },
    },
  ],
};

it("taxes Social Security when 401(k) withdrawals accompany it, keyed to the benefit source", () => {
  const series = Projection.create({ plan: DEMO_PLAN, startYear: START_YEAR }).run(usJurisdiction).series;

  const taxedSSMonths = series.months.filter((m) => {
    const byCat = (m.flows?.taxByCategoryCents ?? {}) as Record<string, number>;
    return (byCat.governmentRetirementBenefit ?? 0) > 0;
  });
  // The counter-example fires: SS is taxed in a run of retirement months (not the zero of
  // the default plan).
  expect(taxedSSMonths.length).toBeGreaterThan(0);

  const m = taxedSSMonths[0]!;
  const byCat = m.flows!.taxByCategoryCents as Record<string, number>;
  const bySrc = m.flows!.taxBySourceCents as Record<string, number>;
  const benefit = m.flows!.incomeSources!.find((s) => s.category === "governmentRetirementBenefit")!;

  // The SS category tax is attributed to the benefit SOURCE key (not lost), so the income
  // chart's SS band take-home = gross − that tax. The keys line up (`benefit:<person>`).
  expect(bySrc[benefit.sourceId]).toBe(byCat.governmentRetirementBenefit);
  expect(bySrc[benefit.sourceId]).toBeGreaterThan(0);
  expect(benefit.grossCents - bySrc[benefit.sourceId]!).toBeLessThan(benefit.grossCents); // take-home < gross
});
