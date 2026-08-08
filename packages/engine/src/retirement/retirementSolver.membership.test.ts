/**
 * **Household membership is a cap of its own, composed with everything else the solver applies.**
 *
 * A person's wages belong to THIS household only between joining it and leaving it. That is a
 * different fact from when they are employed and a different fact again from when a candidate
 * boundary would stop them, and the solver has to compose all three: a separation ends the income
 * without ending the employment, a boundary can shorten a membership-clipped job but never outlive
 * the separation, and a continuation that moves only employment moves no money at all.
 *
 * Also the household horizon — whose life expectancy a run ends at — because that too is decided
 * by who is in the household and when.
 */
import { describe, it, expect } from "vitest";
import {
  projectScenario,
  projectFullRetirement,
  solveRetirement,
  continuedJobsAt,
} from "./retirementSolver";
import { scenarioOf, withLedger } from "../plan/scenario";
import { addEvent } from "../ledger/addEvent";
import { emptyLedger } from "../ledger/ledger";
import { dollarsToCents } from "../money/cashFlowSeries";
import { createProjectionBase } from "../compile/projectionBase";
import { RETIREMENT_ID } from "../plan/ids";
import { samplePlan } from "../testing/samplePlan";
import type { Person } from "../plan/person";
import type { Job } from "../job/job";
import type { Scenario } from "../plan/scenario";
import {
  CTX,
  START_YEAR,
  CURRENT_AGE,
  PRIMARY_BIRTH_YEAR,
  BIRTH_YEAR,
  at,
  monthAt,
  planWithJobs,
  wageAt,
  partnerJob,
  partnerSource,
  partnerWith,
  twoEarnerScenario,
  type PartnerOverrides,
} from "./retirementSolver.testUtils";

