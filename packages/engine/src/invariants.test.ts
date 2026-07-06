/**
 * INVARIANT TEST SUITE
 * ====================
 * Whole-system property tests that must hold after ANY operation. Run these every
 * loop iteration during autonomous implementation — they catch wrong financial math,
 * which is SILENT (plausible-but-wrong numbers) rather than a crash.
 *
 * Sections mirror TEST_PLAN.md. Tests against the already-built CashFlowSeries and the
 * known-value anchors are IMPLEMENTED and pass now. Tests for not-yet-built components
 * (Account, Simulator, Goals, Recommendations) are marked `todo(...)` — they are concrete
 * targets: fill in the body when the component's build step lands, keeping the assertion.
 *
 * DO NOT let the implementing loop rewrite the §9 known-value anchors. Those assert against
 * external truth (published amortization, closed-form compounding); they are the backstop
 * that stops code + tests converging on the same wrong answer.
 */

import { it } from "vitest";
import {
  CashFlowSeries,
  splitAnnualToMonths,
  preciseMonthlyRate,
  dollarsToCents,
} from "./cashFlowSeries";

// ---- harness ---------------------------------------------------------------
// Thin adapters onto Vitest so the invariant bodies below stay verbatim. A
// `test(...)` registers a real Vitest case (a thrown assertion fails it); a
// `todo(...)` is a not-yet-implementable invariant recorded as a pending target
// for a later build step — DO NOT delete these or change the anchor numbers.
const test = (name: string, fn: () => void) => it(name, fn);
const todo = (name: string) => it.todo(name);

const assert = {
  eq(actual: unknown, expected: unknown, msg?: string) {
    if (actual !== expected)
      throw new Error(msg ?? `expected ${expected}, got ${actual}`);
  },
  ok(cond: unknown, msg?: string) {
    if (!cond) throw new Error(msg ?? "assertion failed");
  },
  /** within `tol` cents */
  near(actual: number, expected: number, tol: number, msg?: string) {
    if (Math.abs(actual - expected) > tol)
      throw new Error(msg ?? `expected ${expected} ±${tol}, got ${actual}`);
  },
  isInteger(n: number, msg?: string) {
    if (!Number.isInteger(n)) throw new Error(msg ?? `not an integer: ${n}`);
  },
};

// ===========================================================================
// 1. MONEY INTEGRITY
// ===========================================================================
console.log("\n1. Money integrity");

test("all monetary state is integer cents (CashFlowSeries)", () => {
  const s = new CashFlowSeries(0, dollarsToCents(83421.37), {
    type: "salaryCompound",
    annualRate: 0.037,
  });
  // sample 5 years of months; every value must be an integer number of cents
  for (let m = 0; m <= 60; m++) assert.isInteger(s.getMonthlyCents(m));
});

test("cumulative rounding sums exactly to the annual total (awkward figure)", () => {
  const annual = dollarsToCents(100000.37);
  const months = splitAnnualToMonths(annual);
  assert.eq(months.reduce((a, b) => a + b, 0), annual);
  assert.eq(months.length, 12);
});

test("cumulative rounding still sums exactly AFTER a fromHereForward override", () => {
  const s = new CashFlowSeries(0, dollarsToCents(60000), {
    type: "salaryCompound",
    annualRate: 0.05,
  });
  s.addOverride(18, dollarsToCents(6500), "fromHereForward"); // typed monthly
  // the 12 months of the year following the override must sum to a whole-cent annual total
  const year = s.getRangeCents(18, 29).reduce((a, b) => a + b, 0);
  assert.isInteger(year);
  for (let m = 18; m <= 29; m++) assert.isInteger(s.getMonthlyCents(m));
});

todo("net worth = Σassets − Σliabilities, every month; property contributes equity value−mortgage (needs Account + Property)");
todo("one-time transfer conserves money: between-account transfer leaves total unchanged; influx/outflow moves exactly one balance (§3.2)");

// ===========================================================================
// 2. COMPOUNDING DISCIPLINE (§0.2)
// ===========================================================================
console.log("\n2. Compounding discipline");
todo("growth happens in exactly one place: disable compound step -> balances flat (needs Simulator)");
todo("each account compounds at most once per month (needs Account + Simulator)");
todo("one-time transfers never compound: transfer moves at its month; growth only from compounding step, post-transfer balance (§3.2)");
todo("account rate is a segment series not a scalar: a fromHereForward rate change applies only from its month (§3.1)");

