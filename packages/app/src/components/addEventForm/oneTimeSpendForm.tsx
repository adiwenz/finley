/**
 * A dated, source-directed cash outflow — a OneTimeSpendEvent. Unlike Home Purchase, it never
 * refuses on affordability: an underfunded selection still submits, and the projection blocks at
 * the event's month instead. Credit cards are eligible sources (this is an expense, not an asset
 * acquisition), so the picker's pool is asked for the `"expense"`-eligible pool.
 */

import { useMemo, useState } from "react";
import { dollarsToCents, type FundingLookup } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

const DEFAULTS: Omit<OneTimeSpendDraft, "month" | "sourceIds"> = {
  label: "One-time spend",
  amount: 10_000,
};

interface OneTimeSpendDraft {
  readonly month: number;
  readonly label: string;
  readonly amount: number;
  /** Sources drained IN ORDER — the first empties (or, for a card, borrows) before the next. */
  readonly sourceIds: readonly string[];
}

export function OneTimeSpendForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  funding,
  edit,
}: FormProps & {
  /** The engine's funding questions — same pair the picker and the projection's block agree on. */
  funding: FundingLookup;
  edit?: EditProps<EventOf<"OneTimeSpendEvent">>;
}) {
  // Cash/investment accounts AND eligible credit cards — an expense may draw either.
  const fundableAt = (month: number) =>
    funding.sourcesAt(month, "expense").filter((s) => s.balanceCents > 0).map((s) => s.id);

  const [draft, setDraft] = useState<OneTimeSpendDraft>(() =>
    edit
      ? {
          month: edit.event.month,
          label: edit.event.label,
          amount: edit.event.amountCents / 100,
          sourceIds: edit.event.fundingSourceIds,
        }
      : {
          month: defaultMonth,
          ...DEFAULTS,
          sourceIds: fundableAt(defaultMonth).slice(0, 1),
        },
  );
  const patch = (fields: Partial<OneTimeSpendDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Moving the spend re-prices every source; drop one that can no longer pay rather than
  // silently keep it selected.
  const setMonth = (month: number) =>
    setDraft((d) => {
      const fundable = new Set(fundableAt(month));
      return { ...d, month, sourceIds: d.sourceIds.filter((id) => fundable.has(id)) };
    });

  const pool = useMemo(() => funding.sourcesAt(draft.month, "expense"), [funding, draft.month]);
  const sourceIds = useMemo(
    () => draft.sourceIds.filter((id) => pool.some((s) => s.id === id && s.balanceCents > 0)),
    [draft.sourceIds, pool],
  );
  const availability = useMemo(
    () => funding.availabilityAt(sourceIds, dollarsToCents(draft.amount), draft.month),
    [funding, sourceIds, draft.amount, draft.month],
  );

  function submit() {
    if (edit) {
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "spendOnce",
          month: draft.month,
          label: draft.label,
          amountCents: dollarsToCents(draft.amount),
          fundingSourceIds: sourceIds,
        }),
      );
      return;
    }
    onAdd((p) =>
      p.spendOnce({
        month: draft.month,
        label: draft.label,
        amountCents: dollarsToCents(draft.amount),
        fundingSourceIds: sourceIds,
      }),
    );
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={setMonth} />
      <label className="field">
        <span className="field-label">What for?</span>
        <input
          type="text"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </label>
      <NumInput
        label="Amount"
        value={draft.amount}
        onChange={(amount) => patch({ amount })}
        prefix="$"
        step={1000}
      />
      <FundingSourcePicker
        pool={pool}
        selected={sourceIds}
        amountCents={dollarsToCents(draft.amount)}
        availability={availability}
        onChange={(sourceIds) => patch({ sourceIds })}
        label="Paid from"
      />
      <button className="btn primary" onClick={submit}>
        {edit ? "Save changes" : "Add event"}
      </button>
      <p className="hint">
        Sources are drained in the order you pick them. If they cannot cover the amount, the
        plan records this event but the projection will show it as blocked at that month —
        nothing here refuses the amount upfront.
      </p>
    </>
  );
}