describe("household membership is a cap of its own, composed with the rest", () => {
  /** The partner, deferring into the retirement account so a match rides on the same wage. */
  const deferringPartner = (endAge: number): Person =>
    partnerWith({
      jobs: [
        partnerJob({
          endYear: PRIMARY_BIRTH_YEAR + endAge,
          deferral: {
            deferralFraction: 0.1,
            fundAccountId: RETIREMENT_ID,
            employerMatchFraction: 0.5,
          },
        }),
      ],
    });

  /** Marry at month 0, separate at `separationMonth`. */
  function separatedScenario(partner: Person, separationMonth: number): Scenario {
    const base = createProjectionBase(samplePlan, CTX);
    const married = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
    const separated = addEvent(married.ledger, base, {
      id: "s1",
      type: "SeparationEvent",
      month: separationMonth,
      partnerPersonId: partner.id,
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
    return withLedger(scenarioOf(samplePlan), separated.ledger);
  }

  it("an ACTIVE partner pays the household every month of their membership window", () => {
    // Nothing to clip: an unseparated membership has no end, so the wage runs to the
    // partner's own natural end and every wage-derived quantity runs with it.
    const series = projectScenario(scenarioWithDeferringPartner(80), CTX);
    expect(partnerSource(series, 0)?.cashInflowCents).toBeGreaterThan(0);
    expect(partnerSource(series, 240)?.cashInflowCents).toBeGreaterThan(0);
    // Deferral stands in for the whole wage-derived chain here: the mock jurisdiction levies
    // no payroll tax, so a FICA assertion would pass whatever the window did.
    expect(series.months[240]?.flows?.deferralBySourceCents?.["job:pj1"]).toBeGreaterThan(0);
  });

  it("a SEPARATED partner stops paying the household at the separation, wages and everything derived from them", () => {
    // The membership ends at month 120 while the job itself runs to 80. Every wage-derived
    // quantity reads the same resolved window, so none of them survives the separation:
    // no wage, no payroll tax, no deferral — and no employer match, which exists only as a
    // fraction of a deferral that is no longer happening.
    const series = projectScenario(separatedScenario(deferringPartner(80), 120), CTX);
    expect(partnerSource(series, 119)?.cashInflowCents).toBeGreaterThan(0);
    expect(series.months[119]?.flows?.deferralBySourceCents?.["job:pj1"]).toBeGreaterThan(0);
    expect(partnerSource(series, 120)).toBeUndefined();
    expect(series.months[120]?.flows?.deferralBySourceCents?.["job:pj1"]).toBeUndefined();
  });

  it("a candidate boundary can shorten a membership-clipped job, never outlive the separation", () => {
    // Both caps in play at once. Separation at month 120; a full-stop candidate of 45 lands at
    // month 60, so the wage stops there — the boundary shortens. Raise the candidate to 70
    // (month 360) and the separation still ends it at 120: neither cap can extend past the
    // other, whichever is tighter.
    const scenario = separatedScenario(deferringPartner(80), 120);
    const shortened = projectFullRetirement(scenario, 45, CTX);
    expect(partnerSource(shortened, 59)?.cashInflowCents).toBeGreaterThan(0);
    expect(partnerSource(shortened, 60)).toBeUndefined();

    const late = projectFullRetirement(scenario, 70, CTX);
    expect(partnerSource(late, 119)?.cashInflowCents).toBeGreaterThan(0);
    expect(partnerSource(late, 120)).toBeUndefined();
  });

  function scenarioWithDeferringPartner(endAge: number): Scenario {
    return twoEarnerScenario(deferringPartner(endAge));
  }
});

/**
 * **A continuation is only a continuation where the household was PAID.**
 *
 * Employment and income are the same thing for a person who is in the household throughout,
 * which is why this went unnoticed: every fixture above has one. A partner's wages belong to
 * this household only between joining and separating, so extending their employment past an
 * authored end can move the employment span and not one cent of income — and a sentence
 * crediting the answer to that work describes a household that does not exist.
 */
describe("and only where the household was actually paid", () => {
  const PARTNER_ID = "p2";
  const partnerJobAt = (
    id: string,
    birthYear: number,
    startAge: number,
    endAge: number,
    annual = 60_000,
  ): Job => ({
    id,
    ownerId: PARTNER_ID,
    startYear: birthYear + startAge,
    endYear: birthYear + endAge,
    salary: {
      startingSalaryCents: dollarsToCents(annual),
      currentSalaryCents: dollarsToCents(annual),
      realGrowthPct: 0,
    },
  });

  const partnerWith = (opts: {
    birthYear?: number;
    jobs: readonly Job[];
    continuationJobId: string | null;
  }): Person => ({
    id: PARTNER_ID,
    name: "Partner",
    birthYear: opts.birthYear ?? BIRTH_YEAR,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: 67,
    jobs: opts.jobs,
    continuationJobId: opts.continuationJobId,
  });

  /**
   * The partner joins at `joinMonth` and, where one is given, leaves at `separationMonth`.
   * The PRIMARY selects None throughout, so every continuation these tests see is the
   * partner's and no second extension can account for what they assert.
   */
  function membershipScenario(
    partner: Person,
    opts: { joinMonth?: number; separationMonth?: number } = {},
  ): Scenario {
    const plan = planWithJobs(samplePlan.primary.jobs, null);
    const base = createProjectionBase(plan, CTX);
    const married = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: opts.joinMonth ?? 0,
      person: partner,
    });
    if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
    if (opts.separationMonth === undefined) return withLedger(scenarioOf(plan), married.ledger);
    const separated = addEvent(married.ledger, base, {
      id: "s1",
      type: "SeparationEvent",
      month: opts.separationMonth,
      partnerPersonId: PARTNER_ID,
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
    return withLedger(scenarioOf(plan), separated.ledger);
  }

  it("says nothing about a job whose owner had already left before its authored end", () => {
    // The bug, in its plainest shape. The partner's job is authored to 65 and they separate at
    // 60, so the household's last wage from it arrives at 60 whatever the candidate is.
    // Extending the employment to 70 adds employment and adds no money — and "you could stop
    // at 70 if their job continued through 70" would credit the answer to work that funded
    // none of it.
    const partner = partnerWith({
      jobs: [partnerJobAt("pjob", BIRTH_YEAR, 35, 65)],
      continuationJobId: "pjob",
    });
    const separated = membershipScenario(partner, { separationMonth: monthAt(60) });

    expect(continuedJobsAt(separated, 70, CTX)).toEqual([]);
    expect(solveRetirement(separated, CTX).continuedJobs).toEqual([]);

    // The same partner who never leaves DOES continue — so this is the separation talking,
    // not a fixture that could never have disclosed anything.
    const together = membershipScenario(partner);
    expect(continuedJobsAt(together, 70, CTX).map((c) => c.jobId)).toEqual(["pjob"]);
  });

  it("discloses a continuation only through the last month the household is paid for it", () => {
    // The partial case: the extension does add paid months, and then the separation ends them
    // early. What is disclosed is where the money stopped — 68 — and not the boundary the
    // employment ran to.
    const partner = partnerWith({
      jobs: [partnerJobAt("pjob", BIRTH_YEAR, 35, 65)],
      continuationJobId: "pjob",
    });
    const scenario = membershipScenario(partner, { separationMonth: monthAt(68) });

    const [continued] = continuedJobsAt(scenario, 70, CTX);
    expect(continued?.jobId).toBe("pjob");
    expect(continued?.throughAge).toBe(68);
    expect(continued?.throughYear).toBe(at(68));
    // Strictly inside the candidate: the household is told when it stops being paid, not when
    // the hypothesis stops running.
    expect(continued!.throughYear).toBeLessThan(at(70));
  });

  it("counts a continuation only from the JOIN, never from employment the household missed", () => {
    // A job authored to end before the partner even joined pays this household nothing as
    // authored, so every paid month the hypothesis produces is added — but only the ones
    // inside the membership. The overlap window is where that shows: it opens at the join,
    // not at the authored end five years earlier.
    const partner = partnerWith({
      jobs: [partnerJobAt("early", BIRTH_YEAR, 20, 35), partnerJobAt("later", BIRTH_YEAR, 35, 55)],
      continuationJobId: "early",
    });
    const joined = membershipScenario(partner, { joinMonth: monthAt(45) });

    const [continued] = continuedJobsAt(joined, 70, CTX);
    expect(continued?.jobId).toBe("early");
    expect(continued?.throughAge).toBe(70);
    expect(continued?.overlaps).toEqual([
      {
        jobId: "later",
        jobLabel: "Partner's job 2",
        jobName: null,
        fromAge: 45,
        toAge: 55,
        fromYear: at(45),
        toYear: at(55),
      },
    ]);

    // And it really tracks the join: the same partner in the household from the start is paid
    // for those years, so the window opens at "now" instead.
    const [fromTheStart] = continuedJobsAt(membershipScenario(partner), 70, CTX);
    expect(fromTheStart?.overlaps[0]?.fromYear).toBe(START_YEAR);
    expect(fromTheStart?.overlaps[0]?.fromAge).toBe(CURRENT_AGE);
  });

  it("reports no overlap where two jobs overlap as EMPLOYMENT but not as household income", () => {
    // Both spans cross on paper — the continued job runs to 70 and the later one is authored
    // 50–60 — and the household is paid for neither crossing, because it is paid for the later
    // job not at all: the partner separates the year it starts. Measured on employment this
    // reports a ten-year doubling of income that never happens.
    const partner = partnerWith({
      jobs: [partnerJobAt("early", BIRTH_YEAR, 20, 35), partnerJobAt("late", BIRTH_YEAR, 50, 60)],
      continuationJobId: "early",
    });
    const scenario = membershipScenario(partner, { separationMonth: monthAt(50) });

    const [continued] = continuedJobsAt(scenario, 70, CTX);
    expect(continued?.jobId).toBe("early");
    expect(continued?.overlaps).toEqual([]);
    // Paid to the separation and no further.
    expect(continued?.throughAge).toBe(50);
  });

  it("states a genuine overlap in the OWNER's ages and the shared calendar years", () => {
    // The case that must keep working, and the one where the two clocks visibly disagree: a
    // partner five years older, joining part-way through. Every age here is theirs, every year
    // is the household's, and the pair is what lets a reader reconcile them.
    const partnerBirthYear = BIRTH_YEAR - 5;
    const partner = partnerWith({
      birthYear: partnerBirthYear,
      jobs: [
        partnerJobAt("long", partnerBirthYear, 30, 60),
        partnerJobAt("second", partnerBirthYear, 55, 65),
      ],
      continuationJobId: "long",
    });
    const scenario = membershipScenario(partner, { joinMonth: monthAt(45) });

    const [continued] = continuedJobsAt(scenario, 70, CTX);
    expect(continued?.ownerName).toBe("Partner");
    expect(continued?.jobId).toBe("long");
    // The candidate is the PRIMARY's 70 — the same calendar year is the partner's 75.
    expect(continued?.throughYear).toBe(at(70));
    expect(continued?.throughAge).toBe(75);
    expect(continued?.overlaps).toEqual([
      {
        jobId: "second",
        jobLabel: "Partner's job 2",
        jobName: null,
        fromAge: 60,
        toAge: 65,
        fromYear: partnerBirthYear + 60,
        toYear: partnerBirthYear + 65,
      },
    ]);
  });

  it("stops two differently-aged earners at ONE calendar boundary, each disclosed in their own years", () => {
    // One household, one stop — the boundary is a calendar year precisely so a five-year age
    // gap cannot make the two of them retire at different moments. The headline stays the
    // primary's age; each continued job is stated in its owner's, once, with no second copy
    // to contradict it.
    const partnerBirthYear = BIRTH_YEAR - 5;
    const partner = partnerWith({
      birthYear: partnerBirthYear,
      jobs: [partnerJobAt("theirs", partnerBirthYear, 30, 60)],
      continuationJobId: "theirs",
    });
    const base = createProjectionBase(planWithJobs(samplePlan.primary.jobs, "job-main"), CTX);
    const married = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
    const scenario = withLedger(
      scenarioOf(planWithJobs(samplePlan.primary.jobs, "job-main")),
      married.ledger,
    );

    const continued = continuedJobsAt(scenario, 70, CTX);
    expect(continued.map((c) => c.ownerId)).toEqual(["p1", PARTNER_ID]);
    // One owner, one sentence: nothing is disclosed twice.
    expect(new Set(continued.map((c) => c.ownerId)).size).toBe(continued.length);
    // The same calendar year for both, and each in their own age — 70 and 75.
    expect(continued.map((c) => c.throughYear)).toEqual([at(70), at(70)]);
    expect(continued.map((c) => c.throughAge)).toEqual([70, 75]);

    // And the projection really does stop them together, in that year.
    const series = projectFullRetirement(scenario, 70, CTX);
    expect(wageAt(series, "job-main", monthAt(70) - 1)).toBeGreaterThan(0);
    expect(wageAt(series, "theirs", monthAt(70) - 1)).toBeGreaterThan(0);
    expect(wageAt(series, "job-main", monthAt(70))).toBe(0);
    expect(wageAt(series, "theirs", monthAt(70))).toBe(0);
  });
});

describe("solveRetirement — horizonAnchor names the longest-lived member", () => {
  // samplePlan: primary age 40, expectancy 85. The anchor is whose expectancy the run ends at.
  const anchorOf = (scenario: Scenario) => solveRetirement(scenario, CTX).horizonAnchor;

  const samPartner = (over: PartnerOverrides): Person => ({
    id: "p2",
    name: "Sam",
    birthYear: PRIMARY_BIRTH_YEAR,
    lifeExpectancy: samplePlan.primary.lifeExpectancy,
    benefitClaimingAge: 67,
    jobs: [],
    ...over,
  });

  function withPartner(partner: Person, separateAtMonth?: number): Scenario {
    const base = createProjectionBase(samplePlan, CTX);
    const married = addEvent(emptyLedger, base, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: partner,
    });
    if (!married.ok) throw new Error(`fixture rejected: ${married.conflict}`);
    let ledger = married.ledger;
    if (separateAtMonth !== undefined) {
      const separated = addEvent(ledger, base, {
        id: "s1",
        type: "SeparationEvent",
        month: separateAtMonth,
        partnerPersonId: partner.id,
        alimonyMonthlyCents: 0,
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: 0,
      });
      if (!separated.ok) throw new Error(`fixture rejected: ${separated.conflict}`);
      ledger = separated.ledger;
    }
    return withLedger(scenarioOf(samplePlan), ledger);
  }

  it("names the primary (null) when nobody outlives them", () => {
    expect(anchorOf(scenarioOf(samplePlan))).toEqual({ age: 85, memberName: null });
  });

  it("names a younger partner who outlives the primary, at their own stated expectancy", () => {
    // Born 10 years after the primary, same expectancy age 85 → reaches it in a later calendar
    // year, so the run ends at Sam's 85, not the primary's.
    expect(anchorOf(withPartner(samPartner({ birthYear: PRIMARY_BIRTH_YEAR + 10 })))).toEqual({
      age: 85,
      memberName: "Sam",
    });
  });

  it("honours a partner's own stated expectancy over the household default", () => {
    expect(
      anchorOf(withPartner(samPartner({ birthYear: PRIMARY_BIRTH_YEAR + 10, lifeExpectancy: 95 }))),
    ).toEqual({ age: 95, memberName: "Sam" });
  });

  it("falls back to the primary when the partner would die first", () => {
    expect(anchorOf(withPartner(samPartner({ birthYear: PRIMARY_BIRTH_YEAR - 10 })))).toEqual({
      age: 85,
      memberName: null,
    });
  });

  // The anchor names whoever the SIM ran to, so it applies the same both-alive rule
  // (`memberHorizonReach`) that `buildHouseholdInput` does. Sam is born ten years after the
  // primary at the same expectancy 85, so the primary dies at month 540 and Sam at 660, and the
  // boundary a separation has to beat is the primary's 540.
  describe("a separation removes the anchor only while both are alive", () => {
    const younger = () => samPartner({ birthYear: PRIMARY_BIRTH_YEAR + 10 });
    const PRIMARY_DEATH_MONTH = (85 - 40) * 12; // 540

    it("BEFORE either death: Sam leaves, so the primary anchors", () => {
      expect(anchorOf(withPartner(younger(), 12))).toEqual({ age: 85, memberName: null });
      expect(anchorOf(withPartner(younger(), PRIMARY_DEATH_MONTH - 1))).toEqual({
        age: 85,
        memberName: null,
      });
    });

    it("EXACTLY AT the first death: too late to happen, so Sam still anchors", () => {
      expect(anchorOf(withPartner(younger(), PRIMARY_DEATH_MONTH))).toEqual({
        age: 85,
        memberName: "Sam",
      });
    });

    it("AFTER the first death: Sam anchors — they never left while alive", () => {
      expect(anchorOf(withPartner(younger(), 600))).toEqual({ age: 85, memberName: "Sam" });
      expect(anchorOf(withPartner(younger(), 700))).toEqual({ age: 85, memberName: "Sam" });
    });
  });
});
