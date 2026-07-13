/** Value-editing surface (§10.2) — ongoing numbers, no timeline events. */

import type { Dispatch, SetStateAction } from "react";
import { dollarsToCents } from "@finley/engine";
import type { BudgetValues, ValueOverride } from "../../planTypes";
import { NumInput } from "../numInput/numInput";
import { ExpenseEditor } from "../expenseEditor/expenseEditor";

interface BudgetEditorProps {
  budget: BudgetValues;
  setBudget: Dispatch<SetStateAction<BudgetValues>>;
  scrubMonth: number;
}

export function BudgetEditor({ budget, setBudget, scrubMonth }: BudgetEditorProps) {
  function updateBudget(patch: Partial<BudgetValues>) {
    setBudget((current) => ({ ...current, ...patch }));
  }

  function addExpenseOverride(override: ValueOverride) {
    setBudget((current) => ({
      ...current,
      expenseOverrides: [...current.expenseOverrides, override],
    }));
  }

  return (
    <>
      <h2>Budget &amp; accounts</h2>
      <p className="hint">Edit ongoing numbers directly — this doesn’t add a timeline event.</p>

      <label className="field name-field">
        <span className="field-label">Name</span>
        <input
          type="text"
          value={budget.name}
          onChange={(e) => updateBudget({ name: e.target.value })}
        />
      </label>

      <NumInput
        label="Monthly income"
        value={budget.incomeCents / 100}
        onChange={(v) => updateBudget({ incomeCents: dollarsToCents(v) })}
        prefix="$"
        step={100}
      />

      <ExpenseEditor
        cents={budget.expenseCents}
        overrides={budget.expenseOverrides}
        scrubMonth={scrubMonth}
        onSetBaseline={(expenseCents) => updateBudget({ expenseCents })}
        onOverride={addExpenseOverride}
      />

      <hr className="divider" />
      <NumInput
        label="Opening balance"
        value={budget.openingBalanceCents / 100}
        onChange={(v) => updateBudget({ openingBalanceCents: dollarsToCents(v) })}
        prefix="$"
        step={1000}
      />
      <NumInput
        label="Annual return"
        value={budget.annualReturnPct}
        onChange={(annualReturnPct) => updateBudget({ annualReturnPct })}
        suffix="%"
        min={0}
        step={0.5}
      />
    </>
  );
}
