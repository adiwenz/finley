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
import { HomePurchaseForm } from "./homePurchaseForm";
import type { EventOf } from "./formControls";
import { PLAN_DEFAULTS } from "../../planDefaults";
import { readerOf, runOf } from "../../testing/projectionHarness";

afterEach(cleanup);

/**
 * A stubbed {@link Projection} whose transaction methods only record their input, plus the
 * `onAdd` that runs a form's write against it. The forms author through the facade now, so a
 * test asserts the *input* a form hands `takeLoan` / `separate` / `haveChild`, not a raw event.
 * `reviseTransaction` is the edit path's sink — an edit asserts the `(id, revision)` it records.
 */
function stubProjection() {
  const p = {
    takeLoan: vi.fn(),
    separate: vi.fn(),
    haveChild: vi.fn(),
    reviseTransaction: vi.fn(),
  };
  const onAdd = (write: (projection: Projection) => void) => write(p as unknown as Projection);
  return { p, onAdd, onRevise: onAdd };
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

describe("sub-forms — editing an existing event", () => {
  const CHILD: EventOf<"ChildEvent"> = {
    type: "ChildEvent",
    id: "child-1",
    sequenceNumber: 4,
    month: 24,
    childId: "c1",
    childName: "Robin",
    birthMonth: 24,
    annualCostCents: 15_000_00,
  };

  const STUDENT_LOAN: EventOf<"LoanEvent"> = {
    type: "LoanEvent",
    id: "loan-1",
    sequenceNumber: 2,
    month: 0,
    kind: "studentLoan",
    liabilityId: "l1",
    ownerId: "p1",
    openingBalanceCents: 20_000_00,
    apr: 0.06,
    termMonths: 72,
  };

  const MORTGAGE: EventOf<"LoanEvent"> = {
    type: "LoanEvent",
    id: "prop-1-mortgage",
    sequenceNumber: 6,
    month: 12,
    kind: "mortgage",
    liabilityId: "prop-1-mortgage",
    ownerId: "p1",
    openingBalanceCents: 240_000_00,
    apr: 0.065,
    termMonths: 360,
  };

  const SEPARATION: EventOf<"SeparationEvent"> = {
    type: "SeparationEvent",
    id: "sep-1",
    sequenceNumber: 5,
    month: 60,
    partnerPersonId: "p2",
    alimonyMonthlyCents: 500_00,
    alimonyDurationMonths: 36,
    childSupportMonthlyCents: 0,
  };

  it("ChildForm opens pre-filled and revises the event in place, keeping birth = recorded month", () => {
    const { p, onRevise } = stubProjection();
    render(<ChildForm defaultMonth={0} horizonMonths={660} onAdd={vi.fn()} edit={{ event: CHILD, onRevise }} />);

    expect((screen.getByPlaceholderText(/Child's name/i) as HTMLInputElement).value).toBe("Robin");
    expect(Number(spin(/Annual cost/i).value)).toBe(15_000);

    enterNumber(spin(/Annual cost/i), "18000");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(p.reviseTransaction).toHaveBeenCalledWith("child-1", {
      type: "haveChild",
      month: 24,
      name: "Robin",
      birthMonth: 24,
      annualCostCents: 18_000_00,
    });
  });

  it("LoanForm edits an amortizing loan, submitting a term revision with the kind fixed", () => {
    const { p, onRevise } = stubProjection();
    render(<LoanForm defaultMonth={0} horizonMonths={660} onAdd={vi.fn()} edit={{ event: STUDENT_LOAN, onRevise }} />);

    // Kind is fixed on a revision, so the type picker is gone.
    expect(screen.queryByRole("combobox", { name: /Type/i })).toBeNull();
    expect(Number(spin(/Amount/i).value)).toBe(20_000);
    expect(Number(spin(/APR/i).value)).toBe(6);
    expect(Number(spin(/Term/i).value)).toBe(6);

    enterNumber(spin(/APR/i), "5");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(p.reviseTransaction).toHaveBeenCalledWith("loan-1", {
      type: "takeLoan",
      month: 0,
      openingBalanceCents: 20_000_00,
      apr: 0.05,
      termMonths: 72,
    });
  });

  it("LoanForm edits a mortgage's rate and term through its own marker (a kind the picker never offers)", () => {
    const { p, onRevise } = stubProjection();
    render(<LoanForm defaultMonth={0} horizonMonths={660} onAdd={vi.fn()} edit={{ event: MORTGAGE, onRevise }} />);

    expect(Number(spin(/Term/i).value)).toBe(30);
    enterNumber(spin(/APR/i), "5.5");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    const [id, revision] = p.reviseTransaction.mock.calls[0];
    expect(id).toBe("prop-1-mortgage");
    expect(revision).toMatchObject({ type: "takeLoan", apr: 0.055, termMonths: 360 });
    expect(revision).not.toHaveProperty("creditLimitCents");
  });

  it("SeparationForm edits support terms in place, with the partner fixed (not revisable)", () => {
    const { p, onRevise } = stubProjection();
    render(
      <SeparationForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={vi.fn()}
        result={withPartner}
        edit={{ event: SEPARATION, onRevise }}
      />,
    );

    // Who the separation is from cannot change on a revision, so there is no picker — the
    // partner is named read-only.
    expect(screen.queryByRole("combobox", { name: /From/i })).toBeNull();
    expect(screen.getByText(/Partner/)).toBeTruthy();
    expect(Number(spin(/Alimony \/ mo/i).value)).toBe(500);
    expect(Number(spin(/Alimony years/i).value)).toBe(3);

    enterNumber(spin(/Alimony \/ mo/i), "700");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(p.reviseTransaction).toHaveBeenCalledWith("sep-1", {
      type: "separate",
      month: 60,
      alimonyMonthlyCents: 700_00,
      alimonyDurationMonths: 36,
    });
  });

  it("HomePurchaseForm edits the property's own fields; the mortgage rate is edited elsewhere", () => {
    const HOME: EventOf<"HomePurchaseEvent"> = {
      type: "HomePurchaseEvent",
      id: "prop-1",
      sequenceNumber: 6,
      month: 0,
      propertyId: "prop-1",
      ownerId: "p1",
      purchasePriceCents: 300_000_00,
      downPaymentCents: 60_000_00,
      // Empty so the funding filter is not in play — the picker's plumbing is its own test.
      downPaymentSourceIds: [],
      mortgage: { openingBalanceCents: 240_000_00, apr: 0.06, termMonths: 360 },
    };
    const { p, onRevise } = stubProjection();
    render(
      <HomePurchaseForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={vi.fn()}
        result={runOf(PLAN_DEFAULTS)}
        funding={readerOf(PLAN_DEFAULTS).funding()}
        edit={{ event: HOME, onRevise }}
      />,
    );

    expect(Number(spin(/Price/i).value)).toBe(300_000);
    expect(Number(spin(/Down payment/i).value)).toBe(60_000);
    // A `buyHome` revision cannot touch the financing loan, so the mortgage fields drop out —
    // they are revised through the mortgage's own timeline marker.
    expect(screen.queryByRole("spinbutton", { name: /Mortgage APR/i })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: /Term/i })).toBeNull();

    enterNumber(spin(/Price/i), "320000");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(p.reviseTransaction).toHaveBeenCalledWith("prop-1", {
      type: "buyHome",
      month: 0,
      purchasePriceCents: 320_000_00,
      downPaymentCents: 60_000_00,
      downPaymentSourceIds: [],
    });
  });
});

/**
 * Editing something that predates the plan. Two shapes, and the difference is whose date it is:
 * an ANCHOR (a birth already behind us) sits at its true past month, authored in elapsed terms;
 * a HOLDING (a debt carried, a home owned) is pinned to the now marker and has no date to author
 * at all. Neither can be described by the plan's year picker, so neither is offered one — and
 * each names its figures the way the Starting position form that created it did.
 */
describe("sub-forms — editing something already true on day one", () => {
  /** Born three years ago: the anchor `haveExistingChild` lays down at month -36. */
  const EXISTING_CHILD: EventOf<"ChildEvent"> = {
    type: "ChildEvent",
    id: "child-2",
    sequenceNumber: 2,
    month: -36,
    childId: "c2",
    childName: "Ari",
    birthMonth: -36,
    annualCostCents: 15_000_00,
  };

  /** A car loan already being paid off — a holding, at the now marker. */
  const CARRIED_LOAN: EventOf<"LoanEvent"> = {
    type: "LoanEvent",
    id: "loan-2",
    sequenceNumber: 1,
    month: -1,
    kind: "auto",
    liabilityId: "l2",
    ownerId: "p1",
    openingBalanceCents: 15_000_00,
    apr: 0.06,
    termMonths: 36,
  };

  /** A home already owned: opened at its current value, with no draw and no sources. */
  const OWNED_HOME: EventOf<"HomePurchaseEvent"> = {
    type: "HomePurchaseEvent",
    id: "home-1",
    sequenceNumber: 2,
    month: -1,
    propertyId: "home-1",
    ownerId: "p1",
    purchasePriceCents: 400_000_00,
    downPaymentCents: 0,
    downPaymentSourceIds: [],
    mortgage: { openingBalanceCents: 240_000_00, apr: 0.06, termMonths: 360 },
  };

  it("ChildForm dates an existing child by their age today, and keeps birth = that month", () => {
    const { p, onRevise } = stubProjection();
    render(
      <ChildForm defaultMonth={0} horizonMonths={660} onAdd={vi.fn()} edit={{ event: EXISTING_CHILD, onRevise }} />,
    );

    expect(screen.queryByRole("combobox", { name: /When/i })).toBeNull();
    expect(Number(spin(/Age today/i).value)).toBe(3);

    // Correcting their age moves the birth, and the cost stream with it.
    enterNumber(spin(/Age today/i), "5");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(p.reviseTransaction).toHaveBeenCalledWith("child-2", {
      type: "haveChild",
      month: -60,
      name: "Ari",
      birthMonth: -60,
      annualCostCents: 15_000_00,
    });
  });

  it("LoanForm states a carried loan's date and names its figures as today's", () => {
    const { p, onRevise } = stubProjection();
    render(<LoanForm defaultMonth={0} horizonMonths={660} onAdd={vi.fn()} edit={{ event: CARRIED_LOAN, onRevise }} />);

    // The now marker is the only month a holding may open at, so there is nothing to pick.
    expect(screen.queryByRole("combobox", { name: /When/i })).toBeNull();
    expect(Number(spin(/Balance today/i).value)).toBe(15_000);
    expect(Number(spin(/Term remaining/i).value)).toBe(3);

    enterNumber(spin(/Balance today/i), "12000");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    // Still at the now marker: the edit changed the balance, not where the loan opens.
    expect(p.reviseTransaction).toHaveBeenCalledWith("loan-2", {
      type: "takeLoan",
      month: -1,
      openingBalanceCents: 12_000_00,
      apr: 0.06,
      termMonths: 36,
    });
  });

  it("HomePurchaseForm edits an owned home's value alone — no date, no down payment to fund", () => {
    const { p, onRevise } = stubProjection();
    render(
      <HomePurchaseForm
        defaultMonth={0}
        horizonMonths={660}
        onAdd={vi.fn()}
        result={runOf(PLAN_DEFAULTS)}
        funding={readerOf(PLAN_DEFAULTS).funding()}
        edit={{ event: OWNED_HOME, onRevise }}
      />,
    );

    expect(screen.queryByRole("combobox", { name: /When/i })).toBeNull();
    expect(Number(spin(/Current value/i).value)).toBe(400_000);
    // A holding drew nothing when it opened, so neither the amount nor the drain order is asked.
    expect(screen.queryByRole("spinbutton", { name: /Down payment/i })).toBeNull();
    expect(screen.queryByText(/Down payment paid from/i)).toBeNull();

    enterNumber(spin(/Current value/i), "425000");
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    expect(p.reviseTransaction).toHaveBeenCalledWith("home-1", {
      type: "buyHome",
      month: -1,
      purchasePriceCents: 425_000_00,
      downPaymentCents: 0,
      downPaymentSourceIds: [],
    });
  });
});
