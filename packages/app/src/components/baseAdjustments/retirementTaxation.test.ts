/**
 * Integration demo: Social Security IS taxed — and the SS band's take-home reflects it —
 * once enough *other* taxable retirement income pushes the benefit over the standard
 * deduction. The default plan funds retirement from non-taxable savings drawdowns, so SS
 * sits below that threshold and take-home == gross; this is the counter-example proving
 * the pipeline handles a taxed benefit end-to-end.
 */
import { it, expect } from "vitest";
import { Projection, RETIREMENT_ID, dollarsToCents, type Plan } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { stateOf } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";

// A solvent retiree funded by pre-tax 401(k) withdrawals (taxable ordinary income) on top
// of Social Security: a higher salary plus a 15% deferral build the pre-tax balance.
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
  const series = Projection.fromState(stateOf(DEMO_PLAN), usJurisdiction).run(usJurisdiction).series;

  const taxedSSMonths = series.months.filter((m) => {
    const byCat = (m.flows?.taxByCategoryCents ?? {}) as Record<string, number>;
    return (byCat.governmentRetirementBenefit ?? 0) > 0;
  });
  // The counter-example fires: SS is taxed across a run of retirement months.
  expect(taxedSSMonths.length).toBeGreaterThan(0);

  const m = taxedSSMonths[0]!;
  const byCat = m.flows!.taxByCategoryCents as Record<string, number>;
  const bySrc = m.flows!.taxBySourceCents as Record<string, number>;
  const benefit = m.flows!.incomeSources!.find((s) => s.category === "governmentRetirementBenefit")!;

  // The SS category tax is attributed to the benefit SOURCE key (`benefit:<person>`), not
  // lost, so per-source net cash flow drops below the benefit's inflow by that tax.
  expect(bySrc[benefit.sourceId]).toBe(byCat.governmentRetirementBenefit);
  expect(bySrc[benefit.sourceId]).toBeGreaterThan(0);
  expect(benefit.netCashFlowCents).toBe(benefit.cashInflowCents - bySrc[benefit.sourceId]!);
  expect(benefit.netCashFlowCents).toBeLessThan(benefit.cashInflowCents); // take-home < gross
});
