import { describe, it, expect } from "vitest";
import { dollarParts, formatWholeDollars, monthLabel, yearOf } from "./format";
import { START_YEAR } from "./config";

describe("yearOf / monthLabel — the one year axis every surface shares", () => {
  it("is 0-indexed: the first twelve months are all Year 0 ('now')", () => {
    expect(yearOf(0)).toBe(0);
    expect(yearOf(11)).toBe(0);
    expect(yearOf(12)).toBe(1);
    expect(monthLabel(0)).toBe(`Year 0 (${START_YEAR})`);
  });

  it("labels a mid-year month by the year it falls in, not the next one", () => {
    // Regression: the net-worth chart used `floor(month / 12) + 1`, so month 534 read
    // "year 45" on the chart while the banner called it "Year 44". Both go through this.
    expect(yearOf(534)).toBe(44);
    expect(monthLabel(534)).toBe(`Year 44 (${START_YEAR + 44})`);
  });
});

describe("dollarParts — a breakdown that adds up at the dollar it is printed to", () => {
  it("makes the printed parts sum to the printed total, not to their own roundings", () => {
    // $2,700.005 each, a household total of $5,400.01. Rounded independently the parts print as
    // $2,700 + $2,700 = $5,400 against a total printing as $5,400 — and one cent later, $5,401.
    expect(dollarParts([270_000, 270_001], 5_400)).toEqual([2_700, 2_700]);
    expect(dollarParts([270_050, 270_051], 5_401)).toEqual([2_700, 2_701]);
  });

  it("holds for any split of any total, including the awkward thirds", () => {
    const total = 100_001;
    const parts = dollarParts([33_334, 33_334, 33_333], Math.round(total / 100));
    expect(parts.reduce((sum, p) => sum + p, 0)).toBe(1_000);
  });

  it("answers zero for a breakdown of nothing, rather than dividing by it", () => {
    expect(dollarParts([0, 0], 0)).toEqual([0, 0]);
    expect(dollarParts([], 0)).toEqual([]);
  });

  it("formats a whole-dollar figure the way every other amount is formatted", () => {
    expect(formatWholeDollars(2_700)).toBe("$2,700");
  });
});
