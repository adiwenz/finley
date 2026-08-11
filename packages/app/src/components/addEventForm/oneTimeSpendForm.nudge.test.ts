/**
 * The One-Time Spend post-add advisory, at the two layers that carry its logic:
 *  - `insolvencyNudgeMessage` — pure before/after → message derivation.
 *  - `advanceNudgeState` — the pending-baseline state machine that decides which `result` update
 *    a submitted add's baseline gets compared against, and that it is compared against ONLY that
 *    one.
 * Both are exercised directly against minimal `ProjectionResult`-shaped fixtures rather than
 * through DOM rendering: neither bug this file regression-tests was a rendering mistake.
 */
import { describe, it, expect } from "vitest";
import type { ProjectionResult } from "@finley/engine";
import {
  advanceNudgeState,
  insolvencyNudgeMessage,
  NO_PENDING_NUDGE,
  type NudgeState,
} from "./oneTimeSpendForm";

/** A minimal `ProjectionResult` stand-in — only the fields the nudge reads. */
function resultOf(status: "ran-to-horizon" | "blocked", insolventMonth: number | null): ProjectionResult {
  const months =
    insolventMonth === null
      ? [{ month: 0, isInsolvent: false }]
      : [{ month: 0, isInsolvent: false }, { month: insolventMonth, isInsolvent: true }];
  return {
    series: { status, months },
  } as unknown as ProjectionResult;
}

describe("insolvencyNudgeMessage", () => {
  it("fires when the plan was solvent before the add and insolvent after — the specifically broken case", () => {
    // Regression for the bug where `null` (solvent before) was indistinguishable from "no
    // baseline," silently swallowing exactly this transition.
    const message = insolvencyNudgeMessage(null, resultOf("ran-to-horizon", 40));
    expect(message).not.toBeNull();
    expect(message).toContain("insolvent");
  });

  it("stays silent when the plan is solvent both before and after", () => {
    expect(insolvencyNudgeMessage(null, resultOf("ran-to-horizon", null))).toBeNull();
  });

  it("fires when the add moves an existing insolvency onset earlier", () => {
    const message = insolvencyNudgeMessage(60, resultOf("ran-to-horizon", 40));
    expect(message).not.toBeNull();
  });

  it("stays silent when a pre-existing insolvency onset is unmoved or pushed later", () => {
    expect(insolvencyNudgeMessage(40, resultOf("ran-to-horizon", 40))).toBeNull();
    expect(insolvencyNudgeMessage(40, resultOf("ran-to-horizon", 60))).toBeNull();
  });

  it("never fires when the projection is blocked — the block already says its own piece", () => {
    expect(insolvencyNudgeMessage(null, resultOf("blocked", 40))).toBeNull();
  });

  it("names the first newly-invalid month in the message", () => {
    const message = insolvencyNudgeMessage(null, resultOf("ran-to-horizon", 40));
    // Month 40 falls in year 3 (2029) of the default 2026 start year.
    expect(message).toContain("2029");
  });
});

/** The state right after `submit` arms a baseline, before any `result` has consumed it. */
function armed(beforeMonth: number | null): NudgeState {
  return { pendingBaseline: beforeMonth, nudge: null };
}

describe("advanceNudgeState", () => {
  it("consumes an armed baseline against the next result and shows the nudge", () => {
    const next = advanceNudgeState(armed(null), resultOf("ran-to-horizon", 40));
    expect(next.nudge).not.toBeNull();
    // Consumed: nothing left pending for a further result to compare against.
    expect(next.pendingBaseline).toBeUndefined();
  });

  it("regression: does not keep comparing a later, unrelated result against the historical baseline", () => {
    // The add fires and shows the nudge, exactly as above.
    const afterAdd = advanceNudgeState(armed(null), resultOf("ran-to-horizon", 40));
    expect(afterAdd.nudge).not.toBeNull();

    // A later, unrelated plan change also happens to leave the plan insolvent from an even
    // earlier month — the OLD bug would re-compare this against the same stale `null` baseline
    // and (wrongly) keep the nudge alive, or restate it, for a change this purchase had nothing
    // to do with.
    const afterUnrelatedChange = advanceNudgeState(afterAdd, resultOf("ran-to-horizon", 10));
    expect(afterUnrelatedChange.nudge).toBeNull();
    expect(afterUnrelatedChange.pendingBaseline).toBeUndefined();
  });

  it("regression: the nudge disappears on the next result and does not falsely reappear", () => {
    const afterAdd = advanceNudgeState(armed(null), resultOf("ran-to-horizon", 40));
    expect(afterAdd.nudge).not.toBeNull();

    // The plan recovers (an unrelated fix, or simply the next tick) — the nudge must disappear.
    const recovered = advanceNudgeState(afterAdd, resultOf("ran-to-horizon", null));
    expect(recovered.nudge).toBeNull();

    // And stays gone across a further result, even one that is itself insolvent again — nothing
    // is pending, so nothing is compared, so nothing falsely reappears.
    const stillGone = advanceNudgeState(recovered, resultOf("ran-to-horizon", 5));
    expect(stillGone.nudge).toBeNull();
  });

  it("is a no-op while nothing is pending and nothing is showing", () => {
    const next = advanceNudgeState(NO_PENDING_NUDGE, resultOf("ran-to-horizon", 40));
    expect(next).toBe(NO_PENDING_NUDGE);
  });

  it("armed baseline waits for its own result — a mid-flight result before the add lands is not itself a consumption trigger", () => {
    // `advanceNudgeState` always consumes on the VERY NEXT call once armed; this pins that an
    // armed baseline only ever compares once, not on some later call once un-armed.
    const consumed = advanceNudgeState(armed(60), resultOf("ran-to-horizon", 40));
    expect(consumed.pendingBaseline).toBeUndefined();
    const again = advanceNudgeState(consumed, resultOf("ran-to-horizon", 20));
    expect(again.nudge).toBeNull();
  });
});
