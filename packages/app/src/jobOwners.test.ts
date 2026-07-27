/**
 * Who can own a job, and which plane their jobs are authored on. This is
 * the seam that lets one Jobs panel edit both the primary person's standing plan jobs
 * and a partner's, which ride the RelationshipEvent that brought them into the
 * household — so what it must never do is confuse the two.
 */
import { describe, it, expect } from "vitest";
import {
  createProjectionBase,
  dollarsToCents,
  emptyLedger,
  interpretLedger,
  type Job,
  type Ledger,
  type LifeEvent,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PLAN_DEFAULTS } from "./planDefaults";
import { START_YEAR } from "./config";
import { jobOwnersOf } from "./jobOwners";

const base = createProjectionBase(PLAN_DEFAULTS, {
  jurisdiction: usJurisdiction,
  startYear: START_YEAR,
});

const partnerJob: Job = {
  id: "p-1-job-1",
  ownerId: "p-1",
  startYear: START_YEAR,
  endYear: null,
  salary: { startingSalaryCents: dollarsToCents(24_000), realGrowthPct: 0 },
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
    retirementTargetAge: 65,
    benefitClaimingAge: 67,
    jobs,
  },
});

const ledgerOf = (...events: LifeEvent[]): Ledger => ({ events, nextSequenceNumber: events.length });

const ownersOf = (ledger: Ledger) => jobOwnersOf(interpretLedger(ledger, base), ledger);

describe("jobOwnersOf", () => {
  it("gives the primary person alone on a single-earner plan, writing to the plan", () => {
    const owners = ownersOf(emptyLedger);
    expect(owners).toHaveLength(1);
    expect(owners[0].name).toBe(PLAN_DEFAULTS.name);
    expect(owners[0].jobs).toEqual(PLAN_DEFAULTS.jobs);
    expect(owners[0].writeTarget.kind).toBe("plan");
  });

  it("adds a partner after them, writing to the event they joined with", () => {
    const owners = ownersOf(ledgerOf(joining(60, [partnerJob])));
    expect(owners.map((o) => o.name)).toEqual([PLAN_DEFAULTS.name, "Sam"]);

    const partner = owners[1];
    expect(partner.jobs).toEqual([partnerJob]);
    // Their ages resolve against their OWN birth year, and their jobs are ledger data.
    expect(partner.birthYear).toBe(START_YEAR - 40);
    expect(partner.startMonth).toBe(60);
    expect(partner.writeTarget.kind).toBe("event");
    if (partner.writeTarget.kind === "event") expect(partner.writeTarget.event.id).toBe("r1");
  });

  it("keeps a separated partner listed, with the month they left", () => {
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
    expect(owners).toHaveLength(2);
    expect(owners[1].endMonth).toBe(120);
  });

  it("omits a member with no event to write back to, rather than listing them unwritably", () => {
    // A household member the ledger cannot account for has no authoring plane, so
    // offering to edit their jobs would be offering an edit that goes nowhere.
    const household = interpretLedger(ledgerOf(joining(60, [partnerJob])), base);
    expect(jobOwnersOf(household, emptyLedger).map((o) => o.name)).toEqual([PLAN_DEFAULTS.name]);
  });
});
