/**
 * The `Projection` root over jobs: editing and removing them, the partner's plane, pay changes
 * and one-month income overrides, and naming the continuation job a what-if may resume.
 */
import { describe, it, expect } from "vitest";
import { Projection } from "../index";
import { samplePlan, stateOf, SAMPLE_START_YEAR } from "../testing/samplePlan";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { dollarsToCents } from "../money/cashFlowSeries";
import { type PersonId } from "../job/job";
import { P1, freshProjection, JOB_END_YEAR, plainJob, partnerEvent } from "../testing/projectionFacadeFixtures";

describe("Projection root — editing and removing a job", () => {
  const matchedJob = {
    ...plainJob,
    name: "Day job",
    deferral: { deferralFraction: 0.1, fundAccountId: "retirement", employerMatchFraction: 0.5 },
  } as const;

  it("restates only the named fields, carrying the rest of the job through", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, matchedJob);
    const raise = p.addJobPayChange(jobId, {
      month: 12,
      kind: "changeBy",
      cents: dollarsToCents(500),
    });

    // Spread the job read back and restate two fields: replaceJob rewrites wholesale, so the
    // spread is what carries the unnamed fields — including the pay change — through.
    const job = p.plan.primary.jobs[0]!;
    p.replaceJob(jobId, { ...job, name: "Night job", endYear: SAMPLE_START_YEAR + 10 });

    expect(p.plan.primary.jobs[0]).toMatchObject({
      id: jobId,
      name: "Night job",
      endYear: SAMPLE_START_YEAR + 10,
      // Everything the spread carried survives — including what only the adjustment methods
      // author.
      ownerId: P1,
      salary: matchedJob.salary,
      deferral: matchedJob.deferral,
      // The adjustment keeps the id it was minted with; restating other fields cannot
      // re-identify what was already authored.
      payChanges: [{ id: raise, month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
  });

  it("keeps a job's owner through an edit — a job cannot change owner", () => {
    // The one way to move a job between members is delete-and-re-add. `JobInput` omits `ownerId`
    // (`Omit<Job, "id" | "ownerId">`), so even a wholesale replace cannot restate it — the engine
    // re-stamps the owner off the prior record — and the owner it was created with is preserved.
    const p = freshProjection();
    p.marry({ month: 24, name: "Partner", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy });
    const jobId = p.addJob(P1, plainJob);
    const job = p.plan.primary.jobs[0]!;
    p.replaceJob(jobId, { ...job, name: "Renamed", endYear: SAMPLE_START_YEAR + 10 });
    expect(p.plan.primary.jobs[0]?.ownerId).toBe(P1);
  });

  it("removes a job, leaving the others alone", () => {
    const p = freshProjection();
    const keep = p.addJob(P1, plainJob);
    p.removeJob(p.addJob(P1, plainJob));
    expect(p.plan.primary.jobs.map((j) => j.id)).toEqual([keep]);
  });

  it("refuses an id the plan does not hold, rather than reporting a write it did not make", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const before = p.state;

    expect(() => p.replaceJob("no-such-job", plainJob)).toThrow(/no job "no-such-job"/);
    expect(() => p.removeJob("no-such-job")).toThrow(/no job "no-such-job"/);

    // Same state object throughout: a refusal commits nothing.
    expect(p.state).toBe(before);
    expect(p.plan.primary.jobs.map((j) => j.id)).toEqual([jobId]);
  });

  it("refuses a partner's job id on the plan plane, and the reverse", () => {
    // The two families do not reach across: a job is authored where its owner is, and asking
    // the wrong plane is the same caller error as asking for a job that does not exist.
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy });
    const planJob = p.addJob(P1, plainJob);
    const partnerJob = p.addPartnerJob(partnerId, plainJob);

    expect(() => p.replaceJob(partnerJob, plainJob)).toThrow(/no job/);
    expect(() => p.replacePartnerJob(planJob, plainJob)).toThrow(/no partner holds a job/);
  });

  it("a job stated in one monthly figure stores that annualized on both salary anchors", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const monthlyCents = dollarsToCents(9000);
    // Stating one salary means a flat history: both anchors take the same annualized figure, so
    // the historical reconstruction and the current-salary anchor agree until a pay change parts
    // them. The unnamed `realGrowthPct` rides the salary spread through.
    const job = p.plan.primary.jobs[0]!;
    p.replaceJob(jobId, {
      ...job,
      salary: {
        ...job.salary,
        startingSalaryCents: monthlyCents * 12,
        currentSalaryCents: monthlyCents * 12,
      },
    });
    expect(p.plan.primary.jobs[0]?.salary).toEqual({
      startingSalaryCents: dollarsToCents(9000) * 12,
      currentSalaryCents: dollarsToCents(9000) * 12,
      // The growth rate is not part of "what it pays now".
      realGrowthPct: 0,
    });
  });

  it("carries every input field onto an added job, not just the ones a new job is authored from", () => {
    const p = freshProjection();
    // What a job moving between household members arrives holding: an existing job's
    // accumulated adjustments, not a blank draft's fields.
    const jobId = p.addJob(P1, {
      ...matchedJob,
      incomeOverrides: [{ id: "adjustment-39", month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ id: "adjustment-40", month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
    expect(p.plan.primary.jobs[0]).toMatchObject({
      id: jobId,
      name: "Day job",
      deferral: matchedJob.deferral,
      incomeOverrides: [{ id: "adjustment-39", month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ id: "adjustment-40", month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
  });

  it("replaceJob rewrites wholesale, so an absent field CLEARS rather than carrying through", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, matchedJob);

    // The same form re-submitted with the name blanked and the 401(k) rate zeroed. A field-wise
    // patch could not say this: omitting `deferral` would mean "leave it as it was".
    p.replaceJob(jobId, plainJob);

    expect(p.plan.primary.jobs[0]).toEqual({
      id: jobId,
      // Identity survives the rewrite; the owner is not a field an edit restates.
      ownerId: P1,
      startYear: plainJob.startYear,
      endYear: JOB_END_YEAR,
      // Stated by the input, so it survives the rewrite like any other field it names.
      salary: plainJob.salary,
    });
  });

  it("keeps one job-id namespace across both planes", () => {
    // No caller can supply a job id, so a duplicate cannot be authored — but the two planes
    // must still draw from ONE counter, since a job's id keys its income band whichever plane
    // it sits on.
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Partner", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy });
    const ids = [
      p.addJob(P1, plainJob),
      p.addPartnerJob(partnerId, plainJob),
      p.addJob(P1, plainJob),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    // Two on the plan, one on the partner's event — three distinct ids from one counter.
    expect(p.plan.primary.jobs).toHaveLength(2);
    expect(partnerEvent(p).person.jobs).toHaveLength(1);
  });

  it("replaceJob keeps the job's list position, and refuses an unknown id", () => {
    const p = freshProjection();
    const first = p.addJob(P1, plainJob);
    const second = p.addJob(P1, plainJob);
    p.replaceJob(first, { ...plainJob, name: "Renamed" });
    expect(() => p.replaceJob("no-such-job", { ...plainJob, name: "Nowhere" })).toThrow(
      /no job "no-such-job"/,
    );
    expect(p.plan.primary.jobs.map((j) => j.id)).toEqual([first, second]);
    expect(p.plan.primary.jobs.map((j) => j.name)).toEqual(["Renamed", undefined]);
  });
});

describe("Projection root — jobs on a partner's plane", () => {
  const matchedJob = {
    ...plainJob,
    name: "Day job",
    deferral: { deferralFraction: 0.1, fundAccountId: "retirement", employerMatchFraction: 0.5 },
  } as const;

  /** A projection holding one partner, and that partner's id. */
  function withPartner(): { p: Projection; partnerId: PersonId } {
    const p = freshProjection();
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy }) as PersonId;
    return { p, partnerId };
  }

  const partnerJobs = (p: Projection) => partnerEvent(p).person.jobs;

  it("adds a job to a partner, minting off the SAME counter the plan plane mints from", () => {
    const { p, partnerId } = withPartner();
    const planJobId = p.addJob(P1, plainJob);
    const partnerJobId = p.addPartnerJob(partnerId, plainJob);

    // One run of ids, not a per-owner namespace: the partner's is `job-N`, and it is a
    // number the plan plane will never issue again.
    expect(partnerJobId).toMatch(/^job-\d+$/);
    expect(partnerJobId).not.toBe(planJobId);
    expect(p.addJob(P1, plainJob)).not.toBe(partnerJobId);

    // It landed on the partner's event, owned by them — and nowhere near the plan.
    expect(partnerJobs(p).map((j) => j.id)).toEqual([partnerJobId]);
    expect(partnerJobs(p)[0]?.ownerId).toBe(partnerId);
    expect(p.plan.primary.jobs.map((j) => j.id)).toEqual([planJobId, expect.any(String)]);
  });

  it("carries every input field onto a partner's job", () => {
    const { p, partnerId } = withPartner();
    const jobId = p.addPartnerJob(partnerId, {
      ...matchedJob,
      incomeOverrides: [{ id: "adjustment-43", month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ id: "adjustment-44", month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
    expect(partnerJobs(p)[0]).toMatchObject({
      id: jobId,
      name: "Day job",
      deferral: matchedJob.deferral,
      incomeOverrides: [{ id: "adjustment-43", month: 6, kind: "addBonus", cents: dollarsToCents(5000) }],
      payChanges: [{ id: "adjustment-44", month: 12, kind: "changeBy", cents: dollarsToCents(500) }],
    });
  });

  it("restates a partner's job field-wise, and replaces it wholesale", () => {
    const { p, partnerId } = withPartner();
    const jobId = p.addPartnerJob(partnerId, matchedJob);

    // Spread the job read off the partner's event and restate one field; the deferral it does
    // not name rides the spread through.
    const job = partnerJobs(p)[0]!;
    p.replacePartnerJob(jobId, { ...job, name: "Night job" });
    expect(partnerJobs(p)[0]).toMatchObject({
      name: "Night job",
      deferral: matchedJob.deferral, // unnamed, so carried through
    });

    // Replace states the whole job, so the fields it omits are gone.
    p.replacePartnerJob(jobId, plainJob);
    expect(partnerJobs(p)[0]).toEqual({
      id: jobId,
      ownerId: partnerId,
      startYear: plainJob.startYear,
      endYear: JOB_END_YEAR,
      // Stated by the input, so it survives the rewrite like any other field it names.
      salary: plainJob.salary,
    });
  });

  it("keeps a partner's other jobs and their order across an edit", () => {
    const { p, partnerId } = withPartner();
    const first = p.addPartnerJob(partnerId, plainJob);
    const second = p.addPartnerJob(partnerId, plainJob);
    const job = partnerJobs(p).find((j) => j.id === first)!;
    p.replacePartnerJob(first, { ...job, name: "Renamed" });
    expect(partnerJobs(p).map((j) => j.id)).toEqual([first, second]);
    expect(partnerJobs(p).map((j) => j.name)).toEqual(["Renamed", undefined]);
  });

  it("removes a partner's job, leaving the plan and their other jobs alone", () => {
    const { p, partnerId } = withPartner();
    const planJob = p.addJob(P1, plainJob);
    const keep = p.addPartnerJob(partnerId, plainJob);
    p.removePartnerJob(p.addPartnerJob(partnerId, plainJob));

    expect(partnerJobs(p).map((j) => j.id)).toEqual([keep]);
    expect(p.plan.primary.jobs.map((j) => j.id)).toEqual([planJob]);
  });

  it("refuses a partner or a job it cannot find, rather than writing nothing quietly", () => {
    const { p } = withPartner();
    expect(() => p.addPartnerJob("nobody" as PersonId, plainJob)).toThrow(/no partner/);
    expect(() => p.replacePartnerJob("job-99", plainJob)).toThrow(/no partner holds a job/);
    expect(() => p.removePartnerJob("job-99")).toThrow(/no partner holds a job/);
  });

  it("leaves the state untouched when the revision is refused", () => {
    const { p, partnerId } = withPartner();
    p.addPartnerJob(partnerId, plainJob);
    const before = p.state;
    expect(() => p.addPartnerJob("nobody" as PersonId, plainJob)).toThrow();
    // Same state object: a refused write consumes no id and commits nothing.
    expect(p.state).toBe(before);
  });
});

describe("Projection root — pay changes and one-month income overrides", () => {
  it("attaches a pay change and replaces one already at that month", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9000) });
    p.addJobPayChange(jobId, { month: 24, kind: "changeBy", cents: dollarsToCents(500) });
    // Re-authoring the same month replaces rather than stacking: a pay change opens a salary
    // segment, and two segments beginning together is a contradiction, not a stack.
    p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9500) });

    expect(p.plan.primary.jobs[0]?.payChanges).toEqual([
      { id: expect.any(String), month: 24, kind: "changeBy", cents: dollarsToCents(500) },
      { id: expect.any(String), month: 12, kind: "setTo", cents: dollarsToCents(9500) },
    ]);
  });

  it("mints an id for every adjustment, off the same counter as everything else", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const raise = p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9000) });
    const bonus = p.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 100 });

    // Distinct from each other and from the job's own id — one counter issues all three.
    expect(new Set([jobId, raise, bonus]).size).toBe(3);
    expect(p.plan.primary.jobs[0]?.payChanges?.[0]?.id).toBe(raise);
    expect(p.plan.primary.jobs[0]?.incomeOverrides?.[0]?.id).toBe(bonus);
  });

  it("removes a pay change by id, dropping the field once none are left", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const first = p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9000) });
    const second = p.addJobPayChange(jobId, { month: 24, kind: "setTo", cents: dollarsToCents(9500) });

    p.removeJobPayChange(jobId, first);
    expect(p.plan.primary.jobs[0]?.payChanges).toEqual([
      { id: second, month: 24, kind: "setTo", cents: dollarsToCents(9500) },
    ]);

    p.removeJobPayChange(jobId, second);
    expect(p.plan.primary.jobs[0]).not.toHaveProperty("payChanges");
  });

  it("attaches a one-month override and removes it, dropping the field once empty", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const bonus = p.addJobIncomeOverride(jobId, {
      month: 6,
      kind: "addBonus",
      cents: dollarsToCents(5000),
    });
    expect(p.plan.primary.jobs[0]?.incomeOverrides).toEqual([
      { id: bonus, month: 6, kind: "addBonus", cents: dollarsToCents(5000) },
    ]);

    p.removeJobIncomeOverride(jobId, bonus);
    expect(p.plan.primary.jobs[0]).not.toHaveProperty("incomeOverrides");
  });

  it("stacks several one-month adjustments in one month, each keeping its own identity", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const signing = p.addJobIncomeOverride(jobId, {
      month: 6,
      kind: "addBonus",
      cents: dollarsToCents(5000),
    });
    const performance = p.addJobIncomeOverride(jobId, {
      month: 6,
      kind: "addBonus",
      cents: dollarsToCents(2000),
    });

    // Two payments in one month is an ordinary fact. The second must not displace the first —
    // that displacement is what made a second bonus erase the first everywhere it was listed.
    expect(p.plan.primary.jobs[0]?.incomeOverrides).toEqual([
      { id: signing, month: 6, kind: "addBonus", cents: dollarsToCents(5000) },
      { id: performance, month: 6, kind: "addBonus", cents: dollarsToCents(2000) },
    ]);
    expect(signing).not.toBe(performance);
  });

  it("removes one of a month's stacked adjustments and leaves its siblings alone", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const first = p.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 100 });
    const second = p.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 200 });
    const third = p.addJobIncomeOverride(jobId, { month: 6, kind: "setTo", cents: 900 });

    p.removeJobIncomeOverride(jobId, second);

    // By id, so the month keeps the other two. Removing by month would have taken all three.
    expect(p.plan.primary.jobs[0]?.incomeOverrides?.map((o) => o.id)).toEqual([first, third]);
  });

  it("keeps adjustment ids stable across an unrelated edit to the same job", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const raise = p.addJobPayChange(jobId, { month: 12, kind: "setTo", cents: dollarsToCents(9000) });
    const bonus = p.addJobIncomeOverride(jobId, { month: 6, kind: "addBonus", cents: 100 });

    // Two unrelated edits, each a spread-and-replace: the pay change and override ride the spread
    // through, keeping the ids they were minted with.
    const renamed = p.plan.primary.jobs[0]!;
    p.replaceJob(jobId, { ...renamed, name: "Renamed" });
    const nowPaid = p.plan.primary.jobs[0]!;
    p.replaceJob(jobId, {
      ...nowPaid,
      salary: { ...nowPaid.salary, currentSalaryCents: dollarsToCents(8000) * 12 },
    });

    expect(p.plan.primary.jobs[0]?.payChanges?.map((c) => c.id)).toEqual([raise]);
    expect(p.plan.primary.jobs[0]?.incomeOverrides?.map((o) => o.id)).toEqual([bonus]);
  });

  it("removing an adjustment that is not there leaves the job untouched", () => {
    const p = freshProjection();
    const jobId = p.addJob(P1, plainJob);
    const before = p.plan.primary.jobs[0];
    p.removeJobPayChange(jobId, "adjustment-nope");
    p.removeJobIncomeOverride(jobId, "adjustment-nope");
    expect(p.plan.primary.jobs[0]).toEqual(before);
  });
});

