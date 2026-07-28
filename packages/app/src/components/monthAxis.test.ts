import { describe, it, expect } from "vitest";
import { TODAY_X, axisPointLabel, fromAxisX, toAxisX } from "./monthAxis";
import { monthLabel } from "../format";

/**
 * The one axis every projection chart shares. These pin the contract the charts rely on to
 * stay aligned with each other: today owns x=0, processed month m owns x=m+1, and a click
 * round-trips back to the month it came from.
 */
describe("the months-from-now chart axis", () => {
  it("reserves x=0 for today and puts the first processed month one month out", () => {
    expect(TODAY_X).toBe(0);
    // Month 0 is a REAL processed month now, so it must not share the slot with "now" —
    // that collapse is exactly what made the opening step read as a rendering artifact.
    expect(toAxisX(0)).toBe(1);
    expect(toAxisX(11)).toBe(12);
  });

  it("round-trips a month through the axis and back", () => {
    for (const month of [0, 1, 11, 12, 359]) {
      expect(fromAxisX(toAxisX(month))).toBe(month);
    }
  });

  it("resolves a click on the today slot to the first editable month", () => {
    // Nothing can be authored at "now" — it is an instant, not a month — so a click there
    // selects month 0 rather than a negative month the editor cannot point at.
    expect(fromAxisX(TODAY_X)).toBe(0);
  });

  it("labels the today slot as now, and every later point as an end-of-month", () => {
    expect(axisPointLabel(TODAY_X)).toBe("Today · now, before any flow");
    expect(axisPointLabel(toAxisX(0), monthLabel)).toBe(`End of month 0 · ${monthLabel(0)}`);
    expect(axisPointLabel(toAxisX(12), monthLabel)).toBe(`End of month 12 · ${monthLabel(12)}`);
  });

  it("names the same instant on the flow charts as on the net-worth charts", () => {
    // The alignment guarantee: a flow chart has no point at the today slot, but the point it
    // DOES draw at a given x carries the same label the stock charts give that x.
    expect(axisPointLabel(toAxisX(5), monthLabel)).toBe(axisPointLabel(6, monthLabel));
  });
});
