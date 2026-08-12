/**
 * The solver's COST, not its answers (`retirementSolver.test.ts` owns those): one full
 * simulation per projection, and a logarithmic number of projections per search. The annual
 * federal-tax estimate is deliberately a cheap read of the compiled series rather than a replay
 * of the year, so it must not show up here as a second pass.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { projectScenario, solveRetirement } from "./retirementSolver";
import { scenarioOf } from "../plan/scenario";
import { samplePlan, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { mockJurisdiction } from "../testing/mockJurisdiction";
import type { ProjectionContext } from "../compile/projectionBase";

/** Hoisted with the factory below, which runs before any import binding exists. */
const counter = vi.hoisted(() => ({ passes: 0 }));

vi.mock("../projection/simulate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projection/simulate")>();
  return {
    ...actual,
    simulateHousehold: (...args: Parameters<typeof actual.simulateHousehold>) => {
      counter.passes++;
      return actual.simulateHousehold(...args);
    },
  };
});

const CTX: ProjectionContext = { jurisdiction: mockJurisdiction(), startYear: SAMPLE_START_YEAR };

beforeEach(() => {
  counter.passes = 0;
});

describe("retirementSolver — simulation passes", () => {
  it("costs exactly one simulation per projection", () => {
    projectScenario(scenarioOf(samplePlan), CTX);
    expect(counter.passes).toBe(1);
  });

  it("keeps the whole search logarithmic in the age range", () => {
    solveRetirement(scenarioOf(samplePlan), CTX);
    // A binary search over the ages [current, life expectancy], plus the feasibility probe and
    // the authored plan's own run. Pricing a candidate age twice would roughly double this.
    const ages =
      samplePlan.primary.lifeExpectancy - (SAMPLE_START_YEAR - samplePlan.primary.birthYear);
    expect(counter.passes).toBeLessThanOrEqual(Math.ceil(Math.log2(ages)) + 3);
  });
});
