/**
 * Add/edit form for a budget {@link import("@finley/engine").BudgetLine} (§12/§15, issue
 * #72) — the disclosed authoring surface the Base + Adjustments panel opens to create or
 * rename a line. A line is an **expense** (a cash outflow, tiered needs/wants/savings) or a
 * **contribution** into a named account (recurring saving/investment). Speaks the user's
 * terms and folds them into a {@link BudgetLineDraft} on submit. Mirrors `jobForm`/`goalForm`.
 */

import { useState } from "react";
import type { BudgetCategory } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { contributionTargets, type BudgetLineDraft } from "./budgetLines";
import styles from "./baseAdjustments.module.css";

const EXPENSE_CATEGORIES: readonly { value: BudgetCategory; label: string }[] = [
  { value: "needs", label: "Needs" },
  { value: "wants", label: "Wants" },
  { value: "savings", label: "Savings" },
];

interface BudgetLineFormProps {
  readonly initial: BudgetLineDraft;
  readonly submitLabel: string;
  readonly onSubmit: (draft: BudgetLineDraft) => void;
  readonly onCancel: () => void;
}

export function BudgetLineForm({ initial, submitLabel, onSubmit, onCancel }: BudgetLineFormProps) {
  const [label, setLabel] = useState(initial.label);
  const [kind, setKind] = useState<BudgetLineDraft["kind"]>(initial.kind);
  const [category, setCategory] = useState<BudgetCategory>(initial.category);
  const [dollars, setDollars] = useState(Math.round(initial.monthlyCents / 100));
  const [accountId, setAccountId] = useState(
    initial.accountId ?? contributionTargets[0]?.accountId,
  );

  function submit() {
    onSubmit({
      label: label.trim(),
      // A contribution is inherently a savings-tier line; an expense keeps its tier.
      category: kind === "contribution" ? "savings" : category,
      monthlyCents: Math.round(dollars * 100),
      kind,
      accountId: kind === "contribution" ? accountId : undefined,
    });
  }

  return (
    <form
      className={styles.itemForm}
      aria-label={`${submitLabel} budget item`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>

      <label className="field">
        <span className="field-label">Type</span>
        <select
          aria-label="Item type"
          value={kind}
          onChange={(e) => setKind(e.target.value as BudgetLineDraft["kind"])}
        >
          <option value="expense">Expense</option>
          <option value="contribution">Contribution (into an account)</option>
        </select>
      </label>

      {kind === "expense" ? (
        <label className="field">
          <span className="field-label">Category</span>
          <select
            aria-label="Category"
            value={category}
            onChange={(e) => setCategory(e.target.value as BudgetCategory)}
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="field">
          <span className="field-label">Into account</span>
          <select
            aria-label="Into account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {contributionTargets.map((t) => (
              <option key={t.accountId} value={t.accountId}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* step=1: a monthly amount is free-form dollars — a larger spinner step (50) would
          make the browser reject an off-step value like $120 on submit (HTML5 validity). */}
      <NumInput label="Monthly amount" value={dollars} onChange={setDollars} prefix="$" step={1} min={0} />

      <div className={styles.itemActions}>
        <button type="submit" className="btn primary">
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
