/**
 * @vitest-environment node
 *
 * The blocked-projection soft warning. Rendered through the server renderer — these assert on
 * markup, not interaction. The event→shortfall join is pinned in `ledgerView.test.ts`; these pin
 * the SURFACE: a stopped projection names its event, month, and shortfall, in the persistent,
 * non-dismissible soft-warning pattern (no dismiss control, marker class present).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dollarsToCents } from "@finley/engine";
import type { BlockedWarningView } from "../../ledgerView";
import { BlockedWarning } from "./blockedWarning";

/** A stranded home purchase — the shape `blockedWarning` hands the component. */
const STRANDED: BlockedWarningView = {
  eventLabel: "Bought a home",
  month: 12,
  shortfallCents: dollarsToCents(139_476),
};

function render(warning: BlockedWarningView) {
  return renderToStaticMarkup(<BlockedWarning warning={warning} />);
}

describe("BlockedWarning", () => {
  it("names the event, its month, and the shortfall net of tax", () => {
    const html = render(STRANDED);
    expect(html).toContain("Bought a home");
    // The shared month label — the same "Year N (YYYY)" every other surface reads.
    expect(html).toContain("Year 1 (2027)");
    expect(html).toContain("$139,476");
  });

  it("uses the soft-warning pattern — persistent, and carrying no dismiss control", () => {
    const html = render(STRANDED);
    expect(html).toContain("soft-warning");
    // Non-dismissible: nothing to click to make it go away — it clears only when the block does.
    expect(html).not.toContain("<button");
  });
});
