/**
 * @vitest-environment jsdom
 *
 * Add-event sub-forms hold their fields in a single draft object rather than a `useState` per
 * field. These pin what the consolidation must keep: field-revealing gates track their driving
 * value, and the submitted event is unchanged.
 *
 * The loan form is the notable one: `kind` gates the term field, so the draft is a
 * discriminated union on `kind` (mirroring the engine's `LoanEvent`). A credit card drops the
 * term arm entirely, so the last-entered term is remembered across a toggle — the same
 * "restore my value" affordance as `jobForm`'s open-ended `endAge`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { enterNumber } from "../../testing/numberField";
import type { Projection, ProjectionResult } from "@finley/engine";
import { LoanForm } from "./loanForm";
import { SeparationForm } from "./separationForm";
import { ChildForm } from "./childForm";

afterEach(cleanup);

/**
 * A stubbed {@link Projection} whose transaction methods only record their input, plus the
 * `onAdd` that runs a form's write against it. The forms author through the facade now, so a
 * test asserts the *input* a form hands `takeLoan` / `separate` / `haveChild`, not a raw event.
 */
function stubProjection() {
  const p = {
    takeLoan: vi.fn(),
    separate: vi.fn(),
    haveChild: vi.fn(),
  };
  const onAdd = (write: (projection: Projection) => void) => write(p as unknown as Projection);
  return { p, onAdd };
}

/** You plus a partner from month 0 — all the separation form reads of a run
 *  (`membersAt`, and only each person's `{id,name}`). */
const withPartner = {
  membersAt: () => [
    { id: "p1", name: "You" },
    { id: "p2", name: "Partner" },
  ],
} as unknown as ProjectionResult;

const spin = (name: RegExp | string) =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;

describe("LoanForm — kind gates the term", () => {
  it("drops the term field for a revolving credit card, and restores the typed term when switched back", () => {
    render(<LoanForm defaultMonth={0} horizonMonths={660} onAdd={vi.fn()} />);

    // Type a term that differs from the default so a reset would be visible.
    enterNumber(spin(/Term/i), "7");

    // Credit cards are revolving — no term. The field disappears.
    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "creditCard" },
    });
    expect(screen.queryByRole("spinbutton", { name: /Term/i })).toBeNull();

    // Back to amortizing: the field returns with the user's 7, not the default 5.
    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "studentLoan" },
    });
    expect(Number(spin(/Term/i).value)).toBe(7);
  });

  it("takes out a credit card with a credit limit and no term; an amortizing loan with a term", () => {
    const { p, onAdd } = stubProjection();
    render(<LoanForm defaultMonth={0} horizonMonths={660} onAdd={onAdd} />);

    enterNumber(spin(/Amount/i), "10000");
    enterNumber(spin(/Term/i), "6");
    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    expect(p.takeLoan).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "studentLoan", termMonths: 72 }),
    );
    expect(p.takeLoan.mock.calls[0][0]).not.toHaveProperty("creditLimitCents");

    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "creditCard" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    const cc = p.takeLoan.mock.calls[1][0];
    expect(cc).toMatchObject({ kind: "creditCard" });
    expect(cc).toHaveProperty("creditLimitCents");
    expect(cc).not.toHaveProperty("termMonths");
  });
});

describe("SeparationForm — alimony amount gates its duration", () => {
  it("reveals the alimony-years field only once an alimony amount is entered, and folds it into the event", () => {
    const { p, onAdd } = stubProjection();
    render(
      <SeparationForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={onAdd}
        result={withPartner}
      />,
    );

    // No alimony amount yet → nothing to time, so no duration field.
    expect(screen.queryByRole("spinbutton", { name: /Alimony years/i })).toBeNull();

    enterNumber(spin(/Alimony \/ mo/i), "500");
    enterNumber(spin(/Alimony years/i), "3");

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    expect(p.separate).toHaveBeenCalledWith(
      expect.objectContaining({
        partnerPersonId: "p2",
        alimonyMonthlyCents: 500_00,
        alimonyDurationMonths: 36,
      }),
    );
  });
});

describe("ChildForm — single-draft consolidation preserves submit", () => {
  it("has a child, carrying the edited name, month and annual cost", () => {
    const { p, onAdd } = stubProjection();
    render(<ChildForm defaultMonth={0} horizonMonths={660} onAdd={onAdd} />);

    fireEvent.change(screen.getByPlaceholderText(/Child's name/i), { target: { value: "Robin" } });
    enterNumber(spin(/Annual cost/i), "20000");
    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));

    expect(p.haveChild).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Robin",
        annualCostCents: 20000 * 100,
      }),
    );
  });
});
