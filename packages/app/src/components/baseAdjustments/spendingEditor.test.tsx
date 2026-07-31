/**
 * @vitest-environment jsdom
 *
 * {@link SpendingEditor} in isolation. The gesture (stage → answer how long → routed edit) is
 * pinned end-to-end through the panel; here only the row's own contract — it shows the staged
 * value while an edit is pending, and a row whose authored line is missing renders instead of
 * throwing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  dollarsToCents,
  type BudgetLine,
  type FinancialObligation,
  type ResolvedExpenseRow,
} from "@finley/engine";
import { SpendingEditor, type PendingEdit } from "./spendingEditor";

afterEach(cleanup);

const HOUSING_LINE: BudgetLine = {
  id: "housing",
  label: "Housing",
  target: { kind: "expense" },
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(1_600) },
  category: "needs",
};

const HOUSING_ROW: ResolvedExpenseRow = {
  lineId: "housing",
  label: "Housing",
  category: "needs",
  monthlyCents: dollarsToCents(1_600),
  overridden: false,
};

/** The obligation the housing line resolves to — the editable slice of the month's list. */
const HOUSING_OBLIGATION: FinancialObligation = {
  id: "line:housing",
  sourceId: "housing",
  month: 0,
  amountCents: dollarsToCents(1_600),
  treatment: "expense",
  funding: { kind: "automatic" },
  priority: 0,
  sourceKind: "budgetLine",
  editable: true,
  label: "Housing",
  category: "needs",
};

const HEALTH_LINE: BudgetLine = {
  id: "health",
  label: "Healthcare",
  target: { kind: "expense" },
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(500) },
  category: "healthcare",
};

const HEALTH_ROW: ResolvedExpenseRow = {
  lineId: "health",
  label: "Healthcare",
  category: "healthcare",
  monthlyCents: dollarsToCents(500),
  overridden: false,
};

/**
 * Health as an ordinary authored line: `budgetLine`, `editable`, differing from housing only in
 * its category. It used to be the panel's example of a read-only obligation — that it no longer
 * can be is the point of these tests.
 */
const HEALTH_OBLIGATION: FinancialObligation = {
  id: "line:health",
  sourceId: "health",
  month: 0,
  amountCents: dollarsToCents(500),
  treatment: "expense",
  funding: { kind: "automatic" },
  priority: 0,
  sourceKind: "budgetLine",
  editable: true,
  label: "Healthcare",
  category: "healthcare",
};

/** A cost the user did not author here — a child's, created by a life event. */
const CHILD_COST_OBLIGATION: FinancialObligation = {
  id: "series-child-1",
  sourceId: "series-child-1",
  month: 0,
  amountCents: dollarsToCents(500),
  treatment: "expense",
  funding: { kind: "automatic" },
  priority: 0,
  sourceKind: "event",
  editable: false,
  label: "Child cost",
  category: "other",
};

const noop = () => {};

