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
import type { Job } from "../job";
import type { PersonId } from "../job";
import { SAMPLE_START_YEAR } from "../testing/samplePlan";
import { dollarsToCents } from "../cashFlowSeries";

const P1 = "p1" as PersonId;

/** A minted-looking job id is what a restored scenario carries and the counter must step past. */
function jobNamed(id: string): Job {
  return {
    id,
    ownerId: P1,
    startYear: SAMPLE_START_YEAR,
    endYear: null,
    salary: { startingSalaryCents: dollarsToCents(100000), currentSalaryCents: dollarsToCents(100000), realGrowthPct: 0 },
  };
}

function stateHolding(...jobIds: string[]): ProjectionState {
  return stateOf({ ...samplePlan, budgetLines: [], jobs: jobIds.map(jobNamed) });
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
