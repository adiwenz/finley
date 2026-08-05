/**
 * Who can own a job, and which plane their jobs are authored on. The seam that lets one Jobs
 * panel edit both the primary person's standing plan jobs and a partner's, which ride the
 * RelationshipEvent that brought them into the household — it must never confuse the two.
 */
import { describe, it, expect } from "vitest";
import { dollarsToCents, type Job, type Ledger, type LifeEvent } from "@finley/engine";
import { PLAN_DEFAULTS } from "./planDefaults";
import { START_YEAR } from "./config";
import { jobOwnersOf } from "./jobOwners";
import { runOf } from "./testing/projectionHarness";

/**
 * The event-free ledger as a public {@link Ledger} literal — the engine's `emptyLedger` is an
 * internal the facade never hands out. The interpreted household comes from a full run
 * (`runOf(...).household`), the public read that replaces `interpretLedger` + `createProjectionBase`.
 */
const noEvents: Ledger = { events: [], nextSequenceNumber: 0 };

const partnerJob: Job = {
  id: "p-1-job-1",
  ownerId: "p-1",
  startYear: START_YEAR,
  endYear: START_YEAR - 40 + 65,
  salary: { startingSalaryCents: dollarsToCents(24_000), currentSalaryCents: dollarsToCents(24_000), realGrowthPct: 0 },
};

const joining = (month: number, jobs: readonly Job[]): LifeEvent => ({
  id: "r1",
  sequenceNumber: 0,
  type: "RelationshipEvent",
  month,
  person: {
    id: "p-1",
    name: "Sam",
    birthYear: START_YEAR - 40,
    benefitClaimingAge: 67,
    jobs,
  },
});

const ledgerOf = (...events: LifeEvent[]): Ledger => ({ events, nextSequenceNumber: events.length });

const ownersOf = (ledger: Ledger) => jobOwnersOf(runOf(PLAN_DEFAULTS, ledger).household, ledger);

describe("jobOwnersOf", () => {
  it("gives the primary person alone on a single-earner plan, writing to the plan", () => {
    const owners = ownersOf(noEvents);
    expect(owners).toHaveLength(1);
    expect(owners[0].name).toBe(PLAN_DEFAULTS.name);
    expect(owners[0].jobs).toEqual(PLAN_DEFAULTS.jobs);
    expect(owners[0].writeTarget).toBe("plan");
  });

  it("adds a partner after them, writing to the event they joined with", () => {
    const owners = ownersOf(ledgerOf(joining(60, [partnerJob])));
    expect(owners.map((o) => o.name)).toEqual([PLAN_DEFAULTS.name, "Sam"]);

    const partner = owners[1];
    expect(partner.jobs).toEqual([partnerJob]);
    // Their ages resolve against their OWN birth year, and their jobs are ledger data.
    expect(partner.birthYear).toBe(START_YEAR - 40);
    expect(partner.startMonth).toBe(60);
    expect(partner.writeTarget).toBe("event");
  });

  it("keeps a separated partner listed — their jobs are still theirs to edit", () => {
    const owners = ownersOf(
      ledgerOf(joining(12, [partnerJob]), {
        id: "sep1",
        sequenceNumber: 1,
        type: "SeparationEvent",
        month: 120,
        partnerPersonId: "p-1",
        alimonyMonthlyCents: 0,
        alimonyDurationMonths: 0,
        childSupportMonthlyCents: 0,
      }),
    );
    // Listed, and still writable: leaving the household ends the wages this household
    // collects, not the person's authorship of their own jobs. What the separation does to the
    // money is the engine's answer and is deliberately not restated on this list.
    expect(owners).toHaveLength(2);
    expect(owners[1].name).toBe("Sam");
    expect(owners[1].writeTarget).toBe("event");
  });

  it("omits a member with no event to write back to, rather than listing them unwritably", () => {
    // A member the ledger cannot account for has no authoring plane, so offering to edit
    // their jobs would be offering an edit that goes nowhere.
    const household = runOf(PLAN_DEFAULTS, ledgerOf(joining(60, [partnerJob]))).household;
    expect(jobOwnersOf(household, noEvents).map((o) => o.name)).toEqual([PLAN_DEFAULTS.name]);
  });
});
