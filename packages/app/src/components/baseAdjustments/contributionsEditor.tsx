/**
 * The **Savings & contributions** rows of Base + Adjustments: budget lines whose target
 * is an account rather than an expense (§12). They are listed apart from spending
 * because they are a different kind of money — funded by the sim, they accumulate in
 * net worth instead of leaving it — and because they carry no month-resolved amount to
 * adjust: a contribution is a flat literal into an account, edited through its form.
 *
 * Split out of {@link import("./baseAdjustmentsPanel").BaseAdjustmentsPanel} alongside
 * {@link import("./spendingEditor").SpendingEditor}; like it, it owns no state.
 */

import { BudgetLineForm } from "./budgetLineForm";
import { contributionTargets, lineToDraft } from "./budgetLines";
import { formatDollars } from "../../format";
import type { BudgetLine } from "@finley/engine";
import type { LineAuthoring, LineFormActions } from "./budgetLineAuthoring";
import styles from "./baseAdjustments.module.css";

export interface ContributionsEditorProps {
  /** The account-target lines, in authoring order. */
  readonly lines: readonly BudgetLine[];
  readonly authoring: LineAuthoring | null;
  readonly form: LineFormActions;
}

export function ContributionsEditor({ lines, authoring, form }: ContributionsEditorProps) {
  return (
    <>
      <h4 className={styles.groupHeading}>Savings &amp; contributions</h4>
      {lines.length === 0 ? (
        <p className="hint">
          No recurring contributions yet. Add one to pay into a brokerage or savings
          account each month — it accumulates in your net worth.
        </p>
      ) : (
        lines.map((line) => {
          const monthly = line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;
          const accountId = line.target.kind === "account" ? line.target.accountId : "";
          const dest = contributionTargets.find((t) => t.accountId === accountId)?.label ?? accountId;
          return (
            <div key={line.id}>
              <div className={styles.lineRow}>
                <span className={styles.lineLabel}>
                  {line.label} <span className={styles.target}>→ {dest}</span>
                </span>
                <span className={styles.readonlyValue}>{formatDollars(monthly)}/mo</span>
                <span className={styles.rowActions}>
                  <button
                    type="button"
                    aria-label={`Edit ${line.label}`}
                    onClick={() => form.onToggle(line.id)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${line.label}`}
                    onClick={() => form.onDelete(line.id)}
                  >
                    Delete
                  </button>
                </span>
              </div>
              {authoring?.kind === "edit" && authoring.id === line.id && (
                <BudgetLineForm
                  initial={lineToDraft(line)}
                  submitLabel="Save"
                  onSubmit={(draft) => form.onSubmit(line.id, draft)}
                  onCancel={form.onClose}
                />
              )}
            </div>
          );
        })
      )}
    </>
  );
}
