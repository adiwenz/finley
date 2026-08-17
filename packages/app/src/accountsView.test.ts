/**
 * The Accounts workspace's grouped ledger, against a real projection.
 *
 * The grouping is the contract: assets and debt are two lists with their own subtotals, and an
 * empty account stays out of both.
 */

import { describe, it, expect } from "vitest";
import { Projection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetState } from "./presets";
import { accountsView } from "./accountsView";

function viewOf(presetIndex: number) {
  const projection = Projection.fromState(presetState(PRESETS[presetIndex]!), usJurisdiction);
  const result = projection.run(usJurisdiction);
  return accountsView(projection, result.household, result);
}

describe("accountsView", () => {
  it("groups what is owned apart from what is owed", () => {
    const view = viewOf(0);

    expect(view.groups.map((g) => g.title)).toEqual(
      view.groups.map((g) => g.title).filter((t) => t === "Assets" || t === "Debt"),
    );
    // Assets always lead: the reader is told what they have before what they owe.
    if (view.groups.length === 2) expect(view.groups[0]!.title).toBe("Assets");
  });

  it("leaves empty accounts out of the list entirely", () => {
    for (const [index] of PRESETS.entries()) {
      const view = viewOf(index);
      for (const group of view.groups) {
        for (const row of group.rows) {
          expect(row.value).not.toMatch(/^−?\$0$/);
        }
      }
    }
  });

  it("never emits an empty group", () => {
    for (const [index] of PRESETS.entries()) {
      for (const group of viewOf(index).groups) {
        expect(group.rows.length).toBeGreaterThan(0);
      }
    }
  });

  it("states a net worth for every starter scenario", () => {
    for (const [index] of PRESETS.entries()) {
      expect(viewOf(index).netWorth).toMatch(/^-?\$/);
    }
  });
});
