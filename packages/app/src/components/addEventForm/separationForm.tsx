/** A partner leaves the household — a SeparationEvent (§4.3). */

import { useState } from "react";
import { dollarsToCents, membersAt, type Household } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { monthLabel } from "../../format";
import { MonthSelect, type FormProps } from "./formControls";

export function SeparationForm({
  household,
  defaultMonth,
  nextId,
  onAdd,
}: FormProps & { household: Household }) {
  const [month, setMonth] = useState(defaultMonth);
  const [partnerId, setPartnerId] = useState("");
  const [alimony, setAlimony] = useState(0);
  const [alimonyYears, setAlimonyYears] = useState(0);

  // Only partners actually in the household by the chosen separation month —
  // you can't separate from someone you haven't partnered with yet. Derived
  // during render so it tracks the month picker without a reset effect.
  const eligible = membersAt(household, month).filter((p) => p.id !== "p1");
  const noPartners = eligible.length === 0;
  const selectedId = eligible.some((p) => p.id === partnerId)
    ? partnerId
    : eligible[0]?.id ?? "";

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "SeparationEvent",
      month,
      partnerPersonId: selectedId,
      alimonyMonthlyCents: dollarsToCents(alimony),
      alimonyDurationMonths: alimony > 0 ? alimonyYears * 12 : 0,
      childSupportMonthlyCents: 0,
    });
  }

  return (
    <>
      <MonthSelect value={month} onChange={setMonth} />
      {noPartners ? (
        <p className="hint warn">
          No partner in the household as of {monthLabel(month)} to separate from.
        </p>
      ) : (
        <>
          <label className="field">
            <span className="field-label">From</span>
            <select value={selectedId} onChange={(e) => setPartnerId(e.target.value)}>
              {eligible.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <NumInput label="Alimony / mo" value={alimony} onChange={setAlimony} prefix="$" step={100} />
          {alimony > 0 && (
            <NumInput
              label="Alimony years"
              value={alimonyYears}
              onChange={setAlimonyYears}
              suffix="yr"
              min={1}
            />
          )}
          <p className="hint">Support terms are illustrative and vary by jurisdiction.</p>
        </>
      )}
      <button className="btn primary" disabled={noPartners} onClick={submit}>
        Add event
      </button>
    </>
  );
}
