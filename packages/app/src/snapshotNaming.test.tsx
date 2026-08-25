/**
 * @vitest-environment jsdom
 *
 * The dated Balances list, read as a person would read it.
 *
 * Everything in it is money the household has or owes, so every row has to be nameable. One was
 * not: the engine's borrowing of last resort is a real revolving card in the model, but nobody
 * authored it and so it carried no label — the list printed `synthetic-credit-card (owed)`, which
 * names an implementation rather than a debt. Another printed a minus sign it had no business
 * printing, so a card carrying no balance read "−$0".
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

/** The dated snapshot's Balances section at `month`. */
function balancesAt(month: number): HTMLElement {
  fireEvent.change(screen.getByLabelText(/Scrub to a month/), { target: { value: String(month) } });
  const h = screen.getByRole("heading", { name: /^Balances/, level: 3 });
  if (h.parentElement === null) throw new Error("no balances section");
  return h.parentElement;
}

describe("what the balances list calls each thing", () => {
  it("names the engine's last-resort borrowing as the credit card it is", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "living-on-credit" },
    });
    const balances = within(balancesAt(24));
    expect(balances.getByText(/Credit card \(owed\)/)).toBeTruthy();
    expect(balances.queryByText(/synthetic-credit-card/)).toBeNull();
  });

  it("prints a debt of nothing as nothing, not as minus nothing", () => {
    // The row knows it is a debt, so it used to print a debt's sign whatever the amount — and a
    // card that has never been drawn on read "Credit card (owed) −$0". Month 0 of this scenario
    // is exactly that: the card exists, and nothing has been borrowed on it yet.
    render(<App />);
    fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
      target: { value: "living-on-credit" },
    });
    const balances = within(balancesAt(0));

    expect(balances.getByText(/Credit card \(owed\)/).parentElement?.textContent).toBe(
      "Credit card (owed)$0",
    );
    // And the sign still appears the moment there is something to owe.
    expect(within(balancesAt(24)).getByText("−$24,968")).toBeTruthy();
  });
});