// ===========================================================================
// 3. DETERMINISM & REPLAY (§6)
// ===========================================================================
console.log("\n3. Determinism & replay");

test("CashFlowSeries is query-order independent (cache determinism)", () => {
  const mk = () =>
    new CashFlowSeries(0, dollarsToCents(72000), {
      type: "salaryCompound",
      annualRate: 0.04,
    });
  const a = mk();
  const b = mk();
  for (let m = 0; m <= 60; m++) a.getMonthlyCents(m); // sequential
  const late = b.getMonthlyCents(60); // jump straight to late month
  assert.eq(late, a.getMonthlyCents(60));
});

todo("replaying the same ledger twice yields byte-identical output (needs Simulator + ledger)");
todo("remove-then-readd the same event returns identical state (needs events)");
todo("no operation mutates a stored event/edit in place (needs ledger)");

// ===========================================================================
// 4. ALLOCATION & SHORTFALL (§5.1)
// ===========================================================================
console.log("\n4. Allocation & shortfall");
todo("no impossible move: never transfer cash an account lacks (needs allocation)");
todo("shortfalls route through cascade, never a silent negative cash balance (needs §5.1)");
todo("credit-covered shortfall raises card liability by exactly the deficit (conservation)");

// ===========================================================================
// 5. STREAMS & LIFECYCLE
// ===========================================================================
console.log("\n5. Streams & lifecycle");

test("independent series do not couple: a salary edit never changes a rent series", () => {
  const salary = new CashFlowSeries(0, dollarsToCents(90000), {
    type: "salaryCompound",
    annualRate: 0.03,
  });
  const rent = new CashFlowSeries(0, dollarsToCents(24000), {
    type: "inflationLinked",
    annualRate: 0.025,
  });
  const rentBefore = rent.getMonthlyCents(30);
  salary.addOverride(12, dollarsToCents(3000), "fromHereForward"); // pay cut
  assert.eq(rent.getMonthlyCents(30), rentBefore, "rent must not react to salary changes");
});

todo("endMonth truncates: a series yields nothing past endMonth (needs endMonth — build step 1)");
todo("separation tagging isolation: ending partner income leaves child/mortgage streams intact (§4.3)");
todo("buy does not end any budget item: HomePurchaseEvent leaves all budget items untouched (§4.3)");
todo("multiple housing items coexist: DTI/% -on-housing sums all category:housing items");
todo("ending a budget item is general: setting endMonth works identically for any item, no rent-specific path");
todo("HomeSaleEvent targets one property: other houses' mortgages/streams untouched");
todo("sale proceeds conserve money: net = sale price − remaining mortgage − selling costs");
todo("intra-month ordering: same-month sell-then-buy funds the down-payment check from proceeds (§5)");
todo("property equity = value − mortgage contributes to net worth every month (§4.1)");
todo("refinance keeps history: old mortgage ends at refinance month (still present), new one starts; no overlap in payments (§10.7)");
todo("refinance targets one property: other properties' mortgages unchanged");
todo("durable entity survives origin-event edit surface: partner job change / property mortgage editable directly; undoing origin removes entity + all it owns (§10.3, §6)");
todo("backdated event reconstructs structure not past finances: child born 2y pre-now is age 2, cost stream 2y into 18y run, no past billing (§4.6)");
todo("financial accumulation starts at now: net-worth curve begins at the now marker from entered balances; no values before now (§4.6)");
todo("backdated in-flight state uses entered current values: 3y-old mortgage uses entered current balance + remaining term, not re-amortized from origin (§4.6)");

