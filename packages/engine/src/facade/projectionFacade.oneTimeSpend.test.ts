/**
 * `Projection.spendOnce()` and `ProjectionResult.oneTimeSpendNudge()` — the One-Time Spend
 * transaction and its post-add advisory, exercised through the same `Projection` root the app
 * authors every other transaction through.
 */
import { describe, it, expect } from "vitest";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { freshProjection } from "../testing/projectionFacadeFixtures";

describe("Projection root — spendOnce()", () => {
  it("authors a OneTimeSpendEvent, minting a spend-N id", () => {
    const p = freshProjection();
    const id = p.spendOnce({
      month: 6,
      label: "New car",
      amountCents: dollarsToCents(5000),
      fundingSourceIds: ["savings"],
    });
    expect(id).toBe("spend-1");
    expect(p.ledger.events[0]).toMatchObject({
      id,
      type: "OneTimeSpendEvent",
      month: 6,
      label: "New car",
      amountCents: dollarsToCents(5000),
      fundingSourceIds: ["savings"],
    });
  });

  it("is refused only structurally — an unknown funding source — never on affordability", () => {
    const p = freshProjection();
    const before = p.state;
    expect(() =>
      p.spendOnce({
        month: 6,
        label: "New car",
        amountCents: dollarsToCents(5000),
        fundingSourceIds: ["no-such-account"],
      }),
    ).toThrow(/cannot apply transaction — .*funding source "no-such-account" not found/);
    expect(p.state).toBe(before);

    // A source that cannot cover the amount authors fine — no throw.
    expect(() =>
      p.spendOnce({
        month: 6,
        label: "New car",
        amountCents: dollarsToCents(1_000_000),
        fundingSourceIds: ["savings"],
      }),
    ).not.toThrow();
  });
});

describe("ProjectionResult.oneTimeSpendNudge() — the post-add advisory", () => {
  it("stays quiet for an ordinary, affordable spend", () => {
    const p = freshProjection();
    const id = p.spendOnce({
      month: 6,
      label: "New car",
      amountCents: dollarsToCents(5000),
      fundingSourceIds: ["savings"],
    });
    const result = p.run(nullJurisdiction);
    expect(result.oneTimeSpendNudge(id, 6)).toBeNull();
  });

  it("stays quiet (never blocks) when the spend itself blocked the projection", () => {
    const p = freshProjection();
    const id = p.spendOnce({
      month: 6,
      label: "New car",
      amountCents: dollarsToCents(1_000_000), // far past the $20k opening savings
      fundingSourceIds: ["savings"],
    });
    const result = p.run(nullJurisdiction);
    expect(result.series.status).toBe("blocked");
    expect(result.oneTimeSpendNudge(id, 6)).toBeNull();
  });
});
