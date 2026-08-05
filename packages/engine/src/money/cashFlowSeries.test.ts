import { it as test, assert } from "vitest";
import {
  SimCashFlowSeries,
  splitAnnualToMonths,
  preciseMonthlyRate,
  dollarsToCents,
} from "./cashFlowSeries";

// Original tests, preserved verbatim as behavioral anchors.

test("cumulative rounding: 12 months sum exactly to an awkward annual total", () => {
  const annual = dollarsToCents(100000.37); // not evenly divisible by 12
  const months = splitAnnualToMonths(annual);
  const sum = months.reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, annual);
  assert.strictEqual(months.length, 12);
});

test("cumulative rounding spreads error, doesn't dump it all in one month", () => {
  const annual = dollarsToCents(50000.01);
  const months = splitAnnualToMonths(annual);
  const naive = Math.round((annual / 12) * 100) / 100;
  for (const m of months) {
    assert.ok(Math.abs(m - naive) <= 1, `month value ${m} too far from naive ${naive}`);
  }
});

test("fixed growth mode: same annual value every year, forever", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(1200), { type: "fixed" });
  const year0 = s.getRangeCents(0, 11).reduce((a, b) => a + b, 0);
  const year5 = s.getRangeCents(60, 71).reduce((a, b) => a + b, 0);
  assert.strictEqual(year0, dollarsToCents(1200));
  assert.strictEqual(year5, dollarsToCents(1200));
});

test("salary compound growth: iterative from actual prior-year cents, matches manual iteration", () => {
  const annualStart = dollarsToCents(80000);
  const rate = 0.04;
  const s = new SimCashFlowSeries(0, annualStart, { type: "salaryCompound", annualRate: rate });

  let expected = annualStart;
  for (let y = 1; y <= 5; y++) {
    expected = Math.round(expected * (1 + rate));
  }
  const year5Total = s.getRangeCents(60, 71).reduce((a, b) => a + b, 0);
  assert.strictEqual(year5Total, expected);
});

test("querying a later month first still gives the same result as sequential queries (cache order-independence)", () => {
  const annualStart = dollarsToCents(80000);
  const rate = 0.04;
  const sA = new SimCashFlowSeries(0, annualStart, { type: "salaryCompound", annualRate: rate });
  const sB = new SimCashFlowSeries(0, annualStart, { type: "salaryCompound", annualRate: rate });

  for (let m = 0; m <= 71; m++) sA.getMonthlyCents(m);
  const lateValue = sB.getMonthlyCents(70);
  const lateValueFromOrdered = sA.getMonthlyCents(70);
  assert.strictEqual(lateValue, lateValueFromOrdered);
});

test("fromHereForward override: prior months untouched, future months rebase", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(1200), { type: "fixed" }); // $100/mo
  const before = s.getMonthlyCents(5);
  assert.strictEqual(before, dollarsToCents(100));

  s.addOverride(10, dollarsToCents(150), "fromHereForward");

  assert.strictEqual(s.getMonthlyCents(5), dollarsToCents(100));
  assert.strictEqual(s.getMonthlyCents(9), dollarsToCents(100));
  assert.strictEqual(s.getMonthlyCents(10), dollarsToCents(150));
  assert.strictEqual(s.getMonthlyCents(11), dollarsToCents(150));
});

test("thisMonthOnly override: affects exactly one month, neighbors unaffected", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(1200), { type: "fixed" }); // $100/mo
  s.addOverride(6, dollarsToCents(500), "thisMonthOnly");

  assert.strictEqual(s.getMonthlyCents(5), dollarsToCents(100));
  assert.strictEqual(s.getMonthlyCents(6), dollarsToCents(500));
  assert.strictEqual(s.getMonthlyCents(7), dollarsToCents(100));
});

test("budget item growth is independent of a separate salary series (no auto-shrink on pay cut)", () => {
  const salary = new SimCashFlowSeries(0, dollarsToCents(80000), {
    type: "salaryCompound",
    annualRate: 0.03,
  });
  const rent = new SimCashFlowSeries(0, dollarsToCents(18000), {
    type: "inflationLinked",
    annualRate: 0.025,
  });

  const rentBefore = rent.getMonthlyCents(24);
  // A pay cut on the salary series; the rent series is never touched or referenced.
  salary.addOverride(12, dollarsToCents(4000), "fromHereForward");
  const rentAfter = rent.getMonthlyCents(24);

  assert.strictEqual(rentBefore, rentAfter);
});

