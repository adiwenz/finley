/**
 * Goal authoring form (§5.2, Slice 5b) — the disclosed add/edit surface for a goal
 * on the value-editing plane (§4.2 / §10.3): a direct override, NO timeline event.
 * Holds the disposition and target date as separate controls and folds them back
 * into a legal {@link GoalDisposal} via {@link goalDisposal} on submit, so a firing
 * disposition can never be authored without a month to fire at.
 *
 * Progressive disclosure (§10.4): this is rendered on demand by the panel, not
 * always open. The same form backs both add and edit — `initial` seeds it.
 */

import { useState } from "react";
import type { GoalDisposition } from "@finley/engine";
import { dollarsToCents, centsToDollars, isDisposingDisposition } from "@finley/engine";
import type { GoalDraft } from "../../goalsView";
import { goalDisposal, dispositionLabel } from "../../goalsView";
import { NumInput } from "../numInput/numInput";

const DISPOSITIONS: readonly GoalDisposition[] = [
  "retain",
  "convertToEquity",
  "spend",
  "drawDown",
];

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
    initial?.disposition ?? "spend",
  );
  const [asap, setAsap] = useState(initial?.targetDate === "asap");
  const [targetMonth, setTargetMonth] = useState(
    typeof initial?.targetDate === "number" ? initial.targetDate : 12,
  );
  const [annualReturnPct, setAnnualReturnPct] = useState(initial?.annualReturnPct ?? 0);

  // A firing disposition can't be "as soon as possible" — there'd be no month to
  // fire at. Force the date control back to a concrete month while one is selected.
  const asapAllowed = !isDisposingDisposition(disposition);
  const asapChecked = asap && asapAllowed;

  function submit() {
    onSubmit({
      name: name.trim(),
      targetCents: dollarsToCents(targetDollars),
      annualReturnPct,
      ...goalDisposal(disposition, asapChecked ? "asap" : targetMonth),
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
          checked={asapChecked}
          disabled={!asapAllowed}
          onChange={(e) => setAsap(e.target.checked)}
        />
        <span className="field-label">As soon as possible</span>
      </label>
      {!asapChecked && (
        <NumInput
          label="Target month"
          value={targetMonth}
          onChange={setTargetMonth}
          suffix="mo"
          min={0}
        />
      )}
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
