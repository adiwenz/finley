/**
 * A one-time, source-directed spend — a OneTimeSpendEvent. Distinct from the boundary case a
 * dated expense override covers ("my grocery spending was temporarily higher"): this is for a
 * named amount drawn from named accounts (or a credit card), in order, that should FAIL to
 * authore if those sources can't cover it — "I'm spending $30k from my brokerage on a car, and
 * I want it to fail if that can't cover it."
 */

import { useMemo, useState } from "react";
import { dollarsToCents, type FundingLookup, type ProjectionResult } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

const DEFAULT_AMOUNT = 10_000;

interface OneTimeSpendDraft {
  readonly month: number;
  readonly label: string;
  readonly amount: number;
  /** Funding sources IN DRAIN ORDER. Stored intent, filtered to what can still pay before use. */
  readonly sourceIds: readonly string[];
}

export function OneTimeSpendForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  funding,
  edit,
}: FormProps & {
  /** The engine's funding questions — the same pair `addEvent`'s block reads from. */
  funding: FundingLookup;
  /** Unread here — this event carries no authoring-time advisory the way the home form's DTI does. */
  result?: ProjectionResult;
  edit?: EditProps<EventOf<"OneTimeSpendEvent">>;
}) {
  // Accounts AND credit cards that could pay at `month` — an expense, unlike a down payment, may
  // draw a card. `getEligibleFundingSources`'s eligibility, not a re-derived rule.
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
          amount: DEFAULT_AMOUNT,
          sourceIds: fundableAt(defaultMonth).slice(0, 1),
        },
  );
  const patch = (fields: Partial<OneTimeSpendDraft>) => setDraft((d) => ({ ...d, ...fields }));

  /**
   * Moving the spend re-prices every account, so one picked while it held money may hold nothing
   * at the new month. Drop it rather than quietly substitute another in its place.
   */
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
        label: draft.label || "One-time spend",
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
        <span className="field-label">What's it for?</span>
        <input
          type="text"
          value={draft.label}
          placeholder="e.g. New car"
          onChange={(e) => patch({ label: e.target.value })}
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
      <button className="btn primary" onClick={submit} disabled={draft.label.trim() === ""}>
        {edit ? "Save changes" : "Add event"}
      </button>
      <p className="hint">
        Accounts are drained in the order you pick them; a credit card borrows instead of selling,
        which increases its balance. If the sources you name fall short, the projection blocks at
        this month rather than the purchase being refused now.
      </p>
    </>
  );
}
