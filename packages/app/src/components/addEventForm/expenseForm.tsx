/** A recurring expense starts — a BudgetItemStartEvent. */

import { useState } from "react";
import { dollarsToCents, membersAt, type Household } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, OwnerSelect, type FormProps } from "./formControls";

/** The form's live state — one draft, not a hook per field. The owner *shown* is derived
 *  from this (see below), never stored separately. */
interface ExpenseDraft {
  readonly month: number;
  readonly amount: number;
  readonly ownerId: string;
}

export function ExpenseForm({
  household,
  defaultMonth,
  nextId,
  horizonMonths,
  onAdd,
}: FormProps & { household: Household }) {
  const [draft, setDraft] = useState<ExpenseDraft>(() => ({ month: defaultMonth, amount: 2000, ownerId: "p1" }));
  const patch = (fields: Partial<ExpenseDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Attribute the expense to someone in the household when it starts. Derived
  // during render so it tracks the month picker; falls back to you if the
  // selected owner isn't present at the chosen month. Not draft state — it's
  // computed from the draft, so it can never drift out of sync.
  const owners = membersAt(household, draft.month).map((p) =>
    p.id === "p1" ? { ...p, name: "You" } : p,
  );
  const selectedOwner = owners.some((o) => o.id === draft.ownerId) ? draft.ownerId : "p1";

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "BudgetItemStartEvent",
      month: draft.month,
      seriesId: `budget-${nextId}`,
      ownerId: selectedOwner,
      seriesType: "expense",
      monthlyCents: dollarsToCents(draft.amount),
      growthMode: { type: "fixed" },
    });
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      <NumInput label="Monthly expense" value={draft.amount} onChange={(amount) => patch({ amount })} prefix="$" step={100} />
      {owners.length > 1 && (
        <OwnerSelect owners={owners} value={selectedOwner} onChange={(ownerId) => patch({ ownerId })} />
      )}
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
