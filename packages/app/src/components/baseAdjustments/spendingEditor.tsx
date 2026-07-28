/**
 * The **Spending** rows of Base + Adjustments: every expense line at what it resolves to at
 * the selected month, the how-long question, and the echo of where that edit was routed.
 *
 * Stateless: the staged edit belongs to the panel (moving the month drops it), and the
 * disclosed form is single-at-a-time across this list and the contributions list.
 */

import { useMemo } from "react";
import { NumInput } from "../numInput/numInput";
import { BudgetLineForm } from "./budgetLineForm";
import { lineToDraft } from "./budgetLines";
import { formatDollars } from "../../format";
import type { BudgetLine } from "@finley/engine";
import type { EditRow, EditScope, MonthEditRoute, ResolvedRow } from "./monthEdit";
import type { LineAuthoring, LineFormActions } from "./budgetLineAuthoring";
import styles from "./baseAdjustments.module.css";

/** The row the user has typed a new number into, awaiting the how-long question. */
export interface PendingEdit {
  readonly row: EditRow;
  readonly label: string;
  readonly priorAmountCents: number;
  readonly newAmountCents: number;
}

export interface SpendingEditActions {
  readonly onStage: (row: EditRow, label: string, priorCents: number, dollars: number) => void;
  readonly onCommit: (scope: EditScope) => void;
  readonly onCancel: () => void;
}

/**
 * The staged value while an edit awaits its how-long answer, the resolved amount otherwise
 * — a field snapping back to the stored value on every keystroke would be unusable.
 */
function getInputCents(
  lineId: string,
  resolvedCents: number,
  pending: PendingEdit | null,
): number {
  const staged = pending?.row.kind === "line" && pending.row.lineId === lineId;
  return staged ? pending.newAmountCents : resolvedCents;
}

/**
 * Takes the row's `label` because the route carries only the line's authoring `id`
 * ("dining"), not what the row says ("Dining & fun").
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

interface SpendingRowProps {
  readonly row: ResolvedRow;
  /** The authored line behind this row — absent while a row outlives its line. */
  readonly line: BudgetLine | undefined;
  readonly pending: PendingEdit | null;
  readonly formOpen: boolean;
  readonly edit: SpendingEditActions;
  readonly form: LineFormActions;
}

function SpendingRow({ row, line, pending, formOpen, edit, form }: SpendingRowProps) {
  const editRow: EditRow = { kind: "line", lineId: row.lineId };
  return (
    <div>
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
          value={Math.round(getInputCents(row.lineId, row.monthlyCents, pending) / 100)}
          onChange={(v) => edit.onStage(editRow, row.label, row.monthlyCents, v)}
          prefix="$"
          step={50}
        />
        <span className={styles.rowActions}>
          <button type="button" aria-label={`Edit ${row.label}`} onClick={() => form.onToggle(row.lineId)}>
            Edit
          </button>
          <button type="button" aria-label={`Delete ${row.label}`} onClick={() => form.onDelete(row.lineId)}>
            Delete
          </button>
        </span>
      </div>
      {formOpen && line !== undefined && (
        <BudgetLineForm
          initial={lineToDraft(line)}
          submitLabel="Save"
          onSubmit={(draft) => form.onSubmit(row.lineId, draft)}
          onCancel={form.onClose}
        />
      )}
    </div>
  );
}

export interface SpendingEditorProps {
  /** Each expense line resolved to the selected month (amount, tier, adjusted flag). */
  readonly rows: readonly ResolvedRow[];
  /** The standing lines, for the disclosed edit form's initial draft. */
  readonly lines: readonly BudgetLine[];
  readonly selectedMonth: number;
  readonly pending: PendingEdit | null;
  readonly lastRoute: { readonly route: MonthEditRoute; readonly label: string } | null;
  readonly authoring: LineAuthoring | null;
  readonly edit: SpendingEditActions;
  readonly form: LineFormActions;
}

export function SpendingEditor({
  rows,
  lines,
  selectedMonth,
  pending,
  lastRoute,
  authoring,
  edit,
  form,
}: SpendingEditorProps) {
  // One lookup for the whole list, rather than a scan per row.
  const linesById = useMemo(() => new Map(lines.map((line) => [line.id, line])), [lines]);

  return (
    <>
      <h4 className={styles.groupHeading}>Spending</h4>
      {rows.map((row) => (
        <SpendingRow
          key={row.lineId}
          row={row}
          line={linesById.get(row.lineId)}
          pending={pending}
          formOpen={authoring?.kind === "edit" && authoring.id === row.lineId}
          edit={edit}
          form={form}
        />
      ))}

      {/* The one question an edit asks: how long does this last? */}
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
          <button className="btn" onClick={() => edit.onCommit("thisMonthOnly")} type="button">
            Just this month
          </button>
          <button
            className="btn primary"
            onClick={() => edit.onCommit("fromHereForward")}
            type="button"
          >
            From here forward
          </button>
          <button className="btn ghost" onClick={edit.onCancel} type="button">
            Cancel
          </button>
        </div>
      )}

      {lastRoute !== null ? (
        <p className={styles.routeEcho} data-testid="adjustment-route">
          {describeRoute(lastRoute.route, lastRoute.label)}
        </p>
      ) : null}
    </>
  );
}
