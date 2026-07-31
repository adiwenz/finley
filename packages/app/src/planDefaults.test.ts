import { describe, it, expect } from "vitest";
import { PLAN_DEFAULTS } from "./planDefaults";

describe("PLAN_DEFAULTS — home goal semantics (#150)", () => {
  it("the home down-payment goal is a `retain` savings goal, not a firing disposition", () => {
    // A savings goal must not require a purchase event. `retain` (not `convertToEquity`)
    // just accumulates and stays in net worth — events, not dispositions, move money out.
    const home = PLAN_DEFAULTS.goals.find((g) => g.name === "Home down payment");
    expect(home).toBeDefined();
    expect(home?.disposition).toBe("retain");
    // Still a dated savings target (not "asap"): the down payment has a horizon.
    expect(home?.targetDate).toBe(60);
  });
});

describe("PLAN_DEFAULTS — engine-minted identity", () => {
  it("carries no hand-authored ids: the job and goals are minted through the engine", () => {
    // The default plan is authored ID-free and built through `Projection.fromInput`, so the
    // one authority for identity is the engine's counter — not the `job-1`/`emergency`/`home`
    // strings the plan used to hardcode.
    expect(PLAN_DEFAULTS.jobs.map((j) => j.id)).not.toContain("job-1");
    expect(PLAN_DEFAULTS.goals.map((g) => g.id)).not.toContain("emergency");
    expect(PLAN_DEFAULTS.goals.map((g) => g.id)).not.toContain("home");
    // Every id matches the `${kind}-N` shape the counter issues.
    expect(PLAN_DEFAULTS.jobs[0]!.id).toMatch(/^job-\d+$/);
    for (const goal of PLAN_DEFAULTS.goals) expect(goal.id).toMatch(/^goal-\d+$/);
  });
});
