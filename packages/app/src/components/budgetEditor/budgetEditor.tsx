/**
 * Budget/Accounts panel (§4.2, §10.2) — person-partitioned ongoing numbers plus a
 * Shared section, all edited directly (no timeline event, §10.3). Advanced knobs
 * (account return, pre-tax deferral %) are progressively disclosed behind the
 * plain number (§10.4). The Shared section carries two of the four waterfall
 * levers (split scheme, surplus destination); the deferral % is the third and
 * goal priority (the fourth) lives in the Goals panel.
 */

import type { Dispatch, SetStateAction } from "react";
import { dollarsToCents, type SharedContributionScheme } from "@finley/engine";
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

      {/* One section per household member. This slice has a single member; the
          shape is partitioned so partners drop in as their own sections (§4.2). */}
      <section className="budget-member" aria-label={`${budget.name || "You"}’s budget`}>
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

        <NumInput
          label="Opening balance"
          value={budget.openingBalanceCents / 100}
          onChange={(v) => updateBudget({ openingBalanceCents: dollarsToCents(v) })}
          prefix="$"
          step={1000}
        />

        {/* §10.4: the plain numbers are above; the rate and deferral lever are
            disclosed on demand rather than shown by default. */}
        <details className="advanced">
          <summary>Advanced</summary>
          <NumInput
            label="Savings return"
            value={budget.savingsReturnPct}
            onChange={(savingsReturnPct) => updateBudget({ savingsReturnPct })}
            suffix="%"
            min={0}
            step={0.5}
          />
          <NumInput
            label="Retirement return"
            value={budget.retirementReturnPct}
            onChange={(retirementReturnPct) => updateBudget({ retirementReturnPct })}
            suffix="%"
            min={0}
            step={0.5}
          />
          <NumInput
            label="Brokerage return"
            value={budget.brokerageReturnPct}
            onChange={(brokerageReturnPct) => updateBudget({ brokerageReturnPct })}
            suffix="%"
            min={0}
            step={0.5}
          />
          <NumInput
            label="401(k) contribution"
            value={budget.retirementDeferralPct}
            onChange={(retirementDeferralPct) => updateBudget({ retirementDeferralPct })}
            suffix="%"
            min={0}
            step={1}
          />
        </details>
      </section>

      <hr className="divider" />

      <section className="budget-shared" aria-label="Shared">
        <h3>Shared</h3>

        <label className="field">
          <span className="field-label">Shared expenses split</span>
          <select
            value={budget.sharedScheme}
            onChange={(e) =>
              updateBudget({ sharedScheme: e.target.value as SharedContributionScheme })
            }
          >
            <option value="proportional">Proportional to income</option>
            <option value="even">Split evenly</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Leftover cash</span>
          <select
            value={budget.surplusSwept ? "swept" : "idle"}
            onChange={(e) => updateBudget({ surplusSwept: e.target.value === "swept" })}
          >
            <option value="idle">Keep in savings</option>
            <option value="swept">Sweep to investments</option>
          </select>
        </label>
      </section>
    </>
  );
}