describe("Projection.setContinuationJob — naming the job a what-if may continue", () => {
  it("writes the primary's answer where the primary's data lives — the plan", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }), nullJurisdiction);
    const jobId = p.addJob("p1" as PersonId, plainJob);

    // Unset until asked: "never chosen" is a state the engine resolves on read, so authoring a
    // job must not quietly settle it.
    expect(p.plan.primary.continuationJobId).toBeUndefined();

    p.setContinuationJob("p1" as PersonId, jobId);
    expect(p.plan.primary.continuationJobId).toBe(jobId);

    p.setContinuationJob("p1" as PersonId, null);
    expect(p.plan.primary.continuationJobId).toBeNull();
  });

  it("writes a partner's answer to their RelationshipEvent, through the same method", () => {
    // A caller names the person and nothing else. Which plane their record lives on is the
    // facade's to know — the same thing that makes `addJob` and `addPartnerJob` two methods is
    // deliberately NOT surfaced here, because this writes the person, not the job.
    const p = Projection.fromState(stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }), nullJurisdiction);
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy }) as PersonId;
    const partnerJobId = p.addPartnerJob(partnerId, plainJob);

    p.setContinuationJob(partnerId, partnerJobId);
    expect(partnerEvent(p).person.continuationJobId).toBe(partnerJobId);
    // Nothing landed on the plan: two members, two independent answers.
    expect(p.plan.primary.continuationJobId).toBeUndefined();

    p.setContinuationJob(partnerId, null);
    expect(partnerEvent(p).person.continuationJobId).toBeNull();
  });

  it("refuses a job that is not this member's, and refuses an id that is nobody's", () => {
    // Both would otherwise resolve to `null` on read — losing the choice in silence — or extend
    // one member's employment when a different member worked longer.
    const p = Projection.fromState(stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }), nullJurisdiction);
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy }) as PersonId;
    const planJobId = p.addJob("p1" as PersonId, plainJob);

    expect(() => p.setContinuationJob(partnerId, planJobId)).toThrow(/belongs to/);
    expect(() => p.setContinuationJob("p1" as PersonId, "job-99")).toThrow(
      /no job "job-99" in this household/,
    );
    expect(() => p.setContinuationJob("nobody" as PersonId, null)).toThrow(
      /no member "nobody" in this household/,
    );
    // A refused write leaves the handle exactly as it was, and still usable.
    expect(p.plan.primary.continuationJobId).toBeUndefined();
    p.setContinuationJob("p1" as PersonId, planJobId);
    expect(p.plan.primary.continuationJobId).toBe(planJobId);
  });

  it("clears the answer when the job it names is removed, on either plane", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }), nullJurisdiction);
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy }) as PersonId;
    const planJobId = p.addJob("p1" as PersonId, plainJob);
    const partnerJobId = p.addPartnerJob(partnerId, plainJob);
    p.setContinuationJob("p1" as PersonId, planJobId);
    p.setContinuationJob(partnerId, partnerJobId);

    p.removeJob(planJobId);
    expect(p.plan.primary.continuationJobId).toBeNull();
    // The partner's is untouched by the primary's removal.
    expect(partnerEvent(p).person.continuationJobId).toBe(partnerJobId);

    p.removePartnerJob(partnerJobId);
    expect(partnerEvent(p).person.continuationJobId).toBeNull();
  });

  it("reads back the RESOLVED answer, not the stored field", () => {
    // The distinction the reader exists for. A member who has never been asked still has a
    // continuation job — the one they are working now — and a surface that read the raw field
    // would show "none" for them while the solve leant on that very job.
    const p = Projection.fromState(stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }), nullJurisdiction);
    const jobId = p.addJob("p1" as PersonId, plainJob);

    expect(p.plan.primary.continuationJobId).toBeUndefined(); // nothing stored…
    expect(p.continuationJobOf("p1" as PersonId)).toBe(jobId); // …but the solve would use this

    // An explicit None is a real answer and reads as one, distinct from never having been asked.
    p.setContinuationJob("p1" as PersonId, null);
    expect(p.continuationJobOf("p1" as PersonId)).toBeNull();
  });

  it("reads a partner's answer through the same method, and refuses a stranger", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }), nullJurisdiction);
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy }) as PersonId;
    const partnerJobId = p.addPartnerJob(partnerId, plainJob);

    expect(p.continuationJobOf(partnerId)).toBe(partnerJobId);
    expect(() => p.continuationJobOf("nobody" as PersonId)).toThrow(
      /no member "nobody" in this household/,
    );
  });

  it("survives a state round-trip on both planes", () => {
    const p = Projection.fromState(stateOf({ ...samplePlan, primary: { ...samplePlan.primary, jobs: [] } }), nullJurisdiction);
    const partnerId = p.marry({ month: 24, name: "Sam", birthYear: 1988, lifeExpectancy: samplePlan.primary.lifeExpectancy }) as PersonId;
    const planJobId = p.addJob("p1" as PersonId, plainJob);
    p.setContinuationJob("p1" as PersonId, planJobId);
    p.setContinuationJob(partnerId, null);

    const restored = Projection.fromState(
      JSON.parse(JSON.stringify(p.toState())),
      nullJurisdiction,
    );
    expect(restored.plan.primary.continuationJobId).toBe(planJobId);
    expect(partnerEvent(restored).person.continuationJobId).toBeNull();
  });
});


