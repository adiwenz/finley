/**
 * @vitest-environment jsdom
 *
 * A number typed into an edit form reaches the event.
 *
 * Every number the app authors goes through `NumInput`, which turns a typed figure into a fact on
 * BLUR rather than on each keystroke — the whole plan re-projects on every write, so per-keystroke
 * fields ask what happens if you retire at 4 on the way to 45. That contract quietly assumed that
 * reaching for Save takes focus out of the field first, and a button is not required to take focus
 * when it is clicked. On macOS it does not. So the gesture everyone actually makes — type the last
 * number, click Save — submitted the form with that figure still uncommitted inside the field: the
 * event kept the value from before the edit, the form closed reporting success, and nothing said an
 * edit had been dropped. Selects and text inputs persisted, because they write on `change`; the two
 * percentage-split fields persisted, because they are the one pair that opts into a live handler.
 * Everything else on every form silently reverted.
 *
 * These drive the gesture rather than a helper: `fireEvent.change` alone leaves the field focused
 * and uncommitted, and the pointer sequence is what a click really is. `enterNumber` would blur
 * first and so could never have caught this.
 *
 * Written against the whole App, per event type, because the defect was in the seam between a
 * field and a form and neither on its own could show it.
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

/** Type into a field and leave it UNCOMMITTED — the half-gesture that used to lose the figure. */
function type(field: HTMLInputElement, value: number | string): void {
  field.focus();
  fireEvent.change(field, { target: { value: String(value) } });
}

/** Click, as a pointer really does it: down first, which is when a field is left. */
function click(el: HTMLElement): void {
  fireEvent.pointerDown(el);
  fireEvent.click(el);
}

/** Author an event of `type` from the add form, filling `fill` before submitting. */
function addEvent(eventType: string, fill: () => void = () => {}): void {
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: eventType } });
  fill();
  click(screen.getByText("Add event"));
}

/** Reopen the one event on the timeline for editing. */
function reopen(): void {
  click(screen.getAllByText("Edit")[0]);
}

function save(): void {
  click(screen.getByText("Save changes"));
}

/** The dated snapshot section under a given heading. */
function snapshotSection(heading: RegExp): HTMLElement {
  const h = screen.getByRole("heading", { name: heading, level: 3 });
  if (h.parentElement === null) throw new Error(`no section for ${heading}`);
  return h.parentElement;
}

describe("a numeric edit reaches the event it was typed into", () => {
  it("keeps a partner's brought savings, and gives them to the partner", () => {
    render(<App />);
    addEvent("RelationshipEvent", () => {
      fireEvent.change(screen.getByPlaceholderText(/Partner's name/i), {
        target: { value: "Robin" },
      });
    });

    reopen();
    type(spin(/Their cash savings/i), 55_000);
    save();

    reopen();
    expect(spin(/Their cash savings/i).value).toBe("55000");

    // And the projection heard about it: the money is in their account at the month they join.
    click(screen.getByText("Cancel"));
    const row =
      within(snapshotSection(/^Balances/)).getByText(/Robin’s cash savings/).parentElement
        ?.textContent ?? "";
    expect(Number(/\$([\d,]+)/.exec(row)?.[1].replace(/,/g, "") ?? 0)).toBeGreaterThanOrEqual(
      55_000,
    );
  });

  it("keeps a partner's life expectancy, and ends their life at it", () => {
    render(<App />);
    addEvent("RelationshipEvent", () => {
      fireEvent.change(screen.getByPlaceholderText(/Partner's name/i), {
        target: { value: "Robin" },
      });
    });

    reopen();
    // Their age opens at 40, so 45 is five years off and well inside the horizon.
    type(spin(/Their life expectancy/i), 45);
    save();

    reopen();
    expect(spin(/Their life expectancy/i).value).toBe("45");
    click(screen.getByText("Cancel"));

    // The roster the snapshot prints is the projection's answer, so it is the one that proves the
    // figure was not merely echoed back by the form.
    const roster = () => snapshotSection(/^Household$/).textContent ?? "";
    expect(roster()).toContain("Robin");
    fireEvent.change(screen.getAllByRole("slider", { name: /Scrub to a month/i })[0], {
      target: { value: "120" },
    });
    expect(roster()).not.toContain("Robin");
  });

  it("keeps a partner's age today", () => {
    render(<App />);
    addEvent("RelationshipEvent");
    reopen();
    type(spin(/Their age in/i), 33);
    save();
    reopen();
    expect(spin(/Their age in/i).value).toBe("33");
  });

  it("keeps a separation's alimony, and pays it out", () => {
    render(<App />);
    addEvent("RelationshipEvent");
    addEvent("SeparationEvent");

    click(screen.getAllByText("Edit")[1]);
    type(spin(/Alimony \/ mo/i), 1_500);
    save();

    click(screen.getAllByText("Edit")[1]);
    expect(spin(/Alimony \/ mo/i).value).toBe("1500");
    click(screen.getByText("Cancel"));

    // The flow itself, not just the field: a monthly obligation the household now carries.
    expect(screen.getByText(/Alimony/i)).toBeTruthy();
  });

  it("keeps a loan's balance today", () => {
    render(<App />);
    addEvent("LoanEvent");
    reopen();
    // A loan authored now is money arriving, so the field opens as "Amount"; one dated in the past
    // is a balance already owed. Either way it is the same field on the same draft.
    const owed = /^(Balance today|Amount)/;
    type(spin(owed), 42_000);
    save();
    reopen();
    expect(spin(owed).value).toBe("42000");
  });

  it("reopens a loan's APR as the rate that was entered, not as its binary echo", () => {
    // The form authors a rate as a fraction and reads it back as a percentage, and 7/100*100 is
    // 7.000000000000001 — which the field printed in full. 7 is the one APR in the ordinary range
    // that does this, so it is the one worth pinning.
    render(<App />);
    addEvent("LoanEvent");
    reopen();
    type(spin(/^APR/), 7);
    save();
    reopen();
    expect(spin(/^APR/).value).toBe("7");
  });

  it("keeps a one-time spend's amount", () => {
    render(<App />);
    // A spend needs a purpose, an amount, and somewhere to take it from before Add will take it.
    addEvent("OneTimeSpendEvent", () => {
      fireEvent.change(screen.getByPlaceholderText(/Car, wedding/i), { target: { value: "Car" } });
      const field = spin(/^Amount/);
      fireEvent.change(field, { target: { value: "3000" } });
      fireEvent.blur(field);
      fireEvent.click(screen.getAllByRole("checkbox")[0]);
    });
    reopen();
    type(spin(/^Amount/), 7_500);
    save();
    reopen();
    expect(spin(/^Amount/).value).toBe("7500");
  });

  it("keeps a child's annual cost", () => {
    render(<App />);
    addEvent("ChildEvent");
    reopen();
    type(spin(/Annual cost/i), 21_000);
    save();
    reopen();
    expect(spin(/Annual cost/i).value).toBe("21000");
  });

  it("keeps a home purchase's down payment", () => {
    render(<App />);
    // A purchase the household can actually fund, so there is an event to reopen at all.
    addEvent("HomePurchaseEvent", () => {
      for (const [name, value] of [[/^Price/, 150_000], [/^Down payment/, 5_000]] as const) {
        const field = spin(name);
        fireEvent.change(field, { target: { value: String(value) } });
        fireEvent.blur(field);
      }
    });
    reopen();
    type(spin(/Down payment/i), 65_000);
    save();
    reopen();
    expect(spin(/Down payment/i).value).toBe("65000");
  });
});
