import { describe, expect, it, vi } from "vitest";
import { retirementView } from "./retirementView";

const continuedJobs = [
  {
    jobId: "job-1",
    jobLabel: "Alex's job",
    jobName: null,
    ownerId: "primary",
    ownerName: "Alex",
    throughAge: 68,
    throughYear: 2059,
    overlaps: [],
  },
] as any;

function source(overrides: Record<string, unknown> = {}) {
  const answer = {
    solution: {
      fullRetirementAge: 64,
      blocked: false,
      plannedWorkStopAge: 65,
      authoredPlanSurvives: true,
      continuedJobs,
      horizonAnchor: { age: 90, memberName: null },
    },
    fullRetirementMonth: 348,
    blockedAtAge: null,
    earlyRetireeHealth: {
      flagged: true,
      gapYears: 1,
      shortfallMonthlyCents: 60_000,
    },
    ...overrides,
  };
  return { retirement: vi.fn(() => answer) } as any;
}

describe("retirementView", () => {
  it("reads the public retirement answer once and maps it without recomputing it", () => {
    const projection = source();

    expect(retirementView(projection)).toEqual({
      headlineAge: 64,
      headlineMonth: 348,
      blocked: false,
      blockedAtAge: null,
      plannedWorkStopAge: 65,
      authoredPlanSurvives: true,
      earlyRetireeHealth: {
        flagged: true,
        gapYears: 1,
        shortfallMonthlyCents: 60_000,
      },
      continuedJobs,
      horizonAge: 90,
      horizonMemberName: null,
    });
    expect(projection.retirement).toHaveBeenCalledTimes(1);
  });

  it("preserves a blocked answer instead of inventing a retirement headline", () => {
    const projection = source({
      solution: {
        fullRetirementAge: null,
        blocked: true,
        plannedWorkStopAge: 65,
        authoredPlanSurvives: false,
        continuedJobs: [],
        horizonAnchor: { age: 92, memberName: "Sam" },
      },
      fullRetirementMonth: null,
      blockedAtAge: 47,
      earlyRetireeHealth: { flagged: false, gapYears: 0, shortfallMonthlyCents: 0 },
    });

    expect(retirementView(projection)).toMatchObject({
      headlineAge: null,
      headlineMonth: null,
      blocked: true,
      blockedAtAge: 47,
      horizonAge: 92,
      horizonMemberName: "Sam",
    });
  });

  it("preserves an infeasible but unblocked answer", () => {
    const projection = source({
      solution: {
        fullRetirementAge: null,
        blocked: false,
        plannedWorkStopAge: null,
        authoredPlanSurvives: false,
        continuedJobs: [],
        horizonAnchor: { age: 90, memberName: null },
      },
      fullRetirementMonth: null,
      blockedAtAge: null,
      earlyRetireeHealth: { flagged: false, gapYears: 0, shortfallMonthlyCents: 0 },
    });

    expect(retirementView(projection)).toMatchObject({
      headlineAge: null,
      blocked: false,
      blockedAtAge: null,
      plannedWorkStopAge: null,
      authoredPlanSurvives: false,
    });
  });

  it("passes the jurisdiction through to the facade call", () => {
    const projection = source();
    const jurisdiction = { id: "test" } as any;

    retirementView(projection, jurisdiction);

    expect(projection.retirement).toHaveBeenCalledWith(jurisdiction);
  });
});
