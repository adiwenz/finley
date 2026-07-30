/** A partner leaves the household — a SeparationEvent. */

import { useState } from "react";
import { dollarsToCents, type ProjectionResult } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { monthLabel } from "../../format";
import { MonthSelect, type FormProps } from "./formControls";

/** The form's live state — one draft, not a hook per field. The eligible-partner list and
 *  resolved selection derive from `month`/`partnerId`, never stored. */
interface SeparationDraft {
  readonly month: number;
  readonly partnerId: string;
  readonly alimony: number;
  readonly alimonyYears: number;
}

export function SeparationForm({
  result,
  defaultMonth,
  horizonMonths,
  onAdd,
}: FormProps & { result: ProjectionResult }) {
  const [draft, setDraft] = useState<SeparationDraft>(() => ({
    month: defaultMonth,
    partnerId: "",
    alimony: 0,
    alimonyYears: 0,
  }));
  const patch = (fields: Partial<SeparationDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Only partners in the household by the chosen separation month — you can't separate
  // from someone you haven't partnered with yet. Derived during render so it tracks the
  // month picker without a reset effect, and the selection can't drift out of sync.
  const eligible = result.membersAt(draft.month).filter((p) => p.id !== "p1");
  const noPartners = eligible.length === 0;
  const selectedId = eligible.some((p) => p.id === draft.partnerId)
    ? draft.partnerId
    : eligible[0]?.id ?? "";

  function submit() {
    onAdd((p) =>
      p.separate({
        month: draft.month,
        partnerPersonId: selectedId,
        alimonyMonthlyCents: dollarsToCents(draft.alimony),
        // The years field appears only once there's an alimony amount to time, so a zero
        // amount means no duration whatever stale years value sits behind it.
        alimonyDurationMonths: draft.alimony > 0 ? draft.alimonyYears * 12 : 0,
        // childSupport defaults to 0 in the facade — the no-support separation is the plain case.
      }),
    );
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      {noPartners ? (
        <p className="hint warn">
          No partner in the household as of {monthLabel(draft.month)} to separate from.
        </p>
      ) : (
        <>
          <label className="field">
            <span className="field-label">From</span>
            <select value={selectedId} onChange={(e) => patch({ partnerId: e.target.value })}>
              {eligible.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <NumInput label="Alimony / mo" value={draft.alimony} onChange={(alimony) => patch({ alimony })} prefix="$" step={100} />
          {draft.alimony > 0 && (
            <NumInput
              label="Alimony years"
              value={draft.alimonyYears}
              onChange={(alimonyYears) => patch({ alimonyYears })}
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
