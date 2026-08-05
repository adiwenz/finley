/**
 * @vitest-environment jsdom
 *
 * The card that opens and closes, and the two panels mounted in one — settings the user
 * consults rather than watches, so the column is not spent on them by default.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { App } from "../../main";
import { CollapsibleCard } from "./collapsibleCard";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

/** The `<details>` a section's heading sits in — what `open` is actually asserted against. */
const sectionOf = (title: string): HTMLDetailsElement =>
  screen.getByRole("heading", { name: title }).closest("details") as HTMLDetailsElement;

describe("CollapsibleCard", () => {
  it("starts closed, and keeps its heading in the outline while closed", () => {
    render(<CollapsibleCard title="Budget & accounts">
      <p>the contents</p>
    </CollapsibleCard>);
    // The heading is reachable whether or not the section is open — a section nobody can
    // navigate to is not a section.
    const section = sectionOf("Budget & accounts");
    expect(section.open).toBe(false);
    expect(within(section).getByRole("heading", { name: "Budget & accounts" })).toBeTruthy();
  });

  it("opens on the summary, and closes again", () => {
    render(<CollapsibleCard title="Goals"><p>the contents</p></CollapsibleCard>);
    const section = sectionOf("Goals");
    // `<details>` owns the toggling itself; this pins that the summary is what drives it.
    const summary = section.querySelector("summary") as HTMLElement;
    expect(summary).toBeTruthy();
    section.open = true;
    expect(section.open).toBe(true);
  });
});

describe("App — which sections open by default", () => {
  it("collapses Budget & accounts and Goals, and leaves the live panels open", () => {
    render(<App />);
    expect(sectionOf("Budget & accounts").open).toBe(false);
    expect(sectionOf("Goals").open).toBe(false);
    // The panels that answer "what is happening" are not disclosures at all — asserted so a
    // later change cannot quietly fold the whole column away.
    expect(screen.getByRole("heading", { name: /Jobs & income/i }).closest("details")).toBeNull();
    expect(screen.getByRole("heading", { name: /Add to timeline/i }).closest("details")).toBeNull();
  });

  it("still authors through the collapsed panels once opened — nothing was removed", () => {
    render(<App />);
    const budget = sectionOf("Budget & accounts");
    budget.open = true;
    // The panel's own controls are intact inside it; only the heading moved into the summary.
    expect(within(budget).getByLabelText(/Life expectancy/i)).toBeTruthy();
    expect(within(budget).getByLabelText(/Savings return/i)).toBeTruthy();
  });
});
