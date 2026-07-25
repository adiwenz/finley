import { describe, expect, it } from "vitest";
import { dollarsToCents, type ProjectionSeries, type SpendingItem } from "@finley/engine";
import { buildPerLineBudgetData, describeInsolvency } from "./perLineBudget";

/** A spending item as the engine reports one, with the chart-relevant bits varied. */
function item(over: Partial<SpendingItem> & Pick<SpendingItem, "id" | "amountCents">): SpendingItem {
  return {
    label: over.id,
    category: "needs",
    sourceKind: "budgetLine",
    sourceId: over.id,
    editable: true,
    ...over,
  };
}

const rent = (dollars: number) =>
  item({ id: "line:rent", label: "Rent", amountCents: dollarsToCents(dollars) });
const fun = (dollars: number) =>
  item({
    id: "line:fun",
    label: "Fun",
    category: "wants",
    amountCents: dollarsToCents(dollars),
  });
const health = (dollars: number) =>
  item({
    id: "health",
    label: "Healthcare",
    category: "healthcare",
    sourceKind: "healthcare",
    sourceId: "health",
    editable: false,
    amountCents: dollarsToCents(dollars),
  });
const loan = (dollars: number) =>
  item({
    id: "debt:loan-student",
    label: "Student loan payment",
    category: "debtService",
    sourceKind: "liability",
    sourceId: "loan-student",
    editable: false,
    amountCents: dollarsToCents(dollars),
  });

/**
 * A minimal series fixture: month 0 is the flow-free opening snapshot, then one flowed
 * month per item list, carrying the engine's itemized spending and its total.
 */
function seriesOf(months: SpendingItem[][], insolventFrom?: number): ProjectionSeries {
  const all = [
    { month: 0, isInsolvent: false },
    ...months.map((spendingItems, i) => ({
      month: i + 1,
      isInsolvent: insolventFrom !== undefined && i + 1 >= insolventFrom,
      flows: {
        spendingItems,
        totalSpendingCents: spendingItems.reduce((sum, s) => sum + s.amountCents, 0),
      },
    })),
  ];
  return { months: all } as unknown as ProjectionSeries;
}

describe("buildPerLineBudgetData — the spending graph reads the engine's items (AC2)", () => {
  it("emits one row per flowed month, with each item's amount and the engine's total", () => {
    const data = buildPerLineBudgetData(seriesOf([[rent(4_000), fun(2_000)]]));
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.month).toBe(1);
    expect(data.rows[0]!.centsByLine["line:fun"]).toBe(dollarsToCents(2_000));
    // The total is the engine's `totalSpendingCents`, not a re-sum in the UI.
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(6_000));
    expect(data.insolventFromMonth).toBeNull();
  });

  it("bands every kind of spending, tagged for drawing and for editability", () => {
    // Budget lines are the only editable ones; health and debt are drawn but not
    // offered as lines to edit — the flag comes from the engine, not a guess here.
    const data = buildPerLineBudgetData(seriesOf([[rent(4_000), health(450), loan(500)]]));
    expect(data.lines).toEqual([
      { id: "line:rent", label: "Rent", kind: "line", editable: true },
      { id: "health", label: "Healthcare", kind: "other", editable: false },
      { id: "debt:loan-student", label: "Student loan payment", kind: "debt", editable: false },
    ]);
    expect(data.rows[0]!.totalCents).toBe(dollarsToCents(4_950));
  });

  it("draws every line at its full amount even in a month the plan cannot afford", () => {
    // The engine reports spending as authored; a tight month is absorbed by savings
    // and then credit, so nothing is rationed away behind the user's back.
    const data = buildPerLineBudgetData(
      seriesOf([[rent(4_000), fun(2_000)], [rent(4_000), fun(2_000)]], 2),
    );
    const brokeRow = data.rows.find((r) => r.month === 2)!;
    expect(brokeRow.centsByLine["line:fun"]).toBe(dollarsToCents(2_000));
    expect(brokeRow.totalCents).toBe(dollarsToCents(6_000));
  });

  it("reports the month the plan stops being financeable", () => {
    const data = buildPerLineBudgetData(seriesOf([[rent(4_000)], [rent(4_000)]], 2));
    expect(data.insolventFromMonth).toBe(2);
  });

  it("keeps a band once seen, so a paid-off debt does not restructure the chart", () => {
    const data = buildPerLineBudgetData(seriesOf([[rent(4_000), loan(500)], [rent(4_000)]]));
    expect(data.lines.map((b) => b.id)).toEqual(["line:rent", "debt:loan-student"]);
    expect(data.rows[1]!.centsByLine["debt:loan-student"]).toBeUndefined();
    expect(data.rows[1]!.totalCents).toBe(dollarsToCents(4_000));
  });

  it("drops a stream that costs nothing all horizon rather than drawing an empty band", () => {
    const data = buildPerLineBudgetData(
      seriesOf([[rent(4_000), health(0)], [rent(4_000), health(0)]]),
    );
    expect(data.lines.map((b) => b.id)).toEqual(["line:rent"]);
  });
});

describe("describeInsolvency — the a11y / summary line (AC2)", () => {
  it("returns null when the plan finances the budget throughout", () => {
    const data = buildPerLineBudgetData(seriesOf([[rent(4_000), fun(2_000)]]));
    expect(describeInsolvency(data)).toBeNull();
  });

  it("names the year the plan runs out, without prescribing what to cut", () => {
    const data = buildPerLineBudgetData(seriesOf([[rent(4_000)], [rent(4_000)]], 2));
    const summary = describeInsolvency(data) ?? "";
    expect(summary).toMatch(/Year 1/);
    expect(summary).toMatch(/no longer financeable/i);
    // It must not tell the user which line to give up — that is their decision.
    expect(summary).not.toMatch(/Rent|Fun|starv/i);
  });
});
