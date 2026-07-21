import { describe, expect, it } from "vitest";
import { dollarsToCents } from "./cashFlowSeries";
import {
  type BudgetLine,
  type ResolveLineContext,
  fundLinesInPriorityOrder,
  orderBudgetLines,
  resolveBudget,
  resolveBudgetLineMonthlyCents,
  taxTreatmentForLine,
} from "./budgetLine";

const ctxAt = (over: Partial<ResolveLineContext> = {}): ResolveLineContext => ({
  month: 0,
  year: 2026,
  ...over,
});

const expenseLine = (over: Partial<BudgetLine> = {}): BudgetLine => ({
  id: "groceries",
  label: "Groceries",
  target: { kind: "expense" },
  category: "needs",
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(800) },
  ...over,
});

describe("resolveBudgetLineMonthlyCents — literal amount source", () => {
  it("returns the authored monthly dollar figure", () => {
    expect(resolveBudgetLineMonthlyCents(expenseLine(), ctxAt({ month: 5 }))).toBe(
      dollarsToCents(800),
    );
  });
});

describe("resolveBudgetLineMonthlyCents — fill-to-limit amount source", () => {
  const fillLine: BudgetLine = {
    id: "max-401k",
    label: "Max out 401(k)",
    target: { kind: "account", accountId: "retirement", taxTreatment: "preTax" },
    category: "savings",
    amountSource: { kind: "fillToLimit" },
  };

  it("spreads the legislated annual cap evenly across the year", () => {
    const annualLimitCents = () => dollarsToCents(24_000);
    expect(resolveBudgetLineMonthlyCents(fillLine, ctxAt({ annualLimitCents }))).toBe(
      dollarsToCents(2_000),
    );
  });

  it("auto-follows the age-50 catch-up bump through the seam with no authoring change", () => {
    // The seam returns a higher cap from age 50 — the SAME line resolves to more.
    const annualLimitCents = (c: { age?: number }) =>
      (c.age ?? 0) >= 50 ? dollarsToCents(32_000) : dollarsToCents(24_000);
    const under50 = resolveBudgetLineMonthlyCents(fillLine, ctxAt({ age: 49, annualLimitCents }));
    const at50 = resolveBudgetLineMonthlyCents(fillLine, ctxAt({ age: 50, annualLimitCents }));
    expect(under50).toBe(dollarsToCents(2_000));
    expect(at50).toBe(dollarsToCents(32_000 / 12));
    expect(at50).toBeGreaterThan(under50);
  });

  it("resolves to 0 when no cap seam is supplied (nothing to fill)", () => {
    expect(resolveBudgetLineMonthlyCents(fillLine, ctxAt())).toBe(0);
  });
});

describe("resolveBudgetLineMonthlyCents — goal-paced amount source", () => {
  const pacedLine: BudgetLine = {
    id: "downpayment",
    label: "House down payment",
    target: { kind: "account", accountId: "goal-house", taxTreatment: "postTax" },
    category: "savings",
    amountSource: { kind: "goalPaced", targetCents: dollarsToCents(24_000), targetMonth: 24 },
  };

  it("paces the remaining gap evenly over the months left to the deadline", () => {
    // $24k target, nothing saved, 24 months out → $1,000/mo.
    expect(resolveBudgetLineMonthlyCents(pacedLine, ctxAt({ month: 0 }))).toBe(
      dollarsToCents(1_000),
    );
  });

  it("re-paces off the current balance as it accumulates", () => {
    // Halfway there ($12k saved) with 12 months left → still $1,000/mo.
    expect(
      resolveBudgetLineMonthlyCents(
        pacedLine,
        ctxAt({ month: 12, currentBalanceCents: dollarsToCents(12_000) }),
      ),
    ).toBe(dollarsToCents(1_000));
  });

  it("stops once the deadline is reached", () => {
    expect(resolveBudgetLineMonthlyCents(pacedLine, ctxAt({ month: 24 }))).toBe(0);
  });

  it("funds nothing once the target is already met", () => {
    expect(
      resolveBudgetLineMonthlyCents(
        pacedLine,
        ctxAt({ month: 6, currentBalanceCents: dollarsToCents(30_000) }),
      ),
    ).toBe(0);
  });

  it("is growth-aware: a fund's own monthly rate lowers the required pace (#26)", () => {
    // Same $24k/24-month goal, but the fund earns 1%/mo — leaning on that growth
    // requires strictly less each month than the flat $1,000 spread.
    const flat = resolveBudgetLineMonthlyCents(pacedLine, ctxAt({ month: 0 }));
    const withGrowth = resolveBudgetLineMonthlyCents(
      pacedLine,
      ctxAt({ month: 0, fundMonthlyRate: 0.01 }),
    );
    expect(withGrowth).toBeLessThan(flat);
    expect(withGrowth).toBeGreaterThan(0);
  });
});

