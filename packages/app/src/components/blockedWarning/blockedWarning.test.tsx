/**
 * @vitest-environment node
 *
 * The blocked-projection soft warning. Rendered through the server renderer — these assert on
 * markup, not interaction. The event→shortfall join and the failure classification are pinned in
 * `ledgerView.test.ts`; these pin the SURFACE: a stopped projection names its event, month, and
 * shortfall in the persistent, non-dismissible soft-warning pattern, and the copy branches on the
 * failure so the two cases are visibly different — one names alternative accounts, the other says
 * nothing eligible suffices WITHOUT calling the household broke.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dollarsToCents } from "@finley/engine";
import type { BlockedWarningView } from "../../ledgerView";
import { BlockedWarning } from "./blockedWarning";

/** Nothing eligible can cover it — a stranded plan with only illiquid wealth left. */
const NO_ELIGIBLE: BlockedWarningView = {
  eventLabel: "Bought a home",
  month: 12,
  shortfallCents: dollarsToCents(139_476),
  kind: "no-eligible-source-suffices",
};

/** The selection falls short but a funded cash goal could cover it. */
const FUNDING_CONFIG: BlockedWarningView = {
  eventLabel: "Bought a home",
  month: 12,
  shortfallCents: dollarsToCents(29_502),
  kind: "funding-configuration",
  alternativeSources: [{ label: "House fund", availableCents: dollarsToCents(230_446) }],
};

function render(warning: BlockedWarningView) {
  return renderToStaticMarkup(<BlockedWarning warning={warning} />);
}

describe("BlockedWarning", () => {
  it("names the event, its month, and the shortfall net of tax, in both cases", () => {
    for (const warning of [NO_ELIGIBLE, FUNDING_CONFIG]) {
      const html = render(warning);
      expect(html).toContain("Bought a home");
      // The shared month label — the same "Year N (YYYY)" every other surface reads.
      expect(html).toContain("Year 1 (2027)");
    }
    expect(render(NO_ELIGIBLE)).toContain("$139,476");
    expect(render(FUNDING_CONFIG)).toContain("$29,502");
  });

  it("uses the soft-warning pattern — persistent, and carrying no dismiss control", () => {
    const html = render(NO_ELIGIBLE);
    expect(html).toContain("soft-warning");
    // Non-dismissible: nothing to click to make it go away — it clears only when the block does.
    expect(html).not.toContain("<button");
  });

  it("names the alternative account and its available balance for a funding-configuration block", () => {
    const html = render(FUNDING_CONFIG);
    expect(html).toContain("House fund");
    expect(html).toContain("$230,446");
  });

  it("explains no eligible account can cover it — without insolvency language", () => {
    const html = render(NO_ELIGIBLE);
    expect(html.toLowerCase()).not.toContain("afford");
    expect(html.toLowerCase()).not.toContain("insolven");
    expect(html.toLowerCase()).not.toContain("broke");
    // It must say the eligibility fact, not name a specific alternative it does not have.
    expect(html).not.toContain("House fund");
  });

  it("renders visibly different copy for the two failure cases", () => {
    expect(render(NO_ELIGIBLE)).not.toBe(render(FUNDING_CONFIG));
  });
});