/**
 * **A job is authored in its owner's ages, so correcting a birthday moves the job with them.**
 *
 * The years on a job are a stored reading of ages the user typed ("started at 18, ends at 65"),
 * joined to the calendar by the owner's birth year. Move that origin and leave the years alone and
 * every one of those ages is silently restated — a job stated to end at 90 ending at 91 because a
 * birthday was corrected on another panel. So the whole employment shifts by the same delta, ages
 * unchanged, on whichever plane its owner is authored on.
 *
 * The primary is born 1986 (age 40 at the 2026 "now") throughout.
 */
describe("Projection root — a corrected birth year carries that person's jobs with it", () => {
  /** A projection whose primary lives to 100 (dies 2086), with room for far-dated jobs. */
  const longLived = () => {
    const p = freshProjection();
    p.updatePlan({ lifeExpectancy: 100 });
    return p;
  };

  const job = (startYear: number, endYear: number) => ({ ...plainJob, startYear, endYear });
  const primaryJob = (p: Projection) => p.plan.primary.jobs[0]!;

  it("shifts the calendar years and preserves the authored AGES", () => {
    // The issue's worked example, on this fixture's clock: a job ending at 90 is 2076 for a
    // 1986 birth; correct the birth year to 1985 and it must end in 2075, still at 90.
    const p = longLived();
    p.addJob(P1, job(2026, 2076));
    p.updatePlan({ birthYear: 1985 });

    expect(primaryJob(p)).toMatchObject({ startYear: 2025, endYear: 2075 });
    const { birthYear } = p.plan.primary;
    expect([primaryJob(p).startYear - birthYear, primaryJob(p).endYear - birthYear]).toEqual([40, 90]);
  });

  it("moves forwards as readily as back, and by the whole delta", () => {
    const p = longLived();
    p.addJob(P1, job(2026, 2076));
    p.updatePlan({ birthYear: 1991 }); // five years younger
    expect(primaryJob(p)).toMatchObject({ startYear: 2031, endYear: 2081 });
  });

  it("carries every dated adjustment inside the job, so their ages do not move either", () => {
    // A raise and a bonus are stored as absolute simulation months. Left where they were, a
    // raise authored at 60 would land at 61 — or fall outside the employment altogether.
    const p = longLived();
    const jobId = p.addJob(P1, job(2026, 2076));
    p.addJobPayChange(jobId, { month: 240, kind: "setTo", cents: dollarsToCents(15_000) }); // 2046
    p.addJobIncomeOverride(jobId, { month: 300, kind: "addBonus", cents: dollarsToCents(50_000) });
    p.updatePlan({ birthYear: 1985 });

    // One year earlier is twelve months earlier, for both kinds of adjustment.
    expect(primaryJob(p).payChanges?.map((c) => c.month)).toEqual([228]);
    expect(primaryJob(p).incomeOverrides?.map((o) => o.month)).toEqual([288]);
    // Which is the same age within the job it was authored at: month 240 was 2046, age 60.
    expect(SAMPLE_START_YEAR + 228 / 12 - p.plan.primary.birthYear).toBe(60);
  });

  it("leaves the rest of the job alone — ids, pay and everything a shift does not date", () => {
    const p = longLived();
    p.addJob(P1, { ...job(2026, 2076), name: "Day job" });
    const before = primaryJob(p);
    p.updatePlan({ birthYear: 1985 });
    expect(primaryJob(p)).toEqual({ ...before, startYear: 2025, endYear: 2075 });
  });

  it("moves a PARTNER's jobs on the partner's own birth year", () => {
    // A partner is authored on the ledger plane and their jobs ride their `RelationshipEvent`.
    // Same rule, one definition: their ages are theirs, read against their own birthday.
    const p = longLived();
    const samId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
    p.addPartnerJob(samId, job(2030, 2070));
    p.reviseTransaction(samId, { type: "marry", birthYear: 1993 });

    const sam = partnerEvent(p).person;
    expect(sam.jobs[0]).toMatchObject({ startYear: 2027, endYear: 2067 });
    expect([sam.jobs[0]!.startYear - sam.birthYear, sam.jobs[0]!.endYear - sam.birthYear]).toEqual([34, 74]);
  });

  it("moves only that person's jobs — the other earner's stay where they are", () => {
    const p = longLived();
    p.addJob(P1, job(2026, 2076));
    const samId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
    p.addPartnerJob(samId, job(2030, 2070));

    p.updatePlan({ birthYear: 1985 });
    expect(partnerEvent(p).person.jobs[0]).toMatchObject({ startYear: 2030, endYear: 2070 });

    p.reviseTransaction(samId, { type: "marry", birthYear: 1993 });
    expect(primaryJob(p)).toMatchObject({ startYear: 2025, endYear: 2075 });
  });

  it("does NOT move the household's own events — they are dated on the calendar, not on a life", () => {
    // The line: a wedding, a child's arrival and a loan are facts about a household's calendar,
    // and nobody's birthday put them there. Moving them would re-date other people's lives.
    const p = longLived();
    p.addJob(P1, job(2026, 2076));
    const samId = p.marry({ month: 120, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
    p.haveChild({ month: 60, name: "Kid", annualCostCents: 0 });
    p.takeLoan({
      month: 72,
      ownerId: P1,
      kind: "studentLoan",
      openingBalanceCents: dollarsToCents(20_000),
      apr: 5,
      termMonths: 120,
    });

    p.updatePlan({ birthYear: 1981 });

    expect(p.ledger.events.map((e) => [e.type, e.month])).toEqual([
      ["RelationshipEvent", 120],
      ["ChildEvent", 60],
      ["LoanEvent", 72],
    ]);
    // The separation a partner's own revision could have dragged is equally fixed.
    p.reviseTransaction(samId, { type: "marry", birthYear: 1993 });
    expect(partnerEvent(p).month).toBe(120);
  });

  it("still refuses the edit when the PRESERVED age outruns a life expectancy moved with it", () => {
    // Rebasing is not an escape from containment. The job's end age is preserved at 90 and the
    // life it has to fit inside is cut to 80, so the edit is refused and nothing moves.
    const p = longLived();
    p.addJob(P1, job(2026, 2076)); // ends at 90
    expect(() => p.updatePlan({ birthYear: 1985, lifeExpectancy: 80 })).toThrow(
      /would run the 2025 job on to 2075.*live only to 2065.*must end while its owner is alive/,
    );
    expect(primaryJob(p)).toMatchObject({ startYear: 2026, endYear: 2076 });
    expect(p.plan.primary.birthYear).toBe(samplePlan.primary.birthYear);
  });

  it("and refuses it on the partner plane too, on the partner's own numbers", () => {
    const p = longLived();
    const samId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
    p.addPartnerJob(samId, job(2030, 2081)); // ends at Sam's 85
    expect(() =>
      p.reviseTransaction(samId, { type: "marry", birthYear: 1993, lifeExpectancy: 80 }),
    ).toThrow(/would run the 2027 job on to 2078.*Sam is projected to live only to 2073/);
    expect(partnerEvent(p).person.jobs[0]).toMatchObject({ startYear: 2030, endYear: 2081 });
    expect(partnerEvent(p).person.birthYear).toBe(1996);
  });

  it("still strands a point EVENT the birth year moves the death back under", () => {
    // The other half of the same story. A job moves with its owner; a separation does not, so
    // lowering the birth year still walks the death back under it and the edit is refused.
    const p = longLived();
    const samId = p.marry({ month: 12, name: "Sam", birthYear: 1996, lifeExpectancy: 95 });
    p.separate({ month: 600, partnerPersonId: samId }); // 2076
    expect(() => p.updatePlan({ birthYear: 1970 })).toThrow(/would strand the 2076 separation/);
    expect(p.plan.primary.birthYear).toBe(samplePlan.primary.birthYear);
  });
});
