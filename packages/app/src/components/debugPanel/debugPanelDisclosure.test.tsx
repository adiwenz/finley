/**
 * @vitest-environment jsdom
 *
 * The month table is built when the disclosure is opened, not before. Its own file because
 * `debugPanel.test.tsx` renders through the server renderer on purpose, which has no toggle to
 * fire — and this behaviour is only observable once there is a document.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DebugPanel } from "./debugPanel";
import { runOf } from "../../testing/projectionHarness";
import { PLAN_DEFAULTS } from "../../planDefaults";

afterEach(cleanup);

function renderPanel() {
  const result = runOf(PLAN_DEFAULTS);
  return render(
    <DebugPanel report={result.report} budget={PLAN_DEFAULTS} month0={result.series.months[0]!} />,
  );
}

describe("DebugPanel — the month table is deferred until opened", () => {
  it("renders no table while closed, and the configuration readout regardless", () => {
    const { container } = renderPanel();
    expect(container.querySelector("table")).toBeNull();
    // The part the panel's other tests assert on is NOT deferred: it is small, and gating it
    // would hide the resolved growth rates behind an interaction.
    expect(screen.getByText("Growth rates (resolved)")).toBeTruthy();
  });

  it("builds the table on open, and it is by far the bulk of the panel", () => {
    const { container } = renderPanel();
    const closedNodes = container.querySelectorAll("*").length;

    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    // A month column at minimum, and the annual sampling means many rows.
    expect(table!.querySelectorAll("tbody tr").length).toBeGreaterThan(10);
    // The point of deferring it: opening more than doubles the panel.
    expect(container.querySelectorAll("*").length).toBeGreaterThan(closedNodes * 2);
  });
});
