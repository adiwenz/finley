/**
 * The Spending workspace's tiles and phases, against a real projection.
 *
 * A phase is only worth showing if it is anchored to something the reader recognises, so the
 * contract is: today always leads, every later phase names a future change, and the figures are
 * the projection's own.
 */

import { describe, it, expect } from "vitest";
import { Projection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetState } from "./presets";
import { retirementView } from "./retirementView";
import { spendingView } from "./spendingView";

function viewOf(presetIndex: number) {
  const state = presetState(PRESETS[presetIndex]!);
  const projection = Projection.fromState(state, usJurisdiction);
  const result = projection.run(usJurisdiction);
  const retirement = retirementView(projection, usJurisdiction);
  return spendingView(state.scenario.plan, state.scenario.ledger, result, retirement.headlineMonth);
}

describe("spendingView — tiles", () => {
  it("always states today, monthly and yearly", () => {
    const view = viewOf(0);
    expect(view.tiles[0]!.label).toBe("Today");
    expect(view.tiles[0]!.sub).toBe("per month");
    expect(view.tiles[1]!.label).toBe("Yearly");
  });

  it("adds a stop-working tile only when the plan reaches one", () => {
    for (const [index] of PRESETS.entries()) {
      const view = viewOf(index);
      const stopTile = view.tiles.find((t) => t.sub === "when you could stop working");
      if (stopTile) expect(stopTile.label).toMatch(/^At age \d+$/);
    }
  });

  it("states a non-zero spend for a household with a budget", () => {
    expect(viewOf(0).tiles[0]!.value).not.toBe("$0");
  });
});

describe("spendingView — phases", () => {
  it("leads with today, so later figures have something to be measured against", () => {
    for (const [index] of PRESETS.entries()) {
      const phases = viewOf(index).phases;
      expect(phases[0]!.when).toBe("Today");
      expect(phases[0]!.why).toBe("Current budget");
    }
  });

  it("anchors every later phase to a named change at an age", () => {
    for (const [index] of PRESETS.entries()) {
      for (const phase of viewOf(index).phases.slice(1)) {
        expect(phase.when).toMatch(/^Age \d+$/);
        expect(phase.why.length).toBeGreaterThan(0);
        expect(phase.why).not.toBe("Current budget");
      }
    }
  });

  it("shows at most three phases", () => {
    for (const [index] of PRESETS.entries()) {
      expect(viewOf(index).phases.length).toBeLessThanOrEqual(3);
    }
  });

  it("states every phase as a monthly figure", () => {
    for (const [index] of PRESETS.entries()) {
      for (const phase of viewOf(index).phases) {
        expect(phase.value).toMatch(/\/mo$/);
      }
    }
  });
});
