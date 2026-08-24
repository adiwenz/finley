/**
 * @vitest-environment jsdom
 *
 * A partner authored through *Add event* is a member of the household on the same terms as one
 * that arrived with a preset.
 *
 * Two things used to make that untrue, and both of them were invisible. The money they were given
 * never reached them, because the field holding it commits on blur and clicking Save does not
 * always blur — so the form closed on success having written the figure the field held before the
 * edit. And every person toggle in the app was built from the bands that got DRAWN rather than
 * from the household roster, so a partner who owned nothing was offered nowhere, while a preset
 * partner — who always arrives funded — was offered everywhere. Together they read as "a partner
 * added by hand is not really in the plan".
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { App } from "./main";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;

/**
 * Author a partner the way a person does: open the form, type, and click Add — WITHOUT blurring
 * the last field first, which is the gesture that lost the money.
 */
function addPartner({ name, savings }: { readonly name: string; readonly savings: number }) {
  fireEvent.change(screen.getByLabelText("What happened?"), {
    target: { value: "RelationshipEvent" },
  });
  fireEvent.change(screen.getByPlaceholderText(/Partner's name/i), { target: { value: name } });
  const field = spin(/Their cash savings/i);
  field.focus();
  fireEvent.change(field, { target: { value: String(savings) } });
  const add = screen.getByText("Add event");
  fireEvent.pointerDown(add);
  fireEvent.click(add);
}

/** The dated snapshot's own Household list — the roster it says the plan has at that month. */
function snapshotSection(heading: RegExp): HTMLElement {
  const h = screen.getByRole("heading", { name: heading, level: 3 });
  const section = h.parentElement;
  if (section === null) throw new Error(`no section for ${heading}`);
  return section;
}

/** The person buttons in one of the three "Whose …" groups, by their visible names. */
const toggleNames = (group: RegExp): string[] => {
  const el = screen.queryByRole("group", { name: group });
  return el === null
    ? []
    : within(el)
        .getAllByRole("button")
        .map((b) => b.textContent ?? "");
};

describe("a partner added through the UI", () => {
  it("arrives with the money that was typed for them", () => {
    render(<App />);
    addPartner({ name: "Robin", savings: 40_000 });
    // The snapshot opens at "now", which is the month this partnership starts.
    expect(within(snapshotSection(/^Household$/)).getByText("Robin")).toBeTruthy();
    // Their account is in the dated balances at that month, holding what was typed — not the $0
    // the field's uncommitted edit used to leave behind.
    const balances = within(snapshotSection(/^Balances/));
    const row = balances.getByText(/savings-person-/).parentElement?.textContent ?? "";
    // The typed figure, carrying a month of interest — and emphatically not the $0 an
    // uncommitted field used to submit.
    expect(Number(/\$([\d,]+)/.exec(row)?.[1].replace(/,/g, "") ?? 0)).toBeGreaterThanOrEqual(40_000);
  });

  it("is offered as a cut of cash flow, tax and net worth alike", () => {
    render(<App />);
    expect(toggleNames(/Whose net worth/)).toEqual([]);
    addPartner({ name: "Robin", savings: 40_000 });
    for (const group of [/Whose cash flow/, /Whose tax/, /Whose net worth/]) {
      expect(toggleNames(group)).toEqual(["Combined", "Alex", "Robin"]);
    }
  });

  it("is offered even when they bring nothing at all", () => {
    // The case the band-derived list could never register: a member who owns no money owns no
    // band, and so was never a person the reader could ask about. An empty cut is the answer.
    render(<App />);
    addPartner({ name: "Robin", savings: 0 });
    for (const group of [/Whose cash flow/, /Whose tax/, /Whose net worth/]) {
      expect(toggleNames(group)).toContain("Robin");
    }
  });

  it("keeps the same cuts on offer whichever cash-flow view is showing", () => {
    // "Coming in" used to offer whoever drew an inflow band there, so switching view could drop a
    // person from the toggle — which reads as losing them rather than as their income being nil.
    render(<App />);
    addPartner({ name: "Robin", savings: 40_000 });
    const inflows = toggleNames(/Whose cash flow/);
    fireEvent.click(screen.getByRole("radio", { name: /Going out/i }));
    expect(toggleNames(/Whose cash flow/)).toEqual(inflows);
  });

  it("counts what they brought toward the household's own net worth", () => {
    render(<App />);
    const before = screen.getByTestId("breakdown-summary").textContent ?? "";
    addPartner({ name: "Robin", savings: 40_000 });
    const after = screen.getByTestId("breakdown-summary").textContent ?? "";
    expect(after).not.toBe(before);
    // Their savings account is one of the accounts the combined breakdown is drawn from.
    const combined = Number(/across (\d+) account/.exec(after)?.[1] ?? 0);
    const beforeCount = Number(/across (\d+) account/.exec(before)?.[1] ?? 0);
    expect(combined).toBeGreaterThan(beforeCount);
  });
});

/**
 * A possessive needs something to possess.
 *
 * The person cuts were built by gluing "Blake's " onto the front of the household's own sentence,
 * which opens with its verb — so the summary read "Blake's Peaks around $371,266 net worth". The
 * person's version has to be its own sentence, built around the noun.
 */
describe("how a person's own cut reads", () => {
  /** Select one person's cut in a "Whose …" group. */
  const pick = (group: RegExp, person: string) =>
    fireEvent.click(within(screen.getByRole("group", { name: group })).getByText(person));

  it("says whose net worth it is without stranding the apostrophe on a verb", () => {
    render(<App />);
    addPartner({ name: "Robin", savings: 40_000 });
    pick(/Whose net worth/, "Robin");
    const summary = screen.getByTestId("breakdown-summary").textContent ?? "";
    expect(summary).toContain("Robin's net worth peaks around");
    expect(summary).not.toContain("Robin's Peaks");
  });

  it("keeps the household's version impersonal", () => {
    render(<App />);
    addPartner({ name: "Robin", savings: 40_000 });
    const combined = screen.getByTestId("breakdown-summary").textContent ?? "";
    expect(combined).toContain("Peaks around");
    expect(combined).not.toContain("'s net worth peaks");
  });

  it("does not staple a possessive onto the cash-flow chart's title either", () => {
    render(<App />);
    addPartner({ name: "Robin", savings: 40_000 });
    pick(/Whose cash flow/, "Robin");
    const label =
      screen
        .getAllByRole("img")
        .map((el) => el.getAttribute("aria-label") ?? "")
        .find((l) => l.includes("cash")) ?? "";
    // "Robin's Monthly cash coming in" was not a phrase.
    expect(label).not.toMatch(/Robin's Monthly/);
    expect(label).toMatch(/^Robin's share\. /);
  });
});
