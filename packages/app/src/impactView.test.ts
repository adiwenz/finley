/**
 * The counterfactual behind "Impact on your plan".
 *
 * The delta is only meaningful if both halves come from the same solver, so the contract under
 * test is that the "without" half is genuinely the plan minus that one change — and that a change
 * whose removal is refused yields nothing rather than a comparison against an impossible plan.
 */

import { describe, it, expect } from "vitest";
import { Projection, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { PRESETS, presetState } from "./presets";
import { impactView } from "./impactView";

/** The plan's cash account, which is what a one-off spend draws on. */
function savingsId(state: ReturnType<typeof presetState>): string {
  const source = Projection.fromState(state, usJurisdiction)
    .funding()
    .sourcesAt(0, "expense")
    .find((s) => s.label === "Cash savings");
  if (source === undefined) throw new Error("expected a Cash savings account in the preset plan");
  return source.id;
}

/** A state carrying one authored change, and that change's id. */
function withOneSpend(amountDollars: number) {
  const base = presetState(PRESETS[0]!);
  let eventId = "";
  const { state } = Projection.transact(base, usJurisdiction, (p) => {
    eventId = p.spendOnce({
      month: 24,
      label: "Wedding",
      amountCents: dollarsToCents(amountDollars),
      fundingSourceIds: [savingsId(base)],
    });
  });
  return { state, eventId };
}

describe("impactView", () => {
  it("states a stop-working row and a closing net worth", () => {
    const { state, eventId } = withOneSpend(3_000);
    const view = impactView(state, usJurisdiction, eventId);

    expect(view).not.toBeNull();
    expect(view!.rows[0]!.label).toBe("Stop working");
    expect(view!.rows.some((r) => r.label.startsWith("Net worth"))).toBe(true);
    expect(view!.note.length).toBeGreaterThan(0);
  });

  it("compares against the plan without that one change", () => {
    const { state, eventId } = withOneSpend(3_000);
    const view = impactView(state, usJurisdiction, eventId)!;
    const row = view.rows[0]!;

    // Either an explicit "before → after", or a single figure when one side has no age at all.
    expect(row.value).toMatch(/^(\d+ → \d+|\d+|not yet reachable)$/);
  });

  it("reads a costlier change as no better for the plan than a cheaper one", () => {
    const cheap = withOneSpend(1_000);
    const dear = withOneSpend(9_000);

    const cheapRow = impactView(cheap.state, usJurisdiction, cheap.eventId)!.rows[0]!;
    const dearRow = impactView(dear.state, usJurisdiction, dear.eventId)!.rows[0]!;

    // Spending more can only delay retirement or leave it alone — never bring it forward.
    const rank = { better: 0, neutral: 1, worse: 2 } as const;
    expect(rank[dearRow.tone]).toBeGreaterThanOrEqual(rank[cheapRow.tone]);
  });

  it("describes the change without judging it", () => {
    const { state, eventId } = withOneSpend(9_000);
    const note = impactView(state, usJurisdiction, eventId)!.note;

    expect(note).toMatch(/stop-working date|stop working/i);
    // The brand refuses to shame: no verdict language about the reader's choice.
    expect(note).not.toMatch(/afford|mistake|too much|should not|shouldn/i);
  });

  it("answers null when the change cannot be removed from the plan", () => {
    // A separation depends on the partnering before it, so the partnering has no counterfactual.
    const base = presetState(PRESETS[0]!);
    // `marry` answers with the minted person id, which is also the partnering event's id.
    let partnerId = "";
    const { state } = Projection.transact(base, usJurisdiction, (p) => {
      partnerId = p.marry({ month: 12, name: "Sam", birthYear: 1990, lifeExpectancy: 90 });
    });
    const { state: withBoth } = Projection.transact(state, usJurisdiction, (p) => {
      p.separate({ month: 60, partnerPersonId: partnerId });
    });

    expect(impactView(withBoth, usJurisdiction, partnerId)).toBeNull();
  });
});
