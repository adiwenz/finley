/**
 * A dated, source-directed spend is authored — a OneTimeSpendEvent. The boundary rule this form
 * exists to draw: "my grocery spending was temporarily higher" is a dated expense override
 * (edited under Budget); "I'm spending $30k from my brokerage on a car, and I want it to fail if
 * that can't cover it" is this. Reuses the same funding-source picker Home Purchase's down
 * payment does, extended here to list eligible credit cards alongside cash and investment
 * accounts — an expense, unlike a down payment, may borrow against one.
 *
 * The selected sources must fully cover the amount: `Add event` (and `Save changes`, editing) is
 * disabled while `availability.shortfallCents > 0`, and the coverage line under the picker states
 * what is covered and what remains short. Unlike Home Purchase, which lets the engine's own §4.5
 * gate refuse an unaffordable down payment at `submit`, a One-Time Spend never even reaches the
 * engine short — this form is the gate.
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
  /** Sources drained in order — cash/investment accounts and, eligibly, credit cards. */
  readonly sourceIds: readonly string[];
}

const DEFAULTS: Omit<OneTimeSpendDraft, "month" | "sourceIds"> = {
  label: "",
  amount: 10_000,
};

export function OneTimeSpendForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  funding,
  edit,
}: FormProps & {
  /** The engine's funding questions, extended to list eligible credit cards for an expense. */
  funding: FundingLookup;
  edit?: EditProps<EventOf<"OneTimeSpendEvent">>;
}) {
  const [draft, setDraft] = useState<OneTimeSpendDraft>(() =>
    edit
      ? {
          month: edit.event.month,
          label: edit.event.label,
          amount: edit.event.amountCents / 100,
          sourceIds: edit.event.fundingSourceIds,
        }
      : { month: defaultMonth, ...DEFAULTS, sourceIds: [] },
  );
  const patch = (fields: Partial<OneTimeSpendDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Moving the spend re-prices every source at the new month; drop a selection that can no
  // longer pay rather than silently spending money the user did not choose to spend there —
  // the same rule Home Purchase's down payment applies to its own source list.
  const setMonth = (month: number) =>
    setDraft((d) => {
      const fundable = new Set(
        funding.sourcesAt(month, "expense").filter((s) => s.balanceCents > 0).map((s) => s.id),
      );
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
  // Cash/investment balances and credit headroom are both already netted into this ONE verdict —
  // the same figure the picker's own coverage line reads — so the button and the line can never
  // disagree about whether the selection is enough.
  const underfunded = availability.shortfallCents > 0;

  function submit() {
    // Belt and suspenders: the button is already disabled while underfunded, but an unfunded
    // spend must never be authored regardless of how `submit` gets called.
    if (underfunded) return;
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
          className="text-input"
          type="text"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
          placeholder="Car, wedding, renovation…"
        />
      </label>
      <NumInput label="Amount" value={draft.amount} onChange={(amount) => patch({ amount })} prefix="$" step={1000} />
      <FundingSourcePicker
        pool={pool}
        selected={sourceIds}
        amountCents={dollarsToCents(draft.amount)}
        availability={availability}
        onChange={(sourceIds) => patch({ sourceIds })}
        label="Funded from"
      />
      <button
        className="btn primary"
        onClick={submit}
        disabled={!draft.label.trim() || sourceIds.length === 0 || underfunded}
      >
        {edit ? "Save changes" : "Add event"}
      </button>
      <p className="hint">
        Accounts and credit cards are drained in the order you pick them. The selected sources
        must fully cover the amount — this is different from a dated expense override, which
        finances itself from whatever the plan has.
      </p>
    </>
  );
}
