/**
 * The **Spending** rows of Base + Adjustments: every expense line at what it resolves to
 * at the selected month, the one question an edit asks ("just this month, or from here
 * forward?"), and the echo of where that edit was routed (§20, AC4).
 *
 * Split out of {@link import("./baseAdjustmentsPanel").BaseAdjustmentsPanel} so the
 * panel holds state and plan mutation while this holds the row gesture. It owns no
 * state of its own — a staged edit belongs to the panel because moving the month drops
 * it, and the disclosed add/edit form is single-at-a-time across both this list and the
 * contributions list, so that too is the panel's to arbitrate.
 */

import { NumInput } from "../numInput/numInput";
import { BudgetLineForm } from "./budgetLineForm";
import { lineToDraft, type BudgetLineDraft } from "./budgetLines";
import { formatDollars } from "../../format";
import type { BudgetLine } from "@finley/engine";
import type { EditRow, EditScope, MonthEditRoute, ResolvedRow } from "./monthEdit";
import type { LineAuthoring } from "./budgetLineAuthoring";
import styles from "./baseAdjustments.module.css";

/** The row the user has typed a new number into, awaiting the how-long question. */
export interface PendingEdit {
  readonly row: EditRow;
  readonly label: string;
  readonly priorAmountCents: number;
  readonly newAmountCents: number;
}

const isSameRow = (a: EditRow, b: EditRow): boolean =>
  a.kind === "income" ? b.kind === "income" : b.kind === "line" && a.lineId === b.lineId;

/**
 * What a row's input shows. A staged (typed but not yet committed) edit is the truth
 * for its own row — the committed budget only catches up once the user answers the
 * how-long question, and a field that snapped back to the stored value on every
 * keystroke would be unusable.
 */
function displayedCents(row: EditRow, resolvedCents: number, pending: PendingEdit | null): number {
  return pending !== null && isSameRow(pending.row, row) ? pending.newAmountCents : resolvedCents;
}

/**
 * A short, human summary of where an edit landed — surfaced so the routing is visible.
 * Named with the row's own `label`: the route carries the line's authoring `id`, which
 * is an internal key ("dining") and not what the row directly above this echo says
 * ("Dining & fun").
 */
function describeRoute(route: MonthEditRoute, label: string): string {
  switch (route.kind) {
    case "lineOverride":
      return route.override.scope === "thisMonthOnly"
        ? `→ one-month override on "${label}" at month ${route.override.month} (${formatDollars(route.override.monthlyCents)})`
        : `→ dated override on "${label}" from month ${route.override.month} forward (${formatDollars(route.override.monthlyCents)})`;
    case "ledgerTransaction":
      return `→ one-time ledger transaction at month ${route.month} (${formatDollars(route.amountCents)})`;
    case "incomeOverride":
      return `→ job/stream income override from month ${route.month} forward (${formatDollars(route.monthlyCents)})`;
  }
}

export interface SpendingEditorProps {
  /** Each expense line resolved to the selected month (amount, tier, adjusted flag). */
  readonly rows: readonly ResolvedRow[];
  /** The standing lines, for the disclosed edit form's initial draft. */
  readonly lines: readonly BudgetLine[];
  readonly selectedMonth: number;
  readonly pending: PendingEdit | null;
  /** The last routed edit, with the row label it was made on (the route only has the id). */
  readonly lastRoute: { readonly route: MonthEditRoute; readonly label: string } | null;
  readonly authoring: LineAuthoring | null;
  readonly onStageEdit: (row: EditRow, label: string, priorCents: number, dollars: number) => void;
  readonly onCommit: (scope: EditScope) => void;
  readonly onCancelEdit: () => void;
  readonly onToggleLineForm: (id: string) => void;
  readonly onSubmitLineForm: (id: string, draft: BudgetLineDraft) => void;
  readonly onCloseLineForm: () => void;
  readonly onDeleteLine: (id: string) => void;
}

export function SpendingEditor({
  rows,
  lines,
  selectedMonth,
  pending,
  lastRoute,
  authoring,
  onStageEdit,
  onCommit,
  onCancelEdit,
  onToggleLineForm,
  onSubmitLineForm,
  onCloseLineForm,
  onDeleteLine,
}: SpendingEditorProps) {
  return (
    <>
      <h4 className={styles.groupHeading}>Spending</h4>
      {rows.map((row) => (
        <div key={row.lineId}>
          <div className={styles.lineRow}>
            <span className={styles.lineLabel}>
              {row.label} <span className={styles.tier}>{row.category}</span>
              {row.overridden && (
                <span className={styles.adjusted} title="Adjusted at or before this month">
                  adjusted
                </span>
              )}
            </span>
            <NumInput
              label={row.label}
              value={Math.round(
                displayedCents({ kind: "line", lineId: row.lineId }, row.monthlyCents, pending) /
                  100,
              )}
              onChange={(v) =>
                onStageEdit({ kind: "line", lineId: row.lineId }, row.label, row.monthlyCents, v)
              }
              prefix="$"
              step={50}
            />
            <span className={styles.rowActions}>
              <button
                type="button"
                aria-label={`Edit ${row.label}`}
                onClick={() => onToggleLineForm(row.lineId)}
              >
                Edit
              </button>
              <button
                type="button"
                aria-label={`Delete ${row.label}`}
                onClick={() => onDeleteLine(row.lineId)}
              >
                Delete
              </button>
            </span>
          </div>
          {authoring?.kind === "edit" && authoring.id === row.lineId && (
            <BudgetLineForm
              initial={lineToDraft(lines.find((l) => l.id === row.lineId)!)}
              submitLabel="Save"
              onSubmit={(draft) => onSubmitLineForm(row.lineId, draft)}
              onCancel={onCloseLineForm}
            />
          )}
        </div>
      ))}

      {/* ── The one question an edit asks: how long does this last? (§20) ── */}
      {pending !== null && (
        <div
          className={styles.scopePrompt}
          data-testid="scope-prompt"
          role="group"
          aria-label="How long should this change last?"
        >
          <p className={styles.scopeQuestion}>
            {pending.label} {formatDollars(pending.priorAmountCents)} →{" "}
            {formatDollars(pending.newAmountCents)} at month {selectedMonth}. How long?
          </p>
          <button className="btn" onClick={() => onCommit("thisMonthOnly")} type="button">
            Just this month
          </button>
          <button className="btn primary" onClick={() => onCommit("fromHereForward")} type="button">
            From here forward
          </button>
          <button className="btn ghost" onClick={onCancelEdit} type="button">
            Cancel
          </button>
        </div>
      )}

      {lastRoute && (
        <p className={styles.routeEcho} data-testid="adjustment-route">
          {describeRoute(lastRoute.route, lastRoute.label)}
        </p>
      )}
    </>
  );
}
