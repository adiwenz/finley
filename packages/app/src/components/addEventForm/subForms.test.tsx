/**
 * @vitest-environment jsdom
 *
 * Add-event sub-forms (§10.5, issue #115) — the family of per-event authoring forms
 * now hold their fields in a single draft object (the #72 form-state standard), rather
 * than a `useState` per field. These pin the behaviour that the consolidation must keep:
 * the gates that reveal a field track their driving value, and the submitted event is
 * unchanged.
 *
 * The loan form is the notable one: its `kind` gates the term field, so the draft is a
 * discriminated union on `kind` (mirroring the engine's `LoanEvent`). Because a credit
 * card drops the term arm entirely, the last-entered term is remembered across a toggle —
 * the same "restore my value" affordance `jobForm`'s open-ended `endAge` has.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Household, NewLifeEvent } from "@finley/engine";
import { LoanForm } from "./loanForm";
import { SeparationForm } from "./separationForm";
import { ChildForm } from "./childForm";

afterEach(cleanup);

/** A minimal household with you plus a partner present from month 0 — enough for the
 *  separation form's `membersAt` read (it only touches `memberships[].person.{id,name}`). */
const withPartner = {
  memberships: [
    { person: { id: "p1", name: "You" }, startMonth: 0, endMonth: null },
    { person: { id: "p2", name: "Partner" }, startMonth: 0, endMonth: null },
  ],
  children: [],
  series: [],
  liabilities: [],
  properties: [],
} as unknown as Household;

const spin = (name: RegExp | string) =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;

describe("LoanForm — kind gates the term (§10.5, #115)", () => {
  it("drops the term field for a revolving credit card, and restores the typed term when switched back", () => {
    render(<LoanForm defaultMonth={0} nextId={0} horizonMonths={660} onAdd={vi.fn()} />);

    // Type a term that differs from the default so a reset would be visible.
    fireEvent.change(spin(/Term/i), { target: { value: "7" } });

    // Credit cards are revolving — no term. The field disappears.
    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "creditCard" },
    });
    expect(screen.queryByRole("spinbutton", { name: /Term/i })).toBeNull();

    // Back to an amortizing loan: the field returns with the user's 7, not the default 5.
    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "auto" },
    });
    expect(Number(spin(/Term/i).value)).toBe(7);
  });

  it("submits a credit card with a credit limit and no term; an amortizing loan with a term", () => {
    const onAdd = vi.fn<(e: NewLifeEvent) => void>();
    render(<LoanForm defaultMonth={0} nextId={3} horizonMonths={660} onAdd={onAdd} />);

    fireEvent.change(spin(/Amount/i), { target: { value: "10000" } });
    fireEvent.change(spin(/Term/i), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    expect(onAdd).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "LoanEvent", kind: "auto", termMonths: 72 }),
    );
    expect(onAdd.mock.calls[0][0]).not.toHaveProperty("creditLimitCents");

    fireEvent.change(screen.getByRole("combobox", { name: /Type/i }), {
      target: { value: "creditCard" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    const cc = onAdd.mock.calls[1][0];
    expect(cc).toMatchObject({ type: "LoanEvent", kind: "creditCard" });
    expect(cc).toHaveProperty("creditLimitCents");
    expect(cc).not.toHaveProperty("termMonths");
  });
});

describe("SeparationForm — alimony amount gates its duration (§4.3, #115)", () => {
  it("reveals the alimony-years field only once an alimony amount is entered, and folds it into the event", () => {
    const onAdd = vi.fn<(e: NewLifeEvent) => void>();
    render(
      <SeparationForm
        defaultMonth={0}
        nextId={0}
        horizonMonths={660}
        onAdd={onAdd}
        household={withPartner}
      />,
    );

    // No alimony amount yet → no duration field (there's nothing to time).
    expect(screen.queryByRole("spinbutton", { name: /Alimony years/i })).toBeNull();

    fireEvent.change(spin(/Alimony \/ mo/i), { target: { value: "500" } });
    fireEvent.change(spin(/Alimony years/i), { target: { value: "3" } });

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SeparationEvent",
        partnerPersonId: "p2",
        alimonyMonthlyCents: 500_00,
        alimonyDurationMonths: 36,
      }),
    );
  });
});

describe("ChildForm — single-draft consolidation preserves submit (§10.5, #115)", () => {
  it("submits a ChildEvent carrying the edited name, month and annual cost", () => {
    const onAdd = vi.fn<(e: NewLifeEvent) => void>();
    render(<ChildForm defaultMonth={0} nextId={2} horizonMonths={660} onAdd={onAdd} />);

    fireEvent.change(screen.getByPlaceholderText(/Child's name/i), { target: { value: "Robin" } });
    fireEvent.change(spin(/Annual cost/i), { target: { value: "20000" } });
    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ChildEvent",
        childName: "Robin",
        annualCostCents: 20000 * 100,
      }),
    );
  });
});
