/** Value editor with the first-edit scope prompt (§10.5). */

import { useState } from "react";
import { dollarsToCents, type OverrideScope } from "@finley/engine";
import type { ValueOverride } from "../../planTypes";
import { formatDollars, monthLabel } from "../../format";
import styles from "./expenseEditor.module.css";

interface ExpenseEditorProps {
  cents: number;
  overrides: readonly ValueOverride[];
  scrubMonth: number;
  onSetBaseline: (cents: number) => void;
  onOverride: (o: ValueOverride) => void;
}

export function ExpenseEditor({
  cents,
  overrides,
  scrubMonth,
  onSetBaseline,
  onOverride,
}: ExpenseEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(cents / 100);

  function apply(scope: OverrideScope) {
    onOverride({ month: scrubMonth, monthlyCents: dollarsToCents(draft), scope });
    setEditing(false);
  }

  return (
    <div className={styles.valueEdit}>
      <div className="field-label">Monthly expenses</div>
      {!editing ? (
        <div className={styles.valueRow}>
          <button
            className={styles.valueBtn}
            onClick={() => {
              setDraft(cents / 100);
              setEditing(true);
            }}
          >
            {formatDollars(cents)}/mo
          </button>
        </div>
      ) : (
        <div className={styles.editPop}>
          <span className="field-input-wrap">
            <span className="field-affix">$</span>
            <input
              type="number"
              value={draft}
              step={100}
              autoFocus
              onChange={(e) => setDraft(Number(e.target.value))}
            />
          </span>
          {/* §10.5: the first edit asks the scope question. "override" never shown. */}
          <div className={styles.scopeQ}>Apply this change…</div>
          <div className={styles.scopeBtns}>
            <button className="btn" onClick={() => apply("thisMonthOnly")}>
              Just {monthLabel(scrubMonth)}
            </button>
            <button className="btn primary" onClick={() => apply("fromHereForward")}>
              From here forward
            </button>
          </div>
          <button
            className="btn link"
            onClick={() => {
              onSetBaseline(dollarsToCents(draft));
              setEditing(false);
            }}
          >
            Set as starting value
          </button>
          <button className="btn link" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}

      {overrides.length > 0 && (
        <ul className={styles.overrideList}>
          {overrides.map((o, i) => (
            <li key={i}>
              {o.scope === "fromHereForward"
                ? `From ${monthLabel(o.month)}: `
                : `${monthLabel(o.month)} only: `}
              {formatDollars(o.monthlyCents)}/mo
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