describe("resolveBudgetLineMonthlyCents — spans", () => {
  const spanned = expenseLine({ span: { startMonth: 12, endMonth: 24 } });

  it("resolves to 0 before the span starts", () => {
    expect(resolveBudgetLineMonthlyCents(spanned, ctxAt({ month: 11 }))).toBe(0);
  });

  it("resolves the amount inside the span (start inclusive)", () => {
    expect(resolveBudgetLineMonthlyCents(spanned, ctxAt({ month: 12 }))).toBe(dollarsToCents(800));
  });

  it("resolves to 0 at and after the span end (end exclusive)", () => {
    expect(resolveBudgetLineMonthlyCents(spanned, ctxAt({ month: 24 }))).toBe(0);
  });
});

describe("resolveBudgetLineMonthlyCents — dated value overrides", () => {
  it("applies a fromHereForward override from its month onward", () => {
    const line = expenseLine({
      overrides: [{ month: 6, monthlyCents: dollarsToCents(1_000), scope: "fromHereForward" }],
    });
    expect(resolveBudgetLineMonthlyCents(line, ctxAt({ month: 5 }))).toBe(dollarsToCents(800));
    expect(resolveBudgetLineMonthlyCents(line, ctxAt({ month: 6 }))).toBe(dollarsToCents(1_000));
    expect(resolveBudgetLineMonthlyCents(line, ctxAt({ month: 99 }))).toBe(dollarsToCents(1_000));
  });

  it("lets a thisMonthOnly override win over a standing fromHereForward at the same month", () => {
    const line = expenseLine({
      overrides: [
        { month: 6, monthlyCents: dollarsToCents(1_000), scope: "fromHereForward" },
        { month: 6, monthlyCents: dollarsToCents(5_000), scope: "thisMonthOnly" },
      ],
    });
    expect(resolveBudgetLineMonthlyCents(line, ctxAt({ month: 6 }))).toBe(dollarsToCents(5_000));
    expect(resolveBudgetLineMonthlyCents(line, ctxAt({ month: 7 }))).toBe(dollarsToCents(1_000));
  });

  it("models the age-50 catch-up as an explicit dated dollar bump on a literal line", () => {
    // §19: catch-up is EITHER fill-to-limit (automatic) OR a dated override (explicit).
    const line: BudgetLine = {
      id: "ira",
      label: "IRA contribution",
      target: { kind: "account", accountId: "ira", taxTreatment: "preTax" },
      category: "savings",
      amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
      overrides: [{ month: 120, monthlyCents: dollarsToCents(600), scope: "fromHereForward" }],
    };
    expect(resolveBudgetLineMonthlyCents(line, ctxAt({ month: 119 }))).toBe(dollarsToCents(500));
    expect(resolveBudgetLineMonthlyCents(line, ctxAt({ month: 120 }))).toBe(dollarsToCents(600));
  });
});

describe("taxTreatmentForLine — pre/post-tax read off the target (AC5)", () => {
  it("carries a pre-tax account target's treatment through", () => {
    expect(
      taxTreatmentForLine(
        expenseLine({ target: { kind: "account", accountId: "r", taxTreatment: "preTax" } }),
      ),
    ).toBe("preTax");
  });

  it("carries a post-tax account target's treatment through", () => {
    expect(
      taxTreatmentForLine(
        expenseLine({ target: { kind: "account", accountId: "b", taxTreatment: "postTax" } }),
      ),
    ).toBe("postTax");
  });

  it("treats an expense line as a post-tax outflow", () => {
    expect(taxTreatmentForLine(expenseLine())).toBe("postTax");
  });
});

