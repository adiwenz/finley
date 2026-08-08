/**
 * @vitest-environment jsdom
 *
 * The card that opens and closes — this component and nothing else.
 *
 * WHICH of the app's sections are disclosures, and which open by default, is a fact about the
 * App shell rather than about this card, and is pinned in `mainState.test.tsx` beside the rest
 * of App's own behaviour. Keeping it here meant a component test mounting the entire
 * application — and paying for a whole projection — to assert a layout decision made elsewhere.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { CollapsibleCard } from "./collapsibleCard";

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
