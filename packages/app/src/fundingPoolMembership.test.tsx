/**
 * @vitest-environment jsdom
 *
 * Whose accounts a money-out form offers to pay with, on the date the event is dated.
 *
 * The whole-plan views are deliberately omniscient — every partner the household will ever have
 * draws bands across the charts from month 0. A funding picker is not one of those views. It asks
 * a dated question, "what can pay for this, then", and it was answering with the accounts of a
 * partner who had not arrived yet and of one who had already left, both sitting at $0. The list of
 * accounts described a household the list of people beside it did not.
 *
 * Driven through the whole App on the sequential-partners scenario, because the defect is in the
 * seam between the event's date and the engine's pool: Alex is with Blake from before the plan
 * starts until Year 5, alone for two years, and with Casey from Year 7.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { App } from "./main";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

/** Load a scenario and open one of the money-out forms on it. */
function open(eventType: "OneTimeSpendEvent" | "HomePurchaseEvent"): void {
  render(<App />);
  fireEvent.change(screen.getByLabelText(/Start from a scenario/), {
    target: { value: "partner-sequential" },
  });
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: eventType } });
}

/** Move the event to a year on the plan's timeline. */
const dateIt = (year: number) =>
  fireEvent.change(screen.getByLabelText("When"), { target: { value: String(year * 12) } });

/** Every account the picker is currently offering, by the name it shows. */
const offered = (): string[] =>
  screen
    .getAllByRole("checkbox")
    .map((c) => c.getAttribute("aria-label") ?? "")
    .filter((l) => l !== "");

/** Whether anything on the list belongs to a named person, however that name is worn. */
const someFrom = (who: string) => (labels: string[]) => labels.some((l) => l.includes(who));

describe("the funding pool is the household at the event's date", () => {
  it("offers the partner of the moment, and never the one still to come", () => {
    open("OneTimeSpendEvent");
    dateIt(0);
    const labels = offered();
    expect(someFrom("Blake")(labels)).toBe(true);
    // Casey joins in Year 7. Their accounts existed in the pool at $0 from month 0.
    expect(someFrom("Casey")(labels)).toBe(false);
    expect(someFrom("Alex")(labels)).toBe(true);
  });

  it("drops a partner's accounts once they have left", () => {
    open("OneTimeSpendEvent");
    dateIt(6);
    const labels = offered();
    expect(someFrom("Blake")(labels)).toBe(false);
    expect(someFrom("Casey")(labels)).toBe(false);
    // Alex is the household in those two years, and their accounts are all of it.
    expect(someFrom("Alex")(labels)).toBe(true);
  });

  it("offers the second partner's accounts from the year they join", () => {
    open("OneTimeSpendEvent");
    dateIt(8);
    const labels = offered();
    expect(someFrom("Casey")(labels)).toBe(true);
    expect(someFrom("Blake")(labels)).toBe(false);
  });

  it("applies the same rule to a home purchase's down payment", () => {
    open("HomePurchaseEvent");
    dateIt(8);
    const labels = offered();
    expect(someFrom("Casey")(labels)).toBe(true);
    expect(someFrom("Blake")(labels)).toBe(false);
  });

  it("clears an account the new date has put outside the household", () => {
    // The gesture that made the stale list dangerous rather than merely wrong: pick a partner's
    // account while they are here, then move the event past the day they leave.
    open("OneTimeSpendEvent");
    dateIt(0);
    const blakes = screen
      .getAllByRole("checkbox")
      .find((c) => (c.getAttribute("aria-label") ?? "").startsWith("Blake’s")) as HTMLInputElement;
    fireEvent.click(blakes);
    expect(blakes.checked).toBe(true);

    dateIt(6);
    expect(someFrom("Blake")(offered())).toBe(false);
    // Nothing is left checked in Blake's place — the form does not quietly substitute an account.
    expect(
      screen.getAllByRole("checkbox").filter((c) => (c as HTMLInputElement).checked),
    ).toHaveLength(0);
  });

  it("names an account the same way the dated snapshot does", () => {
    // Two naming schemes on one screen: the engine labels a partner's account "Casey — Cash
    // savings" and the primary's plain "Cash savings", while the snapshot says "Alex's cash
    // savings" for both. One reader, one vocabulary.
    open("OneTimeSpendEvent");
    dateIt(0);
    const labels = offered();
    expect(labels.some((l) => l.startsWith("Alex’s cash savings"))).toBe(true);
    expect(labels.some((l) => l.includes(" — Cash savings"))).toBe(false);
  });

  it("leaves a one-person household's list exactly as it was", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("What happened?"), {
      target: { value: "OneTimeSpendEvent" },
    });
    // Nobody to distinguish the accounts from, so they keep the names they were authored with.
    expect(offered().some((l) => l.startsWith("Cash savings"))).toBe(true);
  });
});