describe("orderBudgetLines — prioritized list (§15)", () => {
  it("ranks explicit priority first, then category tier default (needs→wants→savings)", () => {
    const lines: BudgetLine[] = [
      expenseLine({ id: "fun", category: "wants" }),
      expenseLine({ id: "rent", category: "needs" }),
      expenseLine({ id: "invest", category: "savings" }),
    ];
    expect(orderBudgetLines(lines).map((l) => l.id)).toEqual(["rent", "fun", "invest"]);
  });

  it("honors an explicit priority override across category tiers", () => {
    const lines: BudgetLine[] = [
      expenseLine({ id: "rent", category: "needs" }),
      expenseLine({ id: "urgent-savings", category: "savings", priority: -1 }),
    ];
    expect(orderBudgetLines(lines).map((l) => l.id)).toEqual(["urgent-savings", "rent"]);
  });

  it("keeps authored order stable within a tier", () => {
    const lines: BudgetLine[] = [
      expenseLine({ id: "a", category: "needs" }),
      expenseLine({ id: "b", category: "needs" }),
    ];
    expect(orderBudgetLines(lines).map((l) => l.id)).toEqual(["a", "b"]);
  });
});

describe("resolveBudget — all three amount sources resolve together (AC1/AC2)", () => {
  it("returns the prioritized, per-line funded view tagged with pre/post-tax treatment", () => {
    const lines: BudgetLine[] = [
      expenseLine({ id: "rent", category: "needs" }),
      {
        id: "401k",
        label: "401(k)",
        target: { kind: "account", accountId: "retirement", taxTreatment: "preTax" },
        category: "savings",
        amountSource: { kind: "fillToLimit" },
      },
      {
        id: "house",
        label: "House fund",
        target: { kind: "account", accountId: "goal-house", taxTreatment: "postTax" },
        category: "savings",
        priority: 1500,
        amountSource: { kind: "goalPaced", targetCents: dollarsToCents(24_000), targetMonth: 24 },
      },
    ];
    const resolved = resolveBudget(
      lines,
      ctxAt({ annualLimitCents: () => dollarsToCents(24_000) }),
    );
    expect(resolved.map((r) => r.lineId)).toEqual(["rent", "house", "401k"]);
    expect(resolved.map((r) => r.monthlyCents)).toEqual([
      dollarsToCents(800),
      dollarsToCents(1_000),
      dollarsToCents(2_000),
    ]);
    expect(resolved.map((r) => r.taxTreatment)).toEqual(["postTax", "postTax", "preTax"]);
  });
});

describe("fundLinesInPriorityOrder — §Q27 per-line actually-funded view", () => {
  const intents = [
    { id: "line:rent", priority: 0, intendedCents: dollarsToCents(2_000) },
    { id: "line:groceries", priority: 1000, intendedCents: dollarsToCents(600) },
    { id: "line:fun", priority: 2000, intendedCents: dollarsToCents(400) },
  ];

  it("funds every line to its intent when cash covers the whole budget (solvent)", () => {
    const funded = fundLinesInPriorityOrder(intents, dollarsToCents(3_000));
    expect(funded).toEqual({
      "line:rent": dollarsToCents(2_000),
      "line:groceries": dollarsToCents(600),
      "line:fun": dollarsToCents(400),
    });
  });

  it("starves the lowest-priority lines first in a shortfall", () => {
    // $2,700 available against a $3,000 budget → the last $300 falls on the
    // lowest-priority line (fun), which is starved from $400 down to $100.
    const funded = fundLinesInPriorityOrder(intents, dollarsToCents(2_700));
    expect(funded["line:rent"]).toBe(dollarsToCents(2_000));
    expect(funded["line:groceries"]).toBe(dollarsToCents(600));
    expect(funded["line:fun"]).toBe(dollarsToCents(100));
  });

  it("funds nothing when no cash is available; negative available clamps to 0", () => {
    expect(fundLinesInPriorityOrder(intents, 0)).toEqual({
      "line:rent": 0,
      "line:groceries": 0,
      "line:fun": 0,
    });
    expect(fundLinesInPriorityOrder(intents, -500)).toEqual({
      "line:rent": 0,
      "line:groceries": 0,
      "line:fun": 0,
    });
  });
});