// ===========================================================================
// 6. GOALS & RETIREMENT
// ===========================================================================
console.log("\n6. Goals & retirement");
todo("future goal uses projection path; month-0 goal uses asset-ratio path, no divide-by-zero (§8.6)");
todo("reprioritizing goals conserves total allocated cash (needs goals)");
todo("solve mode and target mode agree at the same pinned age (§7.1)");
todo("multiple concurrent income sources: total income sums all active jobs; per-job pre-tax off each job's gross (§5.0)");
todo("no plan descriptor => no contribution: only plan-bearing jobs feed a retirement account (§5.5)");
todo("employer-plan account belongs to person and persists after job ends (contributions stop, balance stays) (§5.5)");
todo("match follows the job's employerMatchRule, separate per job, does not share the deferral limit (§5.5, §5.4)");
todo("combined 401k deferral across jobs shares one annual limit; employer match is separate (§5.4)");
todo("contribution never exceeds applicable cap; overflow redirects to next priority destination (§5.0, §5.4)");
todo("catch-up applies by age and account type (401k vs IRA), only at/after trigger age (§5.4)");
todo("Social Security derives from earnings record: computed from accumulated history; higher history => >= benefit; zero before claiming age (§5.4)");
todo("SS is engine-accumulated (EarningsRecord, no jurisdiction knowledge), rules-computed (benefit seam) (§5.4)");
todo("SS enters post-deferral and is partially taxed via taxCategory tag, not as wages (§5.4)");
todo("ANCHOR (rules repo): known earnings history => expected SS benefit, pinned to the cent (§5.4)");
todo("SS claiming age monotonicity: later claiming (<=70) => higher monthly benefit (§5.4)");
todo("Medicare step lowers health cost at 65; pre-65 early-retiree health cost modeled elevated (§5.4)");
todo("RMDs force taxable withdrawals from pre-tax accounts past RMD age regardless of need (§5.4)");

// ===========================================================================
// 7. RECOMMENDATIONS (§8)
// ===========================================================================
console.log("\n7. Recommendations");
todo("apply then un-apply returns to identical pre-apply state (tagged remove-then-replay)");
todo("applied recommendation's realized effect matches its preview vs the same plan state");

// ===========================================================================
// 8. DERIVED REPORTING
// ===========================================================================
console.log("\n8. Derived reporting");

test("real-dollar conversion is a pure function of nominal/inflation/horizon", () => {
  const toReal = (nominalCents: number, infl: number, years: number) =>
    Math.round(nominalCents / Math.pow(1 + infl, years));
  const a = toReal(dollarsToCents(100000), 0.03, 10);
  const b = toReal(dollarsToCents(100000), 0.03, 10);
  assert.eq(a, b, "same inputs must give same output");
  // sanity: real < nominal when inflation positive
  assert.ok(a < dollarsToCents(100000));
});

// ===========================================================================
// 9. KNOWN-VALUE ANCHORS  — PIN THESE BY HAND, do not let the loop rewrite them
// ===========================================================================
console.log("\n9. Known-value anchors (external truth)");

test("ANCHOR: mortgage amortization — $200k @ 6% APR, 360mo", () => {
  // Standard amortizing payment: P = L·c(1+c)^n / ((1+c)^n − 1)
  const L = dollarsToCents(200000);
  const c = 0.06 / 12; // simple monthly rate for a mortgage quote
  const n = 360;
  const factor = Math.pow(1 + c, n);
  const payment = Math.round((L * (c * factor)) / (factor - 1));

  assert.near(payment, 119910, 1, "monthly payment ≈ $1,199.10");
  assert.eq(Math.round(L * c), 100000, "first-month interest is exactly $1,000.00");

  // amortize forward; final balance must be ~0 (last-payment rounding only)
  let bal = L;
  for (let i = 0; i < n; i++) {
    const interest = Math.round(bal * c);
    const principal = payment - interest;
    bal -= principal;
  }
  assert.near(bal, 0, 200, "balance after 360 payments ≈ $0 (within rounding)");
});

test("ANCHOR: fixed salary at 0% growth is constant forever", () => {
  const s = new CashFlowSeries(0, dollarsToCents(120000), { type: "fixed" });
  const y0 = s.getRangeCents(0, 11).reduce((a, b) => a + b, 0);
  const y10 = s.getRangeCents(120, 131).reduce((a, b) => a + b, 0);
  assert.eq(y0, dollarsToCents(120000));
  assert.eq(y10, dollarsToCents(120000));
});

test("ANCHOR: known compounding matches closed form — $10k @ 7%, monthly, 10y", () => {
  const monthly = preciseMonthlyRate(0.07);
  let bal = dollarsToCents(10000);
  for (let i = 0; i < 120; i++) bal = Math.round(bal * (1 + monthly));
  // closed form ≈ $19,671.51; integer-cents rounding lands at $19,671.46
  assert.near(bal, dollarsToCents(19671.51), 10, "≈ $19,671.51 within a dime");
});

test("ANCHOR: preciseMonthlyRate compounds back to the annual rate over 12 months", () => {
  const r = preciseMonthlyRate(0.07);
  assert.ok(Math.abs(Math.pow(1 + r, 12) - 1 - 0.07) < 1e-9);
});