test("preciseMonthlyRate compounds to the annual rate over 12 months", () => {
  const annualRate = 0.07;
  const monthlyRate = preciseMonthlyRate(annualRate);
  const compounded = Math.pow(1 + monthlyRate, 12) - 1;
  assert.ok(Math.abs(compounded - annualRate) < 1e-9);
});

test("monthly-native: $150 repeats exactly — zero rounding drift over 36 months", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(150), { type: "fixed" }, {
    baselineUnit: "monthly",
  });
  for (let m = 0; m < 36; m++) {
    assert.strictEqual(
      s.getMonthlyCents(m),
      dollarsToCents(150),
      `month ${m} should be exactly $150`,
    );
  }
});

test("monthly-native growth: compounds the monthly value once per year, not per split", () => {
  const monthlyBase = dollarsToCents(150);
  const rate = 0.03;
  const s = new SimCashFlowSeries(0, monthlyBase, { type: "inflationLinked", annualRate: rate }, {
    baselineUnit: "monthly",
  });

  for (let m = 0; m < 12; m++) {
    assert.strictEqual(s.getMonthlyCents(m), monthlyBase, `year0 month ${m}`);
  }
  const year1 = Math.round(monthlyBase * (1 + rate));
  for (let m = 12; m < 24; m++) {
    assert.strictEqual(s.getMonthlyCents(m), year1, `year1 month ${m}`);
  }
  const year2 = Math.round(year1 * (1 + rate));
  for (let m = 24; m < 36; m++) {
    assert.strictEqual(s.getMonthlyCents(m), year2, `year2 month ${m}`);
  }
});

test("annual-native (default) still uses cumulative rounding", () => {
  const annual = dollarsToCents(100000.37);
  const s = new SimCashFlowSeries(0, annual, { type: "fixed" });
  const year0Total = s.getRangeCents(0, 11).reduce((a, b) => a + b, 0);
  assert.strictEqual(year0Total, annual);
});

test("endMonth: getMonthlyCents returns 0 after endMonth", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(100), { type: "fixed" }, {
    baselineUnit: "monthly",
    endMonth: 5,
  });
  assert.strictEqual(s.getMonthlyCents(4), dollarsToCents(100));
  assert.strictEqual(s.getMonthlyCents(5), dollarsToCents(100)); // endMonth is inclusive
  assert.strictEqual(s.getMonthlyCents(6), 0);
  assert.strictEqual(s.getMonthlyCents(100), 0);
});

test("growthAnchor=calendar: growth fires at simulation year boundaries (month 12, 24, ...)", () => {
  // Series starts at month 3; with the calendar anchor, growth still fires at month 12.
  const rate = 0.05;
  const s = new SimCashFlowSeries(3, dollarsToCents(1000), { type: "customRate", annualRate: rate }, {
    baselineUnit: "monthly",
    growthAnchor: "calendar",
  });

  assert.strictEqual(s.getMonthlyCents(3), dollarsToCents(1000));
  assert.strictEqual(s.getMonthlyCents(11), dollarsToCents(1000));
  const year1 = Math.round(dollarsToCents(1000) * (1 + rate));
  assert.strictEqual(s.getMonthlyCents(12), year1);
  assert.strictEqual(s.getMonthlyCents(23), year1);
  const year2 = Math.round(year1 * (1 + rate));
  assert.strictEqual(s.getMonthlyCents(24), year2);
});

test("growthAnchor=ownCycle (default): growth fires on the series own anniversary", () => {
  // Series starts at month 3; growth fires at months 3+12=15, 27, 39...
  const rate = 0.05;
  const s = new SimCashFlowSeries(3, dollarsToCents(1000), { type: "customRate", annualRate: rate }, {
    baselineUnit: "monthly",
    growthAnchor: "ownCycle",
  });

  for (let m = 3; m < 15; m++) {
    assert.strictEqual(s.getMonthlyCents(m), dollarsToCents(1000), `month ${m}`);
  }
  const year1 = Math.round(dollarsToCents(1000) * (1 + rate));
  for (let m = 15; m < 27; m++) {
    assert.strictEqual(s.getMonthlyCents(m), year1, `month ${m}`);
  }
});

