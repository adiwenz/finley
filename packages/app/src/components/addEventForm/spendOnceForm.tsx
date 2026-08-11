/**
 * A dated, source-directed spend — a OneTimeSpendEvent. Unlike Home Purchase, adding it is never
 * refused on affordability: a selection that falls short is still recorded and blocks the
 * PROJECTION at its month instead, so the picker's coverage line is advice here, not a preview of
 * a hard block.
 */

import { useMemo, useState } from "react";
import { dollarsToCents, type FundingLookup } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

const DEFAULT_LABEL = "One-time spend";
const DEFAULT_AMOUNT = 30_000;

interface SpendOnceDraft {
  readonly month: number;
  readonly label: string;
  readonly amount: number;
  /** Sources chosen, IN DRAIN ORDER — the same stored-intent contract {@link HomePurchaseForm} uses. */
  readonly sourceIds: readonly string[];
}

export function SpendOnceForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  funding,
  edit,
}: FormProps & {
  /** The engine's funding questions — the same pair the picker and (for Home Purchase) the gate share. */
  funding: FundingLookup;
  edit?: EditProps<EventOf<"OneTimeSpendEvent">>;
}) {
  const fundableAt = (month: number) =>
    funding.sourcesAt(month).filter((s) => s.balanceCents > 0).map((s) => s.id);

  const [draft, setDraft] = useState<SpendOnceDraft>(() =>
    edit
      ? {
          month: edit.event.month,
          label: edit.event.label,
          amount: edit.event.amountCents / 100,
          sourceIds: edit.event.fundingSourceIds,
        }
      : {
          month: defaultMonth,
          label: DEFAULT_LABEL,
          amount: DEFAULT_AMOUNT,
          sourceIds: fundableAt(defaultMonth).slice(0, 1),
        },
  );
  const patch = (fields: Partial<SpendOnceDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Moving the spend re-prices every account, so a source picked while it held money may hold
  // nothing at the new month — dropped rather than silently kept, mirroring the home form.
  const setMonth = (month: number) =>
    setDraft((d) => {
      const fundable = new Set(fundableAt(month));
      return { ...d, month, sourceIds: d.sourceIds.filter((id) => fundable.has(id)) };
    });

  const pool = useMemo(() => funding.sourcesAt(draft.month), [funding, draft.month]);
  const sourceIds = useMemo(
    () => draft.sourceIds.filter((id) => pool.some((s) => s.id === id && s.balanceCents > 0)),
    [draft.sourceIds, pool],
  );
  const availability = useMemo(
    () => funding.availabilityAt(sourceIds, dollarsToCents(draft.amount), draft.month),
    [funding, sourceIds, draft.amount, draft.month],
  );

  function submit() {
    const label = draft.label.trim() || DEFAULT_LABEL;
    if (edit) {
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "spendOnce",
          month: draft.month,
          label,
          amountCents: dollarsToCents(draft.amount),
          fundingSourceIds: sourceIds,
        }),
      );
      return;
    }
    onAdd((p) =>
      p.spendOnce({
        month: draft.month,
        label,
        amountCents: dollarsToCents(draft.amount),
        // Chosen order = the drain order the simulator resolves the spend against.
        fundingSourceIds: sourceIds,
      }),
    );
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={setMonth} />
      <label className="field">
        <span className="field-label">What for</span>
        <input
          className="text-input"
          type="text"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
          placeholder={DEFAULT_LABEL}
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
        Drained from the accounts and cards you pick, in that order. If they can’t cover the full
        amount, the plan blocks at this month instead of financing the rest automatically.
      </p>
    </>
  );
}