function renderEditor(over: Partial<Parameters<typeof SpendingEditor>[0]> = {}) {
  const edit = { onStage: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
  const form = { onToggle: vi.fn(), onSubmit: vi.fn(), onClose: noop, onDelete: vi.fn() };
  render(
    <SpendingEditor
      obligations={[HOUSING_OBLIGATION]}
      rows={[HOUSING_ROW]}
      lines={[HOUSING_LINE]}
      selectedMonth={0}
      pending={null}
      lastRoute={null}
      authoring={null}
      edit={edit}
      form={form}
      {...over}
    />,
  );
  return { edit, form };
}

const housingInput = () => screen.getByRole("spinbutton", { name: /Housing/ }) as HTMLInputElement;

describe("SpendingEditor — the row", () => {
  it("shows the resolved amount, and the staged one while an edit awaits its answer", () => {
    const pending: PendingEdit = {
      row: { kind: "line", lineId: "housing" },
      label: "Housing",
      priorAmountCents: dollarsToCents(1_600),
      newAmountCents: dollarsToCents(2_400),
    };
    renderEditor();
    expect(housingInput().value).toBe("1600");
    cleanup();
    // A field that snapped back to the stored value on every keystroke is unusable.
    renderEditor({ pending });
    expect(housingInput().value).toBe("2400");
  });

  it("leaves other rows on their resolved amount while one is staged", () => {
    const dining: ResolvedExpenseRow = { ...HOUSING_ROW, lineId: "dining", label: "Dining", category: "wants" };
    const diningObligation: FinancialObligation = {
      ...HOUSING_OBLIGATION,
      id: "line:dining",
      sourceId: "dining",
      label: "Dining",
      category: "wants",
    };
    renderEditor({
      obligations: [HOUSING_OBLIGATION, diningObligation],
      rows: [HOUSING_ROW, dining],
      pending: {
        row: { kind: "line", lineId: "dining" },
        label: "Dining",
        priorAmountCents: dollarsToCents(1_600),
        newAmountCents: dollarsToCents(90),
      },
    });
    expect(housingInput().value).toBe("1600");
    expect((screen.getByRole("spinbutton", { name: /Dining/ }) as HTMLInputElement).value).toBe("90");
  });

  it("stages an edit against its own line", () => {
    const { edit } = renderEditor();
    fireEvent.change(housingInput(), { target: { value: "1800" } });
    expect(edit.onStage).toHaveBeenCalledWith(
      { kind: "line", lineId: "housing" },
      "Housing",
      dollarsToCents(1_600),
      1800,
    );
  });

  it("renders a row whose authored line is gone, without its form and without throwing", () => {
    // Row and line come from the same budget, so this should not happen; it is reachable
    // only as a crash, so the form is simply not offered.
    renderEditor({ lines: [], authoring: { kind: "edit", id: "housing" } });
    expect(housingInput().value).toBe("1600");
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

describe("SpendingEditor — the full obligation list", () => {
  it("renders a non-editable obligation read-only, with its amount and a deep link", () => {
    renderEditor({ obligations: [HOUSING_OBLIGATION, CHILD_COST_OBLIGATION] });
    // An event's expense is not an editable spending input here…
    expect(screen.queryByRole("spinbutton", { name: /Child cost/ })).toBeNull();
    // …it shows its owed amount read-only, and a link to where it IS edited.
    const link = screen.getByRole("link", { name: /Edit its event/i });
    expect(link.getAttribute("href")).toBe("#timeline");
    const row = screen.getByText("Child cost").closest("div")!;
    expect(row.textContent).toMatch(/\$500/);
  });

  it("keeps the user's own budget lines editable beside the read-only obligations", () => {
    renderEditor({ obligations: [HOUSING_OBLIGATION, CHILD_COST_OBLIGATION] });
    // The authored line is still an editable spinbutton — `editable` gates the input.
    expect(housingInput().value).toBe("1600");
    expect(screen.getByRole("button", { name: /Edit Housing/i })).toBeTruthy();
  });

  it("offers no edit/delete controls on a read-only obligation row", () => {
    renderEditor({ obligations: [CHILD_COST_OBLIGATION] });
    expect(screen.queryByRole("button", { name: /Edit Child cost/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete Child cost/i })).toBeNull();
  });
});

describe("SpendingEditor — health is an ordinary editable line", () => {
  const renderWithHealth = (over: Partial<Parameters<typeof SpendingEditor>[0]> = {}) =>
    renderEditor({
      obligations: [HOUSING_OBLIGATION, HEALTH_OBLIGATION],
      rows: [HOUSING_ROW, HEALTH_ROW],
      lines: [HOUSING_LINE, HEALTH_LINE],
      ...over,
    });
  const healthInput = () =>
    screen.getByRole("spinbutton", { name: /Healthcare/ }) as HTMLInputElement;

  it("gives health an amount input, not a read-only row", () => {
    renderWithHealth();
    expect(healthInput().value).toBe("500");
    // Nothing links health away any more, because there is nowhere else it lives.
    expect(screen.queryByRole("link", { name: /Edit on the plan/i })).toBeNull();
  });

  it("offers health the same edit and delete controls every other line gets", () => {
    renderWithHealth();
    expect(screen.getByRole("button", { name: /Edit Healthcare/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete Healthcare/i })).toBeTruthy();
  });

  it("stages an edit against the health line like any other", () => {
    const { edit } = renderWithHealth();
    fireEvent.change(healthInput(), { target: { value: "650" } });
    expect(edit.onStage).toHaveBeenCalledWith(
      { kind: "line", lineId: "health" },
      "Healthcare",
      dollarsToCents(500),
      650,
    );
  });
});
