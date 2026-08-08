/**
 * The counter floor's two stated properties, asserted directly rather than through a reload.
 *
 * `projectionFacade.test.ts` proves restoration does not reissue a live id — the behaviour that
 * matters. What is only stated in prose there, and is cheap to pin here now that the counter is
 * its own module, is WHY that holds: the floor never decreases, and it is idempotent, so no
 * number of round trips can walk a counter backwards onto an id already handed out.
 */

import { describe, expect, it } from "vitest";
import { seqFloor, withNormalizedCounters } from "./mint";
import { samplePlan, stateOf } from "../testing/samplePlan";
import type { ProjectionState } from "./state";
import type { Job } from "../job/job";
import type { PersonId } from "../job/job";
import { SAMPLE_START_YEAR } from "../testing/samplePlan";
import { dollarsToCents } from "../money/cashFlowSeries";

const P1 = "p1" as PersonId;

/** A goal and a budget line, minted-shaped, the way a restored plan carries them. */
function planWith(overrides: { goalId?: string; lineId?: string } = {}) {
  const { goalId, lineId } = overrides;
  return {
    ...samplePlan,
    primary: { ...samplePlan.primary, jobs: [] },
    goals: goalId
      ? [
          {
            id: goalId,
            name: "Car",
            targetCents: dollarsToCents(30000),
            targetDate: 36,
            disposition: "retain" as const,
            annualReturnPct: 3,
          },
        ]
      : [],
    budgetLines: lineId
      ? [
          {
            id: lineId,
            label: "Rent",
            target: { kind: "expense" as const },
            amountSource: { kind: "literal" as const, monthlyCents: dollarsToCents(2000) },
            category: "needs" as const,
          },
        ]
      : [],
  };
}

/** A minted-looking job id is what a restored scenario carries and the counter must step past. */
function jobNamed(id: string): Job {
  return {
    id,
    ownerId: P1,
    startYear: SAMPLE_START_YEAR,
    endYear: 2090,
    salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
  };
}

function stateHolding(...jobIds: string[]): ProjectionState {
  return stateOf({
    ...samplePlan,
    budgetLines: [],
    primary: { ...samplePlan.primary, jobs: jobIds.map(jobNamed) },
  });
}

describe("the id counter's floor", () => {
  it("steps past every minted id the scenario already holds", () => {
    // `nextSeq` opens at 1 while the plan holds `job-7`; minting again from 1 would reissue it.
    const state = stateHolding("job-7");
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(8);
  });

  it("never decreases — a lean scenario cannot walk a spent counter back", () => {
    const state = { ...stateHolding("job-2"), nextSeq: 50 };
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(50);
  });

  it("ignores an id it did not mint, so a person's words cannot advance it", () => {
    // A label-shaped id is carried verbatim, never parsed as a counter reading.
    const state = stateHolding("room-50000");
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(state.nextSeq);
  });

  it("is idempotent from the second pass on", () => {
    const once = withNormalizedCounters(stateHolding("job-4"));
    const twice = withNormalizedCounters(once);

    expect(once.nextSeq).toBe(5);
    expect(twice.nextSeq).toBe(once.nextSeq);
    expect(twice.scenario.ledger.nextSequenceNumber).toBe(
      once.scenario.ledger.nextSequenceNumber,
    );
  });

  it("raises the ledger's sequence counter with the id counter — both are restored data", () => {
    // A serialized `nextSequenceNumber` is no more trustworthy than `nextSeq`; a ledger below the
    // floor would stamp the next two appends the SAME sequence number.
    const normalized = withNormalizedCounters(stateHolding("job-9"));
    expect(normalized.scenario.ledger.nextSequenceNumber).toBe(10);
  });
});

describe("the floor reads adjustment ids too", () => {
  /** A job carrying restored adjustments, the way a reloaded plan does. */
  function jobWithAdjustments(id: string, ...adjustmentIds: string[]): Job {
    return {
      ...jobNamed(id),
      payChanges: adjustmentIds
        .slice(0, 1)
        .map((a) => ({ id: a, month: 12, kind: "setTo" as const, cents: 100 })),
      incomeOverrides: adjustmentIds
        .slice(1)
        .map((a) => ({ id: a, month: 6, kind: "addBonus" as const, cents: 100 })),
    };
  }

  it("steps past an adjustment id, not only the job's own", () => {
    // The hazard this closes: the counter reissuing `adjustment-9` to a NEW bonus stacked in the
    // same month as the restored one, after which removing either would take both.
    const state = stateOf({
      ...samplePlan,
      budgetLines: [],
      primary: {
        ...samplePlan.primary,
        jobs: [jobWithAdjustments("job-2", "adjustment-9", "adjustment-14")],
      },
    });
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(15);
  });

  it("reads adjustments on a partner's job as well, off the event carrying it", () => {
    const state = stateOf({
      ...samplePlan,
      budgetLines: [],
      primary: { ...samplePlan.primary, jobs: [] },
    });
    const withPartner: ProjectionState = {
      ...state,
      scenario: {
        ...state.scenario,
        ledger: {
          ...state.scenario.ledger,
          events: [
            {
              type: "RelationshipEvent",
              id: "e1",
              month: 12,
              sequenceNumber: 1,
              person: {
                id: "person-3" as PersonId,
                name: "Sam",
                birthYear: 1980,
                lifeExpectancy: samplePlan.primary.lifeExpectancy,
                benefitClaimingAge: 67,
                jobs: [jobWithAdjustments("job-4", "adjustment-21")],
              },
            },
          ],
        },
      },
    };
    expect(seqFloor(withPartner.scenario, withPartner.nextSeq)).toBe(22);
  });

  it("leaves the ids themselves untouched when the counter is normalized", () => {
    const state = stateOf({
      ...samplePlan,
      budgetLines: [],
      primary: {
        ...samplePlan.primary,
        jobs: [jobWithAdjustments("job-2", "adjustment-9", "adjustment-14")],
      },
    });
    const restored = withNormalizedCounters(state);
    const job = restored.scenario.plan.primary.jobs[0]!;
    expect(job.payChanges?.map((c) => c.id)).toEqual(["adjustment-9"]);
    expect(job.incomeOverrides?.map((o) => o.id)).toEqual(["adjustment-14"]);
  });
});

