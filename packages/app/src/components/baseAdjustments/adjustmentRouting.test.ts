import { describe, expect, it } from "vitest";
import { dollarsToCents } from "@finley/engine";
import { anchorToMonth, routeAdjustment, type Adjustment } from "./adjustmentRouting";

const CTX = { currentAge: 40 };

const base: Adjustment = {
  target: "spend",
  timing: "recurring",
  anchor: { kind: "month", month: 6 },
  amountCents: dollarsToCents(500),
  lineId: "line:groceries",
};

describe("anchorToMonth — near-term month vs long-horizon age (§UI, AC5)", () => {
  it("passes a near-term month anchor straight through", () => {
    expect(anchorToMonth({ kind: "month", month: 8 }, CTX)).toBe(8);
  });

  it("resolves a long-horizon age anchor to a month offset from today's age", () => {
    // "at age 50" for a 40-year-old is 10 years = 120 months out.
    expect(anchorToMonth({ kind: "age", age: 50 }, CTX)).toBe(120);
  });

  it("clamps an age at or before today to month 0 (never negative)", () => {
    expect(anchorToMonth({ kind: "age", age: 35 }, CTX)).toBe(0);
  });
});

describe("routeAdjustment — the §20 routing table (AC4)", () => {
  it("routes a one-time change to a ledger transaction (refund/bonus)", () => {
    const route = routeAdjustment({ ...base, timing: "oneTime" }, CTX);
    expect(route).toEqual({
      kind: "ledgerTransaction",
      month: 6,
      amountCents: dollarsToCents(500),
    });
  });

  it("routes a recurring spend change to a dated override on the standing line", () => {
    const route = routeAdjustment(base, CTX);
    expect(route).toEqual({
      kind: "lineOverride",
      lineId: "line:groceries",
      override: {
        month: 6,
        monthlyCents: dollarsToCents(500),
        scope: "fromHereForward",
      },
    });
  });

  it("routes a recurring income change to a job/stream override, NOT a budget line", () => {
    const route = routeAdjustment(
      { ...base, target: "income", anchor: { kind: "age", age: 50 } },
      CTX,
    );
    expect(route).toEqual({
      kind: "incomeOverride",
      month: 120,
      amountCents: dollarsToCents(500),
    });
  });

  it("throws when a recurring spend adjustment names no line to override", () => {
    expect(() => routeAdjustment({ ...base, lineId: undefined }, CTX)).toThrow(/line/i);
  });
});