test("ownCycle with anchorMonth < startMonth: backdated series fires at next anniversary", () => {
  // A rent series that started 6 months before the sim: anchor -6, next anniversary month 6.
  const rate = 0.03;
  const s = new SimCashFlowSeries(0, dollarsToCents(150), { type: "inflationLinked", annualRate: rate }, {
    baselineUnit: "monthly",
    anchorMonth: -6,
  });

  // Year 0 spans months -6..5.
  for (let m = 0; m <= 5; m++) {
    assert.strictEqual(s.getMonthlyCents(m), dollarsToCents(150), `month ${m}`);
  }
  const year1 = Math.round(dollarsToCents(150) * (1 + rate));
  assert.strictEqual(s.getMonthlyCents(6), year1);
  assert.strictEqual(s.getMonthlyCents(17), year1);
  const year2 = Math.round(year1 * (1 + rate));
  assert.strictEqual(s.getMonthlyCents(18), year2);
});

test("resetAnchor=true on fromHereForward: growth clock restarts from override month", () => {
  // The new growth clock starts at the override month 10 → next escalation at month 22.
  const rate = 0.10;
  const s = new SimCashFlowSeries(0, dollarsToCents(100), { type: "customRate", annualRate: rate }, {
    baselineUnit: "monthly",
  });
  s.addOverride(10, dollarsToCents(200), "fromHereForward", { resetAnchor: true });

  assert.strictEqual(s.getMonthlyCents(10), dollarsToCents(200));
  assert.strictEqual(s.getMonthlyCents(21), dollarsToCents(200));
  // month 22: compounded to $220.
  const year1 = Math.round(dollarsToCents(200) * (1 + rate));
  assert.strictEqual(s.getMonthlyCents(22), year1);
});

test("resetAnchor=false (default): growth clock continues from original anchor", () => {
  // The anchor stays at 0, so growth still fires at month 12 despite the month-10 override.
  const rate = 0.10;
  const s = new SimCashFlowSeries(0, dollarsToCents(100), { type: "customRate", annualRate: rate }, {
    baselineUnit: "monthly",
  });
  s.addOverride(10, dollarsToCents(200), "fromHereForward");

  assert.strictEqual(s.getMonthlyCents(10), dollarsToCents(200));
  assert.strictEqual(s.getMonthlyCents(11), dollarsToCents(200));
  const year1 = Math.round(dollarsToCents(200) * (1 + rate));
  assert.strictEqual(s.getMonthlyCents(12), year1);
});

test("taxCategory is stored as-is (v1-ignored seam)", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(60000), { type: "salaryCompound", annualRate: 0.03 }, {
    taxCategory: "wages",
  });
  assert.strictEqual(s.taxCategory, "wages");

  const benefit = new SimCashFlowSeries(0, dollarsToCents(12000), { type: "fixed" }, {
    taxCategory: "governmentRetirementBenefit",
  });
  assert.strictEqual(benefit.taxCategory, "governmentRetirementBenefit");
});

test("correctHistory: editing a prior segment's value in-place recomputes forward", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(1200), { type: "fixed" });
  assert.strictEqual(s.getMonthlyCents(0), dollarsToCents(100));

  // The baseline was $1800/year ($150/mo), not $1200.
  s.correctHistory(0, dollarsToCents(1800));
  assert.strictEqual(s.getMonthlyCents(0), dollarsToCents(150));
  assert.strictEqual(s.getMonthlyCents(11), dollarsToCents(150));
});

test("correctHistory: does not affect a fromHereForward segment that follows", () => {
  const s = new SimCashFlowSeries(0, dollarsToCents(1200), { type: "fixed" });
  s.addOverride(12, dollarsToCents(200), "fromHereForward"); // $200/mo from month 12

  s.correctHistory(0, dollarsToCents(1800)); // $150/mo

  assert.strictEqual(s.getMonthlyCents(0), dollarsToCents(150));
  // The month-12 segment is independent of the correction.
  assert.strictEqual(s.getMonthlyCents(12), dollarsToCents(200));
});
