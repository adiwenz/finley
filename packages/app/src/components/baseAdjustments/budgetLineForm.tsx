/**
 * Add/edit form for a budget {@link import("@finley/engine").BudgetLine}, opened by the
 * Base + Adjustments panel. Speaks the user's terms and folds them into a
 * {@link BudgetLineDraft} on submit. Mirrors `jobForm`/`goalForm`.
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

const defaultAccountId = (): string => contributionTargets[0]?.accountId ?? "brokerage";

/**
 * The form's live state, shaped like the draft it submits. The kind-specific field lives ONLY
 * on its own arm, so an in-progress form can never represent an impossible combination.
 */
type FormState =
  | { readonly kind: "expense"; readonly label: string; readonly dollars: number; readonly category: BudgetCategory }
  | { readonly kind: "contribution"; readonly label: string; readonly dollars: number; readonly accountId: string };

function initialState(initial: BudgetLineDraft): FormState {
  const dollars = Math.round(initial.monthlyCents / 100);
  return initial.kind === "contribution"
    ? { kind: "contribution", label: initial.label, dollars, accountId: initial.accountId }
    : { kind: "expense", label: initial.label, dollars, category: initial.category };
}

interface BudgetLineFormProps {
  readonly initial: BudgetLineDraft;
  readonly submitLabel: string;
  readonly onSubmit: (draft: BudgetLineDraft) => void;
  readonly onCancel: () => void;
}

export function BudgetLineForm({ initial, submitLabel, onSubmit, onCancel }: BudgetLineFormProps) {
  const [state, setState] = useState<FormState>(() => initialState(initial));

  const setLabel = (label: string) => setState((s) => ({ ...s, label }));
  const setDollars = (dollars: number) => setState((s) => ({ ...s, dollars }));
  const setCategory = (category: BudgetCategory) =>
    setState((s) => (s.kind === "expense" ? { ...s, category } : s));
  const setAccountId = (accountId: string) =>
    setState((s) => (s.kind === "contribution" ? { ...s, accountId } : s));

  // Not a flag flip: rebuild the arm with a valid default for its own field, preserving the
  // shared name and amount.
  function setKind(kind: "expense" | "contribution") {
    setState((s) =>
      s.kind === kind
        ? s
        : kind === "contribution"
          ? { kind: "contribution", label: s.label, dollars: s.dollars, accountId: defaultAccountId() }
          : { kind: "expense", label: s.label, dollars: s.dollars, category: "needs" },
    );
  }

  function submit() {
    const label = state.label.trim();
    const monthlyCents = Math.round(state.dollars * 100);
    onSubmit(
      state.kind === "contribution"
        ? { kind: "contribution", label, monthlyCents, accountId: state.accountId }
        : { kind: "expense", label, monthlyCents, category: state.category },
    );
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
        <input type="text" value={state.label} onChange={(e) => setLabel(e.target.value)} />
      </label>

      <label className="field">
        <span className="field-label">Type</span>
        <select
          aria-label="Item type"
          value={state.kind}
          onChange={(e) => setKind(e.target.value as FormState["kind"])}
        >
          <option value="expense">Expense</option>
          <option value="contribution">Contribution (into an account)</option>
        </select>
      </label>

      {state.kind === "expense" ? (
        <label className="field">
          <span className="field-label">Category</span>
          <select
            aria-label="Category"
            value={state.category}
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
            value={state.accountId}
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
      <NumInput label="Monthly amount" value={state.dollars} onChange={setDollars} prefix="$" step={1} min={0} />

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
