import { describe, it, expect } from "vitest";
import { assessOneTimeSpendNudge } from "./spend";

describe("assessOneTimeSpendNudge — the post-add whole-month feasibility nudge", () => {
  const base = { eventId: "spend-1", eventMonth: 12 };

  it("fires when the run is solvent-at-authoring but goes insolvent from the spend's month onward", () => {
    const nudge = assessOneTimeSpendNudge({ ...base, blocked: false, firstInsolventMonth: 200 });
    expect(nudge).toEqual({ eventId: "spend-1", insolventMonth: 200 });
  });

  it("fires when the FIRST insolvent month is the spend's own month — it can be the marginal cause", () => {
    const nudge = assessOneTimeSpendNudge({ ...base, blocked: false, firstInsolventMonth: 12 });
    expect(nudge).toEqual({ eventId: "spend-1", insolventMonth: 12 });
  });

  it("stays quiet when the plan never goes insolvent", () => {
    expect(assessOneTimeSpendNudge({ ...base, blocked: false, firstInsolventMonth: null })).toBeNull();
  });

  it("stays quiet when the insolvency precedes the spend — not this spend's doing", () => {
    expect(assessOneTimeSpendNudge({ ...base, blocked: false, firstInsolventMonth: 3 })).toBeNull();
  });

  it("never fires when the spend itself blocked — its own gate already speaks to that", () => {
    expect(assessOneTimeSpendNudge({ ...base, blocked: true, firstInsolventMonth: 200 })).toBeNull();
  });
});
