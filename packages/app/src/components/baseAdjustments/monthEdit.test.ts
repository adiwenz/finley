/**
 * Direct-manipulation budget editing (issue #71, §20). Pins the routing table: the
 * (row, scope) gesture has exactly one home per fact, and the income "just this month"
 * case is a *delta* ledger transaction rather than a standing change.
 */
import { describe, expect, it } from "vitest";
import { dollarsToCents, type BudgetLine } from "@finley/engine";
import {
  applyLineOverride,
  resolveRowsAtMonth,
  routeMonthEdit,
  type MonthEdit,
} from "./monthEdit";

const START_YEAR = 2026;

function line(id: string, monthlyCents: number, overrides?: BudgetLine["overrides"]): BudgetLine {
  return {
    id,
    label: id,
    target: { kind: "expense" },
    amountSource: { kind: "literal", monthlyCents },
    category: "needs",
    ...(overrides ? { overrides } : {}),
  };
}

const edit = (over: Partial<MonthEdit>): MonthEdit => ({
  row: { kind: "line", lineId: "housing" },
  month: 14,
  priorAmountCents: dollarsToCents(2_000),
  newAmountCents: dollarsToCents(2_400),
  scope: "fromHereForward",
  ...over,
});

describe("routeMonthEdit — spend rows", () => {
  it("routes a from-here-forward spend edit to a standing dated override", () => {
    const route = routeMonthEdit(edit({ scope: "fromHereForward" }));
    expect(route).toEqual({
      kind: "lineOverride",
      lineId: "housing",
      override: { month: 14, monthlyCents: dollarsToCents(2_400), scope: "fromHereForward" },
    });
  });

  it("routes a just-this-month spend edit to a single-month override", () => {
    const route = routeMonthEdit(edit({ scope: "thisMonthOnly" }));
    expect(route).toMatchObject({
      kind: "lineOverride",
      override: { scope: "thisMonthOnly", month: 14 },
    });
  });
});

describe("routeMonthEdit — income row", () => {
  it("routes a permanent income change to a job/stream override, never a budget line", () => {
    const route = routeMonthEdit(
      edit({ row: { kind: "income" }, scope: "fromHereForward" }),
    );
    expect(route).toEqual({
      kind: "incomeOverride",
      month: 14,
      monthlyCents: dollarsToCents(2_400),
    });
  });

  it("routes a one-month income change to a ledger transaction for the delta", () => {
    const route = routeMonthEdit(
      edit({
        row: { kind: "income" },
        scope: "thisMonthOnly",
        priorAmountCents: dollarsToCents(5_000),
        newAmountCents: dollarsToCents(5_800),
      }),
    );
    // The +$800 bonus, not the $5,800 — the standing income is untouched.
    expect(route).toEqual({
      kind: "ledgerTransaction",
      month: 14,
      amountCents: dollarsToCents(800),
    });
  });

  it("signs a one-month income drop negative (a missed paycheck is cash out)", () => {
    const route = routeMonthEdit(
      edit({
        row: { kind: "income" },
        scope: "thisMonthOnly",
        priorAmountCents: dollarsToCents(5_000),
        newAmountCents: dollarsToCents(3_000),
      }),
    );
    expect(route).toMatchObject({ amountCents: dollarsToCents(-2_000) });
  });
});

describe("resolveRowsAtMonth", () => {
  const lines = [
    line("housing", dollarsToCents(1_600), [
      { month: 24, monthlyCents: dollarsToCents(2_000), scope: "fromHereForward" },
      { month: 6, monthlyCents: dollarsToCents(900), scope: "thisMonthOnly" },
    ]),
    line("food", dollarsToCents(600)),
  ];

  it("shows the base amount at a month before any override", () => {
    const rows = resolveRowsAtMonth(lines, 0, START_YEAR);
    expect(rows[0]).toMatchObject({ monthlyCents: dollarsToCents(1_600), overridden: false });
  });

  it("shows a one-month override only at its own month", () => {
    expect(resolveRowsAtMonth(lines, 6, START_YEAR)[0]).toMatchObject({
      monthlyCents: dollarsToCents(900),
      overridden: true,
    });
    expect(resolveRowsAtMonth(lines, 7, START_YEAR)[0]?.monthlyCents).toBe(dollarsToCents(1_600));
  });

  it("carries a from-here-forward override to every later month", () => {
    expect(resolveRowsAtMonth(lines, 24, START_YEAR)[0]?.monthlyCents).toBe(dollarsToCents(2_000));
    expect(resolveRowsAtMonth(lines, 400, START_YEAR)[0]?.monthlyCents).toBe(dollarsToCents(2_000));
  });

  it("leaves an unadjusted line flat across the horizon", () => {
    expect(resolveRowsAtMonth(lines, 300, START_YEAR)[1]).toMatchObject({
      monthlyCents: dollarsToCents(600),
      overridden: false,
    });
  });
});

describe("applyLineOverride", () => {
  it("replaces an override at the same month/scope rather than stacking duplicates", () => {
    const start = [line("housing", dollarsToCents(1_600))];
    const once = applyLineOverride(start, "housing", {
      month: 14,
      monthlyCents: dollarsToCents(2_000),
      scope: "fromHereForward",
    });
    const twice = applyLineOverride(once, "housing", {
      month: 14,
      monthlyCents: dollarsToCents(2_200),
      scope: "fromHereForward",
    });
    expect(twice[0]?.overrides).toEqual([
      { month: 14, monthlyCents: dollarsToCents(2_200), scope: "fromHereForward" },
    ]);
  });

  it("keeps overrides at other months and leaves other lines untouched", () => {
    const start = [
      line("housing", dollarsToCents(1_600), [
        { month: 6, monthlyCents: dollarsToCents(900), scope: "thisMonthOnly" },
      ]),
      line("food", dollarsToCents(600)),
    ];
    const next = applyLineOverride(start, "housing", {
      month: 14,
      monthlyCents: dollarsToCents(2_000),
      scope: "fromHereForward",
    });
    expect(next[0]?.overrides).toHaveLength(2);
    expect(next[1]).toEqual(start[1]);
  });
});
