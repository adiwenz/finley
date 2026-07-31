import { describe, expect, it } from "vitest";
import type { FinancialObligation } from "@finley/engine";
import { OBLIGATION_SURFACE_ANCHORS, obligationEditLink } from "./obligationLink";

/** A minimal obligation of a given source kind — only the fields the link reads. */
function obligation(sourceKind: FinancialObligation["sourceKind"]): FinancialObligation {
  return {
    id: `id-${sourceKind}`,
    sourceId: `src-${sourceKind}`,
    month: 0,
    amountCents: 1_000,
    treatment: sourceKind === "liability" ? "debt-payment" : "expense",
    funding: { kind: "automatic" },
    priority: 0,
    sourceKind,
    editable: sourceKind === "budgetLine",
    label: sourceKind,
    category: "other",
  };
}

describe("obligationEditLink — where a non-editable obligation is really edited", () => {
  it("sends an event-spawned expense to its event on the timeline", () => {
    expect(obligationEditLink(obligation("event"))?.href).toBe(
      `#${OBLIGATION_SURFACE_ANCHORS.timeline}`,
    );
  });

  it("sends a liability payment to the loan on the timeline", () => {
    expect(obligationEditLink(obligation("liability"))?.href).toBe(
      `#${OBLIGATION_SURFACE_ANCHORS.timeline}`,
    );
  });

  it("offers no link for an authored budget line — it is edited in place here", () => {
    expect(obligationEditLink(obligation("budgetLine"))).toBeNull();
  });

  it("offers no link for health, which is now an authored line rather than a plan input", () => {
    // The one surface health used to link away to no longer authors it, so there is nothing
    // left to point at: a `healthcare` obligation is a budget line and edits in place.
    expect(obligationEditLink({ ...obligation("budgetLine"), category: "healthcare" })).toBeNull();
  });

  it("offers no link for an untracked stream — there is nowhere to edit it", () => {
    expect(obligationEditLink(obligation("untracked"))).toBeNull();
  });
});
