/**
 * A dated, source-directed cash outflow is recorded — a OneTimeSpendEvent. Unlike a dated
 * expense override, the user names WHICH accounts (cash or credit) fund it and in what order;
 * a shortfall against those sources blocks the projection rather than auto-liquidating or
 * silently financing itself.
 */

import { useMemo, useState } from "react";
import { dollarsToCents, type FundingLookup } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

const DEFAULT_AMOUNT = 10_000;

interface OneTimeSpendDraft {
  readonly month: number;
  readonly label: string;
  readonly amount: number;
  /** Accounts and/or credit cards drained IN ORDER. */
  readonly sourceIds: readonly string[];
}

export function OneTimeSpendForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  funding,
  edit,
}: FormProps & {
  /** The eligible-source pool (cash and credit, for an `expense`) and its coverage verdict. */
  funding: FundingLookup;
  edit?: EditProps<EventOf<"OneTimeSpendEvent">>;
}) {
  const fundableAt = (month: number) =>
    funding.eligibleSourcesAt("expense", month).filter((s) => s.balanceCents > 0).map((s) => s.id);

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
          label: "",
          amount: DEFAULT_AMOUNT,
          sourceIds: fundableAt(defaultMonth).slice(0, 1),
        },
  );
  const patch = (fields: Partial<OneTimeSpendDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Moving the spend re-prices every source at the new month; drop any no longer fundable
  // there rather than silently spending money the user did not choose to spend.
  const setMonth = (month: number) =>
    setDraft((d) => {
      const fundable = new Set(fundableAt(month));
      return { ...d, month, sourceIds: d.sourceIds.filter((id) => fundable.has(id)) };
    });

  const pool = useMemo(
    () => funding.eligibleSourcesAt("expense", draft.month),
    [funding, draft.month],
  );
  const sourceIds = useMemo(
    () => draft.sourceIds.filter((id) => pool.some((s) => s.id === id && s.balanceCents > 0)),
    [draft.sourceIds, pool],
  );
  const availability = useMemo(
    () => funding.availabilityAt(sourceIds, dollarsToCents(draft.amount), draft.month),
    [funding, sourceIds, draft.amount, draft.month],
  );

  function submit() {
    const label = draft.label.trim() || "One-time spend";
    if (edit) {
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "oneTimeSpend",
          month: draft.month,
          label,
          amountCents: dollarsToCents(draft.amount),
          fundingSourceIds: sourceIds,
        }),
      );
      return;
    }
    onAdd((p) =>
      p.oneTimeSpend({
        month: draft.month,
        label,
        amountCents: dollarsToCents(draft.amount),
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
          placeholder="New car, a wedding, a renovation…"
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
        Accounts and cards are drained in the order you pick them. If the sources you name fall
        short, the plan is flagged rather than the spend silently financing itself on credit — the
        event still records, and you can re-point its funding or the amount at any time.
      </p>
    </>
  );
}
