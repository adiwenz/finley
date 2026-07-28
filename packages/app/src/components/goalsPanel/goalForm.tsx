/**
 * Goal authoring form — the add/edit surface on the value-editing plane: a direct override,
 * NO timeline event. Disposition and target date are separate controls, folded back into a
 * {@link GoalDisposal} via {@link goalDisposal} on submit. Both dispositions are purely
 * descriptive, so either accepts a concrete month or "as soon as possible".
 *
 * Rendered on demand by the panel, not always open. One form backs add and edit; `initial`
 * seeds it.
 */

import { useState } from "react";
import type { GoalDisposition, GoalAccountType } from "@finley/engine";
import { dollarsToCents, centsToDollars } from "@finley/engine";
import type { GoalDraft } from "../../goalsView";
import { goalDisposal, dispositionLabel, GOAL_ACCOUNT_TYPES } from "../../goalsView";
import { NumInput } from "../numInput/numInput";

const DISPOSITIONS: readonly GoalDisposition[] = ["retain", "drawDown"];

interface GoalFormProps {
  /** Seed values (an existing goal, when editing); omitted for a blank add form. */
  initial?: GoalDraft;
  /** Verb shown on the primary button and used to label the form ("Add" / "Save"). */
  submitLabel: string;
  onSubmit: (draft: GoalDraft) => void;
  onCancel: () => void;
}

export function GoalForm({ initial, submitLabel, onSubmit, onCancel }: GoalFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [targetDollars, setTargetDollars] = useState(
    initial ? centsToDollars(initial.targetCents) : 0,
  );
  const [disposition, setDisposition] = useState<GoalDisposition>(
    initial?.disposition ?? "retain",
  );
  const [asap, setAsap] = useState(initial?.targetDate === "asap");
  const [targetMonth, setTargetMonth] = useState(
    typeof initial?.targetDate === "number" ? initial.targetDate : 12,
  );
  const [annualReturnPct, setAnnualReturnPct] = useState(initial?.annualReturnPct ?? 0);
  // The account type the fund is held in — what a person actually knows. A fresh goal
  // defaults to cash/savings, the most familiar kind.
  const [accountType, setAccountType] = useState<GoalAccountType>(
    initial?.accountType ?? "cash",
  );

  function submit() {
    onSubmit({
      name: name.trim(),
      targetCents: dollarsToCents(targetDollars),
      annualReturnPct,
      accountType,
      ...goalDisposal(disposition, asap ? "asap" : targetMonth),
    });
  }

  return (
    <form
      className="goal-form"
      aria-label={`${submitLabel} goal`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <NumInput
        label="Target amount"
        value={targetDollars}
        onChange={setTargetDollars}
        prefix="$"
        step={500}
      />
      <label className="field">
        <span className="field-label">How will this money be used?</span>
        <select
          value={disposition}
          onChange={(e) => setDisposition(e.target.value as GoalDisposition)}
        >
          {DISPOSITIONS.map((d) => (
            <option key={d} value={d}>
              {dispositionLabel(d)}
            </option>
          ))}
        </select>
      </label>
      <label className="field field-check">
        <input
          type="checkbox"
          checked={asap}
          onChange={(e) => setAsap(e.target.checked)}
        />
        <span className="field-label">As soon as possible</span>
      </label>
      {!asap && (
        <NumInput
          label="Target month"
          value={targetMonth}
          onChange={setTargetMonth}
          suffix="mo"
          min={0}
        />
      )}
      <label className="field">
        <span className="field-label">Where is this money held?</span>
        <select
          value={accountType}
          onChange={(e) => setAccountType(e.target.value as GoalAccountType)}
        >
          {GOAL_ACCOUNT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <NumInput
        label="Fund return"
        value={annualReturnPct}
        onChange={setAnnualReturnPct}
        suffix="%"
        min={0}
        step={0.5}
      />
      <div className="goal-form-actions">
        <button type="submit">{submitLabel}</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
