import { describe, it, expect } from "vitest";
import { PLAN_DEFAULTS } from "./planDefaults";

describe("PLAN_DEFAULTS — home goal semantics (#150)", () => {
  it("the home down-payment goal is a `retain` savings goal, not a firing disposition", () => {
    // #150 removes the goal→use coupling: a savings goal must not require a purchase
    // event. The home goal flips `convertToEquity → retain`, so its fund simply
    // accumulates and stays in net worth — events, not dispositions, move money out.
    const home = PLAN_DEFAULTS.goals.find((g) => g.id === "home");
    expect(home).toBeDefined();
    expect(home?.disposition).toBe("retain");
    // Still a dated savings target (not "asap"): the down payment has a horizon.
    expect(home?.targetDate).toBe(60);
  });
});
