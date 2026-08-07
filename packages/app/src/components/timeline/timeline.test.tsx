/**
 * @vitest-environment jsdom
 *
 * The timeline's status indicators. Every authored event still gets a row; the blocking event and
 * the events the stopped projection never reached get a badge, executed events none — the same
 * three-state outcome the engine reports, rendered against the right row.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import type { MarkerOutcome, TimelineMarker } from "../../ledgerView";
import { Timeline } from "./timeline";

afterEach(cleanup);

/** A marker per outcome, at ascending months, with just the fields the component reads. */
function marker(outcome: MarkerOutcome, month: number, label: string): TimelineMarker {
  return { id: `${outcome}-${month}`, month, type: "HomePurchaseEvent", label, detail: "", outcome };
}

const noop = () => {};

function renderTimeline(markers: readonly TimelineMarker[]) {
  render(
    <Timeline
      markers={markers}
      scrubMonth={0}
      horizonMonths={600}
      editableTypes={new Set()}
      onScrub={noop}
      onEdit={noop}
      onRemove={noop}
    />,
  );
}

describe("Timeline — outcome indicators", () => {
  it("badges the blocking and not-reached rows, and leaves executed rows unbadged", () => {
    renderTimeline([
      marker("executed", 6, "Bought a home"),
      marker("blocked", 12, "Bought a home"),
      marker("not-reached", 60, "Bought a home"),
    ]);
    // One badge each for the two non-executed outcomes — the executed row carries neither text.
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText("Not reached")).toBeTruthy();

    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).queryByText("Blocked")).toBeNull();
    expect(within(rows[0]).queryByText("Not reached")).toBeNull();
    expect(within(rows[1]).getByText("Blocked")).toBeTruthy();
    expect(within(rows[2]).getByText("Not reached")).toBeTruthy();
  });

  it("still shows a row for every authored event regardless of outcome", () => {
    renderTimeline([
      marker("executed", 6, "Bought a home"),
      marker("blocked", 12, "Bought a home"),
      marker("not-reached", 60, "Bought a home"),
    ]);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });
});