describe("the floor reads every plan collection, not only jobs", () => {
  it("steps past a goal id and a budget-line id, each in their own collection", () => {
    const state = stateOf(planWith({ goalId: "goal-7", lineId: "line-5" }));
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(8);
  });
});

describe("the floor reads the ledger's own sequence numbers", () => {
  it("steps past an event's sequenceNumber even when nextSequenceNumber understates it", () => {
    // A restored ledger whose own bookkeeping field lags the event it already holds — the
    // shape a hand-edited or stale serialization takes.
    const state: ProjectionState = {
      ...stateOf(planWith()),
      scenario: {
        ...stateOf(planWith()).scenario,
        ledger: {
          events: [
            {
              id: "loan-1",
              type: "LoanEvent",
              month: 6,
              sequenceNumber: 4,
              kind: "auto",
              liabilityId: "loan-1",
              ownerId: P1,
              openingBalanceCents: dollarsToCents(20_000),
              apr: 5,
              termMonths: 60,
            },
          ],
          nextSequenceNumber: 1,
        },
      },
    };
    expect(seqFloor(state.scenario, state.nextSeq)).toBeGreaterThan(4);
  });
});

describe("the floor reads a HomePurchaseEvent's embedded mortgage id, not just the property id", () => {
  it("steps past both ids the event carries", () => {
    const base = stateOf(planWith());
    const state: ProjectionState = {
      ...base,
      scenario: {
        ...base.scenario,
        ledger: {
          events: [
            {
              id: "home-1",
              type: "HomePurchaseEvent",
              month: 6,
              sequenceNumber: 0,
              propertyId: "home-1",
              ownerId: P1,
              purchasePriceCents: dollarsToCents(400_000),
              downPaymentCents: 0,
              downPaymentSourceIds: [],
              mortgage: {
                liabilityId: "mortgage-2",
                openingBalanceCents: dollarsToCents(240_000),
                apr: 0.05,
                termMonths: 240,
              },
            },
          ],
          nextSequenceNumber: 1,
        },
      },
    };
    // Unfloored, the next mint would reissue "mortgage-2" — the property id alone is not enough.
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(3);
  });
});

describe("the floor ignores an id-shaped suffix past MAX_SAFE_INTEGER", () => {
  it("cannot be walked past a number the counter could never count to", () => {
    // Honouring the suffix would set a floor `mint` can never reach — incrementing a non-safe
    // integer is a no-op, so every later mint would hand out the SAME id forever.
    const state = stateHolding("job-9007199254740993");
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(state.nextSeq);
  });

  it("ignores it on the ledger side too, where the id sits in a real id field", () => {
    const base = stateOf(planWith());
    const state: ProjectionState = {
      ...base,
      scenario: {
        ...base.scenario,
        ledger: {
          events: [
            {
              id: "loan-9007199254740993",
              type: "LoanEvent",
              month: 6,
              sequenceNumber: 0,
              kind: "auto",
              liabilityId: "loan-9007199254740993",
              ownerId: P1,
              openingBalanceCents: dollarsToCents(20_000),
              apr: 5,
              termMonths: 60,
            },
          ],
          nextSequenceNumber: 1,
        },
      },
    };
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(state.nextSeq);
  });
});

describe("the floor reads named id fields, not every string it can reach", () => {
  it("ignores a mint-shaped string sitting in a NAME field, not an id field", () => {
    // `childName` is a person's words. A scan over every string in the ledger would read
    // "goal-50000" as a counter reading and advance the mint by fifty thousand on the strength
    // of a name that merely looks minted.
    const base = stateOf(planWith());
    const state: ProjectionState = {
      ...base,
      scenario: {
        ...base.scenario,
        ledger: {
          events: [
            {
              id: "child-1",
              type: "ChildEvent",
              month: 12,
              sequenceNumber: 0,
              childId: "child-1",
              childName: "goal-50000",
              birthMonth: 12,
              annualCostCents: 0,
            },
          ],
          nextSequenceNumber: 1,
        },
      },
    };
    // Only the two named id fields (`id`, `childId`) move the floor — the name is inert.
    expect(seqFloor(state.scenario, state.nextSeq)).toBe(2);
  });
});
