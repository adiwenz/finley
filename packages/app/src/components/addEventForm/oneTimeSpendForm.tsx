/**
 * A dated, source-directed spend — a OneTimeSpendEvent. The boundary rule this form exists to
 * draw: "my grocery spending was temporarily higher" is a dated expense override, edited under
 * Budget; "I'm spending $30k from my brokerage on a car, and I want it to fail if that can't
 * cover it" is this form. The differentiator is source-direction plus a coverage gate, not
 * reachability — a plain override can already sell investments to cover itself; this names WHICH
 * accounts (their order controls which capital gains are realized) and blocks rather than
 * silently financing when they fall short.
 */

import { useMemo, useState } from "react";
import { dollarsToCents, type FundingLookup } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

interface OneTimeSpendDraft {
  readonly month: number;
  readonly label: string;
  readonly amount: number;
  /** Accounts and/or credit cards the spend drains, IN ORDER. */
  readonly sourceIds: readonly string[];
}

export function OneTimeSpendForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  funding,
  edit,
}: FormProps & {
  /** The engine's funding questions, credit cards included (`treatment: "expense"`). */
  funding: FundingLookup;
  edit?: EditProps<EventOf<"OneTimeSpendEvent">>;
}) {
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
          label: "",
          amount: 5000,
          sourceIds: fundableAt(defaultMonth).slice(0, 1),
        },
  );
  const patch = (fields: Partial<OneTimeSpendDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Moving the spend re-prices every account; drop a selection the new month can no longer pay,
  // exactly as the down-payment form does — never substitute one quietly.
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
        <span className="field-label">What is it?</span>
        <input
          className="text-input"
          type="text"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
          placeholder="New car"
        />
      </label>
      <NumInput label="Amount" value={draft.amount} onChange={(amount) => patch({ amount })} prefix="$" step={1000} />
      <FundingSourcePicker
        pool={pool}
        selected={sourceIds}
        amountCents={dollarsToCents(draft.amount)}
        availability={availability}
        onChange={(sourceIds) => patch({ sourceIds })}
        label="Paid from"
      />
      <button className="btn primary" onClick={submit} disabled={draft.label.trim().length === 0}>
        {edit ? "Save changes" : "Add event"}
      </button>
      <p className="hint">
        Accounts and credit cards are drained in the order you pick them. If the sources you name
        fall short, the plan blocks at this month instead of financing it for you.
      </p>
    </>
  );
}
