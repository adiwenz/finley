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
import { dollarsToCents, type BudgetLine } from "@finley/engine";
import { SpendingEditor, type PendingEdit } from "./spendingEditor";
import type { ResolvedRow } from "./monthEdit";

afterEach(cleanup);

const HOUSING_LINE: BudgetLine = {
  id: "housing",
  label: "Housing",
  target: { kind: "expense" },
  amountSource: { kind: "literal", monthlyCents: dollarsToCents(1_600) },
  category: "needs",
};

const HOUSING_ROW: ResolvedRow = {
  lineId: "housing",
  label: "Housing",
  category: "needs",
  monthlyCents: dollarsToCents(1_600),
  overridden: false,
};

const noop = () => {};

function renderEditor(over: Partial<Parameters<typeof SpendingEditor>[0]> = {}) {
  const edit = { onStage: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
  const form = { onToggle: vi.fn(), onSubmit: vi.fn(), onClose: noop, onDelete: vi.fn() };
  render(
    <SpendingEditor
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
    const dining: ResolvedRow = { ...HOUSING_ROW, lineId: "dining", label: "Dining", category: "wants" };
    renderEditor({
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
