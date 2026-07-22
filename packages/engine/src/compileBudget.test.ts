/**
 * Compilation of the line-item {@link BudgetLine} budget into the simulator's
 * inputs (§12, §15, §18, §19, issue #67, slice 4). Unit-level assertions on the
 * compiled expense series, plus an end-to-end pass through the real simulator via
 * {@link createProjectionBase} proving a line-item budget drives spending (spans +
 * dated overrides included) exactly like the scalar `expenseCents` path.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, replayLedger, dollarsToCents, nullJurisdiction } from "./index";
import { compileExpenseBudgetLines, fillToLimitSeamFor } from "./compileBudget";
import { createProjectionBase, type ProjectionContext } from "./projectionBase";
import { mockJurisdiction } from "./testing/mockJurisdiction";
import { samplePlan } from "./testing/samplePlan";
import type { BudgetLine } from "./budgetLine";
import type { Plan } from "./plan";

const START_YEAR = 2026;
const ctx = (jurisdiction = nullJurisdiction): ProjectionContext => ({ jurisdiction, startYear: START_YEAR });
const project = (plan: Plan, jurisdiction = nullJurisdiction) =>
  replayLedger(emptyLedger, createProjectionBase(plan, ctx(jurisdiction)), jurisdiction);

const literalExpense = (id: string, monthly: number, over: Partial<BudgetLine> = {}): BudgetLine => ({
  id,
  label: id,
  target: { kind: "expense" },
  category: "needs",
  amountSource: { kind: "literal", monthlyCents: monthly },
  ...over,
});

describe("compileExpenseBudgetLines", () => {
  it("compiles a literal expense line to a flat monthly series at a zero inflation rate", () => {
    const [s] = compileExpenseBudgetLines([literalExpense("rent", dollarsToCents(2_000))], "p1", 0);
    expect(s.ownerId).toBe("p1");
    expect(s.series.getMonthlyCents(0)).toBe(dollarsToCents(2_000));
    expect(s.series.getMonthlyCents(120)).toBe(dollarsToCents(2_000)); // flat, no CPI growth
  });

  it("grows a line with inflation, like the scalar expense series it replaces", () => {
    // A budget is authored in today's dollars. Compiling it flat would model a
    // household whose spending never rises — over a lifetime that understates cost
    // enough to move the retirement age by years.
    const [s] = compileExpenseBudgetLines(
      [literalExpense("rent", dollarsToCents(2_000))],
      "p1",
      0.03,
    );
    expect(s.series.getMonthlyCents(0)).toBe(dollarsToCents(2_000));
    // Ten years of 3% compounding ≈ 2000 × 1.03^10 ≈ $2,688.
    expect(s.series.getMonthlyCents(120)).toBeGreaterThan(dollarsToCents(2_600));
    expect(s.series.getMonthlyCents(120)).toBeLessThan(dollarsToCents(2_750));
  });

  it("honors a line span: 0 before start, amount inside, 0 at/after the exclusive end", () => {
    const [s] = compileExpenseBudgetLines(
      [literalExpense("daycare", dollarsToCents(1_500), { span: { startMonth: 12, endMonth: 24 } })],
      "p1",
      0,
    );
    expect(s.series.getMonthlyCents(11)).toBe(0);
    expect(s.series.getMonthlyCents(12)).toBe(dollarsToCents(1_500));
    expect(s.series.getMonthlyCents(23)).toBe(dollarsToCents(1_500));
    expect(s.series.getMonthlyCents(24)).toBe(0);
  });

  it("applies a dated fromHereForward override on the compiled series", () => {
    const [s] = compileExpenseBudgetLines(
      [
        literalExpense("food", dollarsToCents(600), {
          overrides: [{ month: 36, monthlyCents: dollarsToCents(900), scope: "fromHereForward" }],
        }),
      ],
      "p1",
      0,
    );
    expect(s.series.getMonthlyCents(35)).toBe(dollarsToCents(600));
    expect(s.series.getMonthlyCents(36)).toBe(dollarsToCents(900));
  });

  it("skips contribution lines (only expense targets become expense series)", () => {
    const lines: BudgetLine[] = [
      literalExpense("rent", dollarsToCents(2_000)),
      {
        id: "401k",
        label: "401(k)",
        target: { kind: "account", accountId: "retirement", taxTreatment: "preTax" },
        category: "savings",
        amountSource: { kind: "fillToLimit" },
      },
    ];
    expect(compileExpenseBudgetLines(lines, "p1", 0)).toHaveLength(1);
  });

  it("refuses a non-literal expense line (fill-to-limit / goal-paced are contribution behaviours)", () => {
    const bad = literalExpense("x", 0, { amountSource: { kind: "fillToLimit" } });
    expect(() => compileExpenseBudgetLines([bad], "p1", 0)).toThrow(/literal/);
  });
});

describe("fillToLimitSeamFor", () => {
  it("returns the jurisdiction's deferral-limit plug when present", () => {
    const seam = fillToLimitSeamFor(
      mockJurisdiction({ retirementDeferralLimitCents: () => dollarsToCents(24_000) }),
    );
    expect(seam?.({ year: 2026 })).toBe(dollarsToCents(24_000));
  });

  it("returns undefined for a jurisdiction with no cap (null jurisdiction)", () => {
    expect(fillToLimitSeamFor(nullJurisdiction)).toBeUndefined();
  });
});

describe("createProjectionBase — the line-item budget drives spending (§12, AC1)", () => {
  it("reproduces the scalar expense path when a single literal line replaces expenseCents", () => {
    // A budget line rises with prices exactly like the scalar `expenseCents` series it
    // replaces, so one line carrying the whole scalar amount is indistinguishable from
    // it — the parity that lets #72 delete the scalar path without moving any number.
    const scalar = project(samplePlan);
    const lineItem = project({
      ...samplePlan,
      budgetLines: [literalExpense("all-spend", samplePlan.expenseCents)],
    });
    expect(lineItem.months.at(-1)!.netWorthNominalCents).toBe(
      scalar.months.at(-1)!.netWorthNominalCents,
    );
  });

  it("spending more via the line-item budget leaves the household poorer (real driver, not a stub)", () => {
    const lean = project({
      ...samplePlan,
      budgetLines: [literalExpense("spend", dollarsToCents(3_000))],
    });
    const lavish = project({
      ...samplePlan,
      budgetLines: [literalExpense("spend", dollarsToCents(5_000))],
    });
    // Compared mid-horizon: an inflating $5k/mo eventually exhausts the household and
    // reports a null (insolvent) net worth, which is not a number to compare against.
    const AT = 120;
    expect(lean.months[AT]!.netWorthNominalCents!).toBeGreaterThan(
      lavish.months[AT]!.netWorthNominalCents!,
    );
  });

  it("a spanned expense line that stops early leaves the household richer than one that never stops", () => {
    const forever = project({
      ...samplePlan,
      budgetLines: [literalExpense("spend", dollarsToCents(4_000))],
    });
    const stopsAt5y = project({
      ...samplePlan,
      budgetLines: [literalExpense("spend", dollarsToCents(4_000), { span: { endMonth: 60 } })],
    });
    expect(stopsAt5y.months.at(-1)!.netWorthNominalCents!).toBeGreaterThan(
      forever.months.at(-1)!.netWorthNominalCents!,
    );
  });

  it("leaves the scalar path untouched when no budgetLines are authored", () => {
    const a = project(samplePlan).months.at(-1)!.netWorthNominalCents!;
    const b = project({ ...samplePlan, budgetLines: [] }).months.at(-1)!.netWorthNominalCents!;
    expect(a).toBe(b);
  });
});
