/**
 * **A candidate stop-working age is a boundary, not a rewrite** — and it reaches every earner in
 * the household, including a partner whose jobs live on a `RelationshipEvent` rather than on the
 * plan.
 *
 * What is pinned here is the CAPPING half of the rule: which jobs a boundary shortens, and that
 * it shortens them wherever they were authored. The other half — the one job a boundary may run
 * PAST its authored end — is `retirementSolver.continuation.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { projectFullRetirement } from "./retirementSolver";
import {
  CTX,
  PRIMARY_BIRTH_YEAR,
  partnerJob,
  partnerSource,
  partnerWith,
  twoEarnerScenario,
} from "./retirementSolver.testUtils";

describe("retirementSolver — the stop-working boundary reaches every earner", () => {
  // A partner's jobs live on the RelationshipEvent, not on the plan, so a solve that rewrote
  // only the plan's own job list never ceased them — the household kept one earner working
  // past the stop-working age and the retirement answer was wrong for every two-earner
  // household. Deriving each job's end at compile time from a single boundary fixes it.
  it("a full stop ceases the partner's jobs too", () => {
    // Full stop at 50 → boundary calendar year birthYear + 50 = month (50 − 40) × 12 = 120.
    // Ten years later (month 240) neither earner draws a wage; the mock jurisdiction pays no
    // benefit, so any earned income here is a job the solve failed to stop.
    const series = projectFullRetirement(twoEarnerScenario(), 50, CTX);
    expect(series.months[240]?.flows?.totalIncomeCents).toBe(0);
  });

  describe("a boundary moves the LAST job either way, and only caps the rest", () => {
    it("extends a partner's last job when the candidate boundary is later", () => {
      // Their only job — so their last — is authored to end at month 60. Asking about retiring
      // at 70 (month 360) runs it on, because that is what "work until 70" means.
      const scenario = twoEarnerScenario(
        partnerWith({ jobs: [partnerJob({ endYear: PRIMARY_BIRTH_YEAR + 45 })] }),
      );
      const series = projectFullRetirement(scenario, 70, CTX);
      expect(partnerSource(series, 60)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(series, 359)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(series, 360)).toBeUndefined();
    });

    it("leaves an EARLIER job its own end, capping it and nothing more", () => {
      // Two jobs: one finishing at month 60, a later one running to 80. Only the later one is
      // the job they would still be holding, so only it is extended; the first keeps its end
      // and is not resurrected to fill the gap.
      const scenario = twoEarnerScenario(
        partnerWith({
          jobs: [
            partnerJob({ id: "pj1", endYear: PRIMARY_BIRTH_YEAR + 45 }),
            partnerJob({ id: "pj2", endYear: PRIMARY_BIRTH_YEAR + 80 }),
          ],
        }),
      );
      const series = projectFullRetirement(scenario, 70, CTX);
      const sourceAt = (month: number, id: string) =>
        (series.months[month]?.flows?.incomeSources ?? []).find((s) => s.sourceId === `job:${id}`);
      expect(sourceAt(59, "pj1")?.cashInflowCents).toBeGreaterThan(0);
      expect(sourceAt(60, "pj1")).toBeUndefined(); // its own end, untouched
      expect(sourceAt(300, "pj2")?.cashInflowCents).toBeGreaterThan(0); // the last job, capped at 70
      expect(sourceAt(360, "pj2")).toBeUndefined();
    });

    it("caps an earlier job when the candidate lands inside it", () => {
      const scenario = twoEarnerScenario(
        partnerWith({
          jobs: [
            partnerJob({ id: "pj1", endYear: PRIMARY_BIRTH_YEAR + 60 }),
            partnerJob({ id: "pj2", endYear: PRIMARY_BIRTH_YEAR + 80 }),
          ],
        }),
      );
      const series = projectFullRetirement(scenario, 50, CTX);
      const sourceAt = (month: number, id: string) =>
        (series.months[month]?.flows?.incomeSources ?? []).find((s) => s.sourceId === `job:${id}`);
      expect(sourceAt(119, "pj1")?.cashInflowCents).toBeGreaterThan(0);
      expect(sourceAt(120, "pj1")).toBeUndefined();
      expect(sourceAt(120, "pj2")).toBeUndefined();
    });

    it("the boundary can still SHORTEN a partner's job whose natural end is later than the candidate", () => {
      // The inverse direction still works: a partner authored to work to 80 (as in
      // partnerWithLateJob) really does stop early when the candidate boundary asks for it —
      // the boundary moves the last job in both directions.
      const series = projectFullRetirement(twoEarnerScenario(), 50, CTX);
      expect(partnerSource(series, 119)?.cashInflowCents).toBeGreaterThan(0);
      expect(partnerSource(series, 120)).toBeUndefined();
    });
  });

});
