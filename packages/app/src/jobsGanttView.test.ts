/**
 * The Jobs gantt's geometry, against a real household.
 *
 * The window is fixed relative to "now", so the invariants worth pinning are about clipping: a
 * bar never escapes the chart, never has zero width, and "today" always lands inside it.
 */

import { describe, it, expect } from "vitest";
import { Projection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetState } from "./presets";
import { jobsGanttView } from "./jobsGanttView";

function viewOf(presetIndex: number, labelBy: "dates" | "ages" = "dates") {
  const projection = Projection.fromState(presetState(PRESETS[presetIndex]!), usJurisdiction);
  const result = projection.run(usJurisdiction);
  return jobsGanttView(result.household, projection, labelBy);
}

const asPct = (value: string) => Number(value.replace("%", ""));

describe("jobsGanttView", () => {
  it("keeps every bar inside the chart", () => {
    for (const [index] of PRESETS.entries()) {
      for (const group of viewOf(index).groups) {
        for (const bar of group.bars) {
          const left = asPct(bar.left);
          const width = asPct(bar.width);
          expect(left).toBeGreaterThanOrEqual(0);
          expect(width).toBeGreaterThan(0);
          expect(left + width).toBeLessThanOrEqual(100.01);
        }
      }
    }
  });

  it("places today inside the window", () => {
    const today = asPct(viewOf(0).todayPct);
    expect(today).toBeGreaterThan(0);
    expect(today).toBeLessThan(100);
  });

  it("never emits a person with no drawable jobs", () => {
    for (const [index] of PRESETS.entries()) {
      for (const group of viewOf(index).groups) {
        expect(group.bars.length).toBeGreaterThan(0);
      }
    }
  });

  it("labels the axis and each bar's span in the chosen vocabulary", () => {
    const byDate = viewOf(0);
    const byAge = viewOf(0, "ages");

    expect(byDate.ticks[0]).toMatch(/^\d{4}$/);
    expect(byAge.ticks[0]).toMatch(/^age -?\d+$/);

    const firstDateBar = byDate.groups[0]?.bars[0];
    const firstAgeBar = byAge.groups[0]?.bars[0];
    if (firstDateBar && firstAgeBar) {
      expect(firstDateBar.range).toMatch(/^\d{4} – \d{4}$/);
      expect(firstAgeBar.range).toMatch(/^age \d+–\d+$/);
      // Only the labelling changes — the geometry is the same chart.
      expect(firstAgeBar.left).toBe(firstDateBar.left);
      expect(firstAgeBar.width).toBe(firstDateBar.width);
    }
  });

  it("names the groups only when more than one person earns", () => {
    for (const [index] of PRESETS.entries()) {
      const view = viewOf(index);
      expect(view.named).toBe(view.groups.length > 1);
    }
  });
});
