import {
  CashFlowSeries,
  splitAnnualToMonths,
  preciseMonthlyRate,
  dollarsToCents,
} from "./cashFlowSeries";

const assert = {
  strictEqual(actual: unknown, expected: unknown, msg?: string) {
    if (actual !== expected) {
      throw new Error(msg ?? `Expected ${expected}, got ${actual}`);
    }
  },
  ok(cond: unknown, msg?: string) {
    if (!cond) throw new Error(msg ?? "Assertion failed");
  },
};

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (e) {
    console.log(`FAIL  - ${name}`);
    throw e;
  }
}

console.log("CashFlowSeries tests\n");

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
  // No single month should be wildly different from the naive even split.
  for (const m of months) {
    assert.ok(Math.abs(m - naive) <= 1, `month value ${m} too far from naive ${naive}`);
  }
});

test("fixed growth mode: same annual value every year, forever", () => {
  const s = new CashFlowSeries(0, dollarsToCents(1200), { type: "fixed" });
  const year0 = s.getRangeCents(0, 11).reduce((a, b) => a + b, 0);
  const year5 = s.getRangeCents(60, 71).reduce((a, b) => a + b, 0);
  assert.strictEqual(year0, dollarsToCents(1200));
  assert.strictEqual(year5, dollarsToCents(1200));
});

test("salary compound growth: iterative from actual prior-year cents, matches manual iteration", () => {
  const annualStart = dollarsToCents(80000);
  const rate = 0.04;
  const s = new CashFlowSeries(0, annualStart, { type: "salaryCompound", annualRate: rate });

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
  const sA = new CashFlowSeries(0, annualStart, { type: "salaryCompound", annualRate: rate });
  const sB = new CashFlowSeries(0, annualStart, { type: "salaryCompound", annualRate: rate });

  // sA: query in order
  for (let m = 0; m <= 71; m++) sA.getMonthlyCents(m);
  // sB: jump straight to a late month
  const lateValue = sB.getMonthlyCents(70);
  const lateValueFromOrdered = sA.getMonthlyCents(70);
  assert.strictEqual(lateValue, lateValueFromOrdered);
});

test("fromHereForward override: prior months untouched, future months rebase", () => {
  const s = new CashFlowSeries(0, dollarsToCents(1200), { type: "fixed" }); // $100/mo
  const before = s.getMonthlyCents(5);
  assert.strictEqual(before, dollarsToCents(100));

  // At month 10, user edits the value to $150/mo, going forward.
  s.addOverride(10, dollarsToCents(150), "fromHereForward");

  // Months before the override are untouched.
  assert.strictEqual(s.getMonthlyCents(5), dollarsToCents(100));
  assert.strictEqual(s.getMonthlyCents(9), dollarsToCents(100));
  // From the override month forward, it's rebased.
  assert.strictEqual(s.getMonthlyCents(10), dollarsToCents(150));
  assert.strictEqual(s.getMonthlyCents(11), dollarsToCents(150));
});

test("thisMonthOnly override: affects exactly one month, neighbors unaffected", () => {
  const s = new CashFlowSeries(0, dollarsToCents(1200), { type: "fixed" }); // $100/mo
  s.addOverride(6, dollarsToCents(500), "thisMonthOnly"); // e.g. one-off bonus expense

  assert.strictEqual(s.getMonthlyCents(5), dollarsToCents(100));
  assert.strictEqual(s.getMonthlyCents(6), dollarsToCents(500));
  assert.strictEqual(s.getMonthlyCents(7), dollarsToCents(100));
});

test("budget item growth is independent of a separate salary series (no auto-shrink on pay cut)", () => {
  const salary = new CashFlowSeries(0, dollarsToCents(80000), {
    type: "salaryCompound",
    annualRate: 0.03,
  });
  const rent = new CashFlowSeries(0, dollarsToCents(18000), {
    type: "inflationLinked",
    annualRate: 0.025,
  });

  const rentBefore = rent.getMonthlyCents(24);
  // Simulate a pay cut on the salary series — rent series is never touched or referenced.
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

console.log("\nAll tests passed.");
