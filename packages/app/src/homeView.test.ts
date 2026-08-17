/**
 * The home screen's view-model, against a real projection.
 *
 * The figures are the point: the rail states what the household earns, spends and owns, and a
 * rail that quietly reads zero is worse than one that is absent — it looks like an answer.
 */

import { describe, it, expect } from "vitest";
import { Projection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetState } from "./presets";
import { retirementView } from "./retirementView";
import { homeView, abbreviateDollars, currentFlows } from "./homeView";

function viewOf(presetIndex = 0) {
  const state = presetState(PRESETS[presetIndex]!);
  const projection = Projection.fromState(state, usJurisdiction);
  const result = projection.run(usJurisdiction);
  return homeView(
    state.scenario.plan,
    state.scenario.ledger,
    result,
    retirementView(projection, usJurisdiction),
  );
}

describe("currentFlows", () => {
  it("reads month 0, not the opening position", () => {
    const result = Projection.fromState(presetState(PRESETS[0]!), usJurisdiction).run(usJurisdiction);

    // `opening` is balances-only; it carries no flows at all. Reading income off it yields
    // undefined, which every caller would coalesce to a plausible-looking zero.
    expect(result.series.opening.flows).toBeUndefined();
    expect(currentFlows(result.series)?.totalIncomeCents).toBeGreaterThan(0);
  });
});

describe("homeView — rail cards", () => {
  it("states a non-zero income, spending and net worth for an earning household", () => {
    const view = viewOf();
    const card = (id: string) => view.railCards.find((c) => c.id === id)!;

    expect(card("income").value).not.toBe("$0");
    expect(card("spending").value).not.toBe("$0");
    expect(card("networth").value).not.toBe("$0");
  });

  it("reports income yearly and spending monthly", () => {
    const state = presetState(PRESETS[0]!);
    const result = Projection.fromState(state, usJurisdiction).run(usJurisdiction);
    const monthlyIncome = currentFlows(result.series)!.totalIncomeCents;
    const view = viewOf();

    expect(view.railCards.find((c) => c.id === "income")!.value).toBe(
      abbreviateDollars(monthlyIncome * 12),
    );
    expect(view.railCards.find((c) => c.id === "income")!.sub).toBe("per year, before tax");
    expect(view.railCards.find((c) => c.id === "spending")!.sub).toBe("per month, household");
  });
});

describe("homeView — life changes", () => {
  it("orders changes by when they happen, not by when they were authored", () => {
    // Every preset with a seed timeline exercises the same ordering rule.
    for (const [index] of PRESETS.entries()) {
      const months = viewOf(index).lifeChanges.map((c) => c.month);
      expect(months).toEqual([...months].sort((a, b) => a - b));
    }
  });

  it("counts the changes it holds, and says nothing when there are none", () => {
    for (const [index] of PRESETS.entries()) {
      const view = viewOf(index);
      expect(view.changeCountLabel).toBe(
        view.lifeChanges.length > 0 ? `${view.lifeChanges.length} planned` : "",
      );
    }
  });
});

describe("abbreviateDollars", () => {
  it("abbreviates by magnitude and keeps the sign", () => {
    expect(abbreviateDollars(82_000)).toBe("$820");
    expect(abbreviateDollars(43_000_00)).toBe("$43k");
    expect(abbreviateDollars(1_240_000_00)).toBe("$1.24m");
    expect(abbreviateDollars(12_400_000_00)).toBe("$12.4m");
    expect(abbreviateDollars(-43_000_00)).toBe("-$43k");
  });
});
