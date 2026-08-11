/**
 * `insolvencyNudgeMessage` — the pure derivation behind the One-Time Spend post-add advisory.
 * Exercised directly against minimal `ProjectionResult`-shaped fixtures rather than through DOM
 * rendering: the bug this pins was a data-modeling mistake (conflating "no comparison pending"
 * with "solvent before"), not a rendering one, so the regression belongs at this layer.
 */
import { describe, it, expect } from "vitest";
import type { ProjectionResult } from "@finley/engine";
import { insolvencyNudgeMessage } from "./oneTimeSpendForm";

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
