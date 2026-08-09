import { describe, expect, it } from "vitest";
import { PRESETS, presetById, presetState } from "./presets";
import { DEFAULT_INPUT, PLAN_DEFAULTS } from "./planDefaults";

const expenseTotal = (preset: (typeof PRESETS)[number]) =>
  (preset.input.budgetLines ?? []).reduce(
    (sum, line) =>
      sum +
      (line.target.kind === "expense" && line.amountSource.kind === "literal"
        ? line.amountSource.monthlyCents
        : 0),
    0,
  );

describe("presets", () => {
  it("offers the intended starter scenarios with user-facing labels and descriptions", () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      "default",
      "paycheck-to-paycheck",
      "living-on-credit",
      "student-loan",
      "taxed-in-retirement",
    ]);
    for (const preset of PRESETS) {
      expect(preset.label).not.toBe("");
      expect(preset.description).not.toBe("");
    }
  });

  it("uses the same authored input as the fresh default instead of maintaining a second default", () => {
    expect(presetById("default").input).toBe(DEFAULT_INPUT);
    expect(presetState(presetById("default")).scenario.plan).toEqual(PLAN_DEFAULTS);
  });

  it("keeps each teaching scenario's authored budget non-empty", () => {
    for (const preset of PRESETS) {
      expect(preset.input.budgetLines?.length ?? 0).toBeGreaterThan(0);
      expect(expenseTotal(preset)).toBeGreaterThan(0);
    }
  });

  it("authors only the student-loan preset with a seed timeline event", () => {
    const withEvents = PRESETS.filter((preset) => (preset.input.events?.length ?? 0) > 0);
    expect(withEvents.map((preset) => preset.id)).toEqual(["student-loan"]);
    expect(withEvents[0].input.events?.[0]).toMatchObject({
      type: "takeLoan",
      kind: "studentLoan",
      month: 0,
    });
  });

  it("builds every preset through the public scenario-input path", () => {
    for (const preset of PRESETS) {
      const state = presetState(preset);
      expect(state.scenario.plan.primary.name).toBe(preset.input.name);
    }
  });

  it("falls back to the default preset for an unknown id", () => {
    expect(presetById("missing")).toBe(PRESETS[0]);
  });
});
