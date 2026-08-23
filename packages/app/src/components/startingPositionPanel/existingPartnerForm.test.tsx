/**
 * @vitest-environment jsdom
 *
 * ExistingPartnerForm — a partner already in the household at plan start. Pins that the form
 * hands `startPartnered` months-together (not a month), and derives the birth year from the
 * age entered rather than asking for it directly.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import type { Projection } from "@finley/engine";
import { ExistingPartnerForm } from "./existingPartnerForm";

afterEach(cleanup);

function renderForm() {
  const startPartnered = vi.fn();
  const onDone = vi.fn();
  const onAdd = (write: (p: Projection) => void) =>
    write({ startPartnered } as unknown as Projection);
  render(<ExistingPartnerForm onAdd={onAdd} onDone={onDone} />);
  return { startPartnered, onDone };
}

const spin = (name: RegExp) => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const btn = (name: RegExp) => screen.getByRole("button", { name });

describe("ExistingPartnerForm", () => {
  it("authors a partner anchored on months together, defaulting an unnamed partner", () => {
    const { startPartnered, onDone } = renderForm();
    enterNumber(spin(/Their age today/i), "45");
    enterNumber(spin(/Together for/i), "10");
    fireEvent.click(btn(/^Add$/));

    const currentYear = new Date().getFullYear();
    expect(startPartnered).toHaveBeenCalledWith({
      partneredForMonths: 120,
      name: "Partner",
      birthYear: currentYear - 45,
      // The field's own default, not a value inherited from the primary: the engine requires a
      // partner's own expectancy, so the form shows one the user can see and change.
      lifeExpectancy: 90,
      // Stated, not omitted: a partner who brings nothing brings exactly zero, and the balance
      // fields default to it rather than leaving the engine to assume it.
      accounts: {
        savingsBalanceCents: 0,
        retirementBalanceCents: 0,
        brokerageBalanceCents: 0,
      },
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("carries an entered life expectancy through — theirs, not the household's", () => {
    const { startPartnered } = renderForm();
    enterNumber(spin(/Their age today/i), "45");
    enterNumber(spin(/Their life expectancy/i), "97");
    fireEvent.click(btn(/^Add$/));
    expect(startPartnered).toHaveBeenCalledWith(
      expect.objectContaining({ lifeExpectancy: 97 }),
    );
  });

  // The floor under an expectancy is the person's OWN age, not a number picked for a
  // retirement-aged household. A `Math.max(60, age)` used to sit here, so a 40-year-old partner
  // could not be projected to anything under 60 — the field silently rewrote what was typed.
  describe("the life-expectancy floor is this partner's own age", () => {
    it("lets a 40-year-old partner be projected to 41", () => {
      const { startPartnered } = renderForm();
      enterNumber(spin(/Their age today/i), "40");
      const expectancy = spin(/Their life expectancy/i);
      expect(Number(expectancy.min)).toBe(41);

      enterNumber(expectancy, "41");
      fireEvent.click(btn(/^Add$/));
      expect(startPartnered).toHaveBeenCalledWith(
        expect.objectContaining({ lifeExpectancy: 41 }),
      );
    });

    it("still refuses to author one AT their age — the engine's own boundary", () => {
      // 40 is the month-0 death `invalidAge` rejects, so the field clamps up to 41 rather than
      // committing a value the write would throw on.
      const { startPartnered } = renderForm();
      enterNumber(spin(/Their age today/i), "40");
      enterNumber(spin(/Their life expectancy/i), "40");
      fireEvent.click(btn(/^Add$/));
      expect(startPartnered).toHaveBeenCalledWith(
        expect.objectContaining({ lifeExpectancy: 41 }),
      );
    });

    it("follows the age field, so an older partner raises the floor", () => {
      renderForm();
      enterNumber(spin(/Their age today/i), "76");
      expect(Number(spin(/Their life expectancy/i).min)).toBe(77);
    });
  });

  it("carries an entered name through unchanged", () => {
    const { startPartnered } = renderForm();
    fireEvent.change(screen.getByPlaceholderText(/Partner's name/i), {
      target: { value: "Jordan" },
    });
    fireEvent.click(btn(/^Add$/));
    expect(startPartnered).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Jordan" }),
    );
  });

  it("carries the partner's own opening balances into startPartnered", () => {
    const { startPartnered } = renderForm();
    enterNumber(spin(/Their cash savings/i), "12000");
    enterNumber(spin(/Their retirement account/i), "85000");
    enterNumber(spin(/Their brokerage/i), "40000");
    fireEvent.click(btn(/^Add$/));

    // Dollars in the form, cents to the engine — and their own accounts, never folded into the
    // primary's opening balance.
    expect(startPartnered).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: {
          savingsBalanceCents: 1_200_000,
          retirementBalanceCents: 8_500_000,
          brokerageBalanceCents: 4_000_000,
        },
      }),
    );
  });
});
