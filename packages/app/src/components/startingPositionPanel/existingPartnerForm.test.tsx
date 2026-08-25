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
      // The field's own default, and the only split there is — 50/50 is a percentage, not a mode.
      partnerSharePercent: 50,
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

/**
 * Bounds that used to be absent or silent. A relationship cannot predate the person in it, and a
 * balance the form refuses has to say it refused — a partner arriving with $0 because a typed
 * −$5,000 was quietly rewritten is a plan the user never authored and cannot see they didn't.
 */
describe("ExistingPartnerForm — bounds it states out loud", () => {
  it("cannot be together longer than the partner has been alive", () => {
    // A 20-year-old together for 30 years began the relationship at −10, which the plan would
    // otherwise simulate as an ordinary past.
    const { startPartnered } = renderForm();
    enterNumber(spin(/Their age today/i), "20");
    enterNumber(spin(/Together for/i), "30");
    fireEvent.click(btn(/^Add$/));
    // Clamped to their 20 years less the 16-year floor on when a relationship may begin.
    expect(startPartnered).toHaveBeenCalledWith(
      expect.objectContaining({ partneredForMonths: 4 * 12 }),
    );
  });

  it("says so when it clamps, rather than quietly recording something else", () => {
    renderForm();
    enterNumber(spin(/Their age today/i), "20");
    enterNumber(spin(/Together for/i), "30");
    expect(screen.getByText(/30 yr isn't allowed here/i).textContent).toMatch(
      /using 4 yr, the highest this can be/i,
    );
  });

  it("pulls an already-entered relationship length down when the age drops", () => {
    // The bound has to hold however the form is filled in, not only in field order.
    const { startPartnered } = renderForm();
    enterNumber(spin(/Together for/i), "30");
    enterNumber(spin(/Their age today/i), "20");
    fireEvent.click(btn(/^Add$/));
    expect(startPartnered).toHaveBeenCalledWith(
      expect.objectContaining({ partneredForMonths: 4 * 12 }),
    );
  });

  it("refuses a negative balance and explains what it recorded instead", () => {
    const { startPartnered } = renderForm();
    enterNumber(spin(/Their cash savings/i), "-5000");
    expect(screen.getByText(/\$-5,000 isn't allowed here/i).textContent).toMatch(
      /using \$0, the lowest this can be/i,
    );

    fireEvent.click(btn(/^Add$/));
    expect(startPartnered).toHaveBeenCalledWith(
      expect.objectContaining({
        accounts: expect.objectContaining({ savingsBalanceCents: 0 }),
      }),
    );
  });

  it("drops the explanation once the user types again", () => {
    // The note is an answer to a specific commit, not a state the field gets stuck in.
    renderForm();
    const savings = spin(/Their cash savings/i);
    enterNumber(savings, "-5000");
    expect(screen.getByText(/isn't allowed here/i)).toBeTruthy();

    fireEvent.change(savings, { target: { value: "1200" } });
    expect(screen.queryByText(/isn't allowed here/i)).toBeNull();
  });
});
