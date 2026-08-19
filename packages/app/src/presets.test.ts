import { describe, expect, it } from "vitest";
import { dollarsToCents, Projection } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
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
      "two-jobs",
      "career-break",
      "bonus",
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

  it("lands the bonus preset's adjustment on its job, with an id the ENGINE minted", () => {
    const preset = presetById("bonus");
    const job = presetState(preset).scenario.plan.primary.jobs[0];
    expect(job?.incomeOverrides).toEqual([
      { id: expect.any(String), month: 5, kind: "addBonus", cents: 2_000_000 },
    ]);
    // Nothing the preset itself wrote — the adjustment goes through the same authoring call the
    // Base + Adjustments editor makes, so the preset states only the month, kind and amount.
    expect(preset.incomeAdjustments?.[0]?.override).not.toHaveProperty("id");
  });

  it("refuses a preset that adjusts a job it never authored", () => {
    expect(() =>
      presetState({
        ...presetById("bonus"),
        incomeAdjustments: [{ jobIndex: 3, override: { month: 0, kind: "addBonus", cents: 100 } }],
      }),
    ).toThrow(/never authored/);
  });

  it("gives the two-jobs preset two concurrent jobs on the one person", () => {
    const jobs = presetState(presetById("two-jobs")).scenario.plan.primary.jobs;
    expect(jobs).toHaveLength(2);
    // Both owned by the same person: the multiple-jobs correction is person-scoped, and a preset
    // that split them across a household would demonstrate the opposite of what it claims to.
    expect(new Set(jobs.map((job) => job.ownerId)).size).toBe(1);
  });

  /**
   * The refund preset, pinned end to end.
   *
   * It exists to be looked at — it is the only scenario whose April hands money back at a scale a
   * chart can show — so the figures it produces are the ones manual QA compares against, and they
   * are held here rather than left to drift.
   */
  it("zeroes exactly the six unpaid months of the career-break preset", () => {
    const preset = presetById("career-break");
    const job = presetState(preset).scenario.plan.primary.jobs[0];
    expect(job?.incomeOverrides?.map((o) => o.month)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(job?.incomeOverrides?.every((o) => o.kind === "setTo" && o.cents === 0)).toBe(true);
  });

  it("turns that half-year into a visible April refund the following year", () => {
    const series = Projection.fromState(
      presetState(presetById("career-break")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    const april = series.months[15]!.flows!;
    // Big enough to read off a chart, and the only preset in that range: every other April is a
    // balance DUE, of a few dollars to a few hundred.
    expect(april.taxSettlementCents).toBe(-454_011);
    expect(-april.taxSettlementCents).toBeGreaterThan(dollarsToCents(3_000));
    expect(-april.taxSettlementCents).toBeLessThan(dollarsToCents(10_000));
    // The refund exceeds the month's own withholding, so `taxCents` itself goes NEGATIVE — the
    // shape that made the tax chart's clamp visible in the first place.
    expect(april.taxCents).toBeLessThan(0);
  });

  it("keeps April's own withholding and FICA intact behind that refund", () => {
    const series = Projection.fromState(
      presetState(presetById("career-break")),
      usJurisdiction,
    ).run(usJurisdiction).series;
    const [march, april, may] = [14, 15, 16].map((m) => series.months[m]!.flows!);
    // Pay is level either side, so April's own withholding is its neighbours' — the refund
    // settles a different year and must not touch it.
    const withheld = (f: typeof april) => f.taxCents - f.taxSettlementCents;
    expect(withheld(april!)).toBe(withheld(march!));
    expect(withheld(april!)).toBe(withheld(may!));
    expect(april!.payrollTaxCents).toBe(march!.payrollTaxCents);
  });

  it("stays solvent throughout, so the refund is not read against a plan collapsing under it", () => {
    const result = Projection.fromState(
      presetState(presetById("career-break")),
      usJurisdiction,
    ).run(usJurisdiction);
    expect(result.series.months.slice(0, 24).some((m) => m.isInsolvent)).toBe(false);
  });

  it("falls back to the default preset for an unknown id", () => {
    expect(presetById("missing")).toBe(PRESETS[0]);
  });
});
