/** A partner leaves the household — a SeparationEvent. */

import { useState } from "react";
import { dollarsToCents, type ProjectionResult } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { commitFocusedField } from "../numInput/commitFocusedField";
import { monthLabel } from "../../format";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";

/** The form's live state — one draft, not a hook per field. Who you are separating FROM is not
 *  among these fields: the household has at most one partner, so it is derived from `month`. */
interface SeparationDraft {
  readonly month: number;
  readonly alimony: number;
  readonly alimonyYears: number;
}

export function SeparationForm({
  result,
  defaultMonth,
  horizonMonths,
  onAdd,
  edit,
}: FormProps & { result: ProjectionResult; edit?: EditProps<EventOf<"SeparationEvent">> }) {
  const [draft, setDraft] = useState<SeparationDraft>(() =>
    edit
      ? {
          month: edit.event.month,
          alimony: edit.event.alimonyMonthlyCents / 100,
          alimonyYears: edit.event.alimonyDurationMonths / 12,
        }
      : { month: defaultMonth, alimony: 0, alimonyYears: 0 },
  );
  const patch = (fields: Partial<SeparationDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // The household's one partner as of the chosen month — there cannot be a second, so there is
  // nothing to pick and no picker to keep in sync. Derived during render so it tracks the month
  // selector: moving the date before the partnering, or past a separation already booked, leaves
  // nobody to separate from and the form says so rather than submitting a refusal.
  const partner = edit ? null : result.activePartnerAt(draft.month);
  const noPartner = !edit && partner === null;

  // Moving a separation LATER lengthens the partnership it ends, which can run it into a
  // partnership already booked behind it — the same span overlap the ledger refuses on, asked of
  // the date being typed rather than of the one on the timeline. The relationship this event ends
  // is identity and never re-pointed, so the span's other end is fixed and only this date moves.
  const ended = result.household.memberships.find(
    (m) => m.person.id === (edit ? edit.event.partnerPersonId : partner?.id),
  );
  const rawConflict =
    ended === undefined || !Number.isFinite(ended.startMonth)
      ? null
      : result.partnershipConflict({
          month: ended.startMonth,
          person: ended.person,
          separationMonth: draft.month,
        });
  const conflictReason =
    rawConflict === null ? null : `${rawConflict.charAt(0).toUpperCase()}${rawConflict.slice(1)}.`;

  function submit() {
    // A revision cannot re-point `partnerPersonId` — who you separated from is identity, not
    // data — so an edit names only the month and the support terms, and the partner is fixed.
    if (edit) {
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "separate",
          month: draft.month,
          alimonyMonthlyCents: dollarsToCents(draft.alimony),
          alimonyDurationMonths: draft.alimony > 0 ? draft.alimonyYears * 12 : 0,
        }),
      );
      return;
    }
    if (partner === null) return;
    onAdd((p) =>
      p.separate({
        month: draft.month,
        partnerPersonId: partner.id,
        alimonyMonthlyCents: dollarsToCents(draft.alimony),
        // The years field appears only once there's an alimony amount to time, so a zero
        // amount means no duration whatever stale years value sits behind it.
        alimonyDurationMonths: draft.alimony > 0 ? draft.alimonyYears * 12 : 0,
        // childSupport defaults to 0 in the facade — the no-support separation is the plain case.
      }),
    );
  }

  // Whoever the event names, read off the roster by id rather than by who is present at the
  // separation month — at that month they have already left, which is the whole point of it.
  const partnerName = edit
    ? result.household.memberships.find((m) => m.person.id === edit.event.partnerPersonId)?.person
        .name ?? "this partner"
    : partner?.name ?? "";

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      {noPartner ? (
        <p className="hint warn">
          No partner in the household as of {monthLabel(draft.month)} to separate from.
        </p>
      ) : (
        <>
          {/* Stated, not chosen: one partnership at a time means there is only ever one answer. */}
          <div className="field">
            <span className="field-label">From</span>
            <span>{partnerName}</span>
          </div>
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
      {conflictReason !== null && (
        <p className="hint warn" role="status">
          {conflictReason}
        </p>
      )}
      {/* In edit mode the partner is fixed, so the no-partner gate (an add-time concern) never
          applies — a month moved before the partnership is a refusal the engine surfaces. */}
      <button
        className="btn primary"
        disabled={noPartner || conflictReason !== null}
        onPointerDown={commitFocusedField}
        onClick={submit}
      >
        {edit ? "Save changes" : "Add event"}
      </button>
    </>
  );
}
