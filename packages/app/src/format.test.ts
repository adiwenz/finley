import { describe, it, expect } from "vitest";
import { monthLabel, yearOf } from "./format";
import { START_YEAR } from "./config";

describe("yearOf / monthLabel — the one year axis every surface shares", () => {
  it("is 0-indexed: the first twelve months are all Year 0 ('now')", () => {
    expect(yearOf(0)).toBe(0);
    expect(yearOf(11)).toBe(0);
    expect(yearOf(12)).toBe(1);
    expect(monthLabel(0)).toBe(`Year 0 (${START_YEAR})`);
  });

  it("labels a mid-year month by the year it falls in, not the next one", () => {
    // Regression: the net-worth chart used `floor(month / 12) + 1`, so the default
    // plan's insolvency at month 534 read "year 45" on the chart while the banner
    // called the same month "Year 44". Both now go through this.
    expect(yearOf(534)).toBe(44);
    expect(monthLabel(534)).toBe(`Year 44 (${START_YEAR + 44})`);
  });
});
