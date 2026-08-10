/** A dated, source-directed spend — a OneTimeSpendEvent. */

import { useMemo, useState } from "react";
import {
  dollarsToCents,
  type FundingLookup,
  type OneTimeSpendInput,
  type OneTimeSpendNudge,
} from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { monthLabel } from "../../format";
import { MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

const DEFAULTS: Omit<OneTimeSpendDraft, "month" | "sourceIds"> = {
  label: "One-time purchase",
  amount: 10_000,
};

interface OneTimeSpendDraft {
  readonly month: number;
  readonly label: string;
  readonly amount: number;
  /** Accounts (and, unlike a down payment, credit cards) drained IN ORDER. */
  readonly sourceIds: readonly string[];
}

export function OneTimeSpendForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  funding,
  edit,
  previewNudge,
}: FormProps & {
  /** The engine's funding questions — expense treatment, so a credit card is offered too. */
  funding: FundingLookup;
  edit?: EditProps<EventOf<"OneTimeSpendEvent">>;
  /**
   * The soft, non-blocking whole-month-feasibility read (§5): re-projects the ledger with THIS
   * draft added and reports whether it introduces new insolvency later in the plan. `undefined`
   * when the draft itself is refused (e.g. a shortfall the picker's coverage line already shows).
   */
  previewNudge?: (input: OneTimeSpendInput) => OneTimeSpendNudge | null;
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
          ...DEFAULTS,
          sourceIds: fundableAt(defaultMonth).slice(0, 1),
        },
  );
  const patch = (fields: Partial<OneTimeSpendDraft>) => setDraft((d) => ({ ...d, ...fields }));

  // Moving the spend re-prices every account; an account picked while it held money may hold
  // nothing at the new month. Drop it rather than silently substitute one the user did not choose.
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
  const amountCents = dollarsToCents(draft.amount);
  const availability = useMemo(
    () => funding.availabilityAt(sourceIds, amountCents, draft.month),
    [funding, sourceIds, amountCents, draft.month],
  );

  const input: OneTimeSpendInput = {
    month: draft.month,
    label: draft.label,
    amountCents,
    fundingSourceIds: sourceIds,
  };
  // Only asked once the draw itself covers — a shortfall already reads from `availability`,
  // and re-pricing a doomed draw for insolvency would be a second, redundant warning.
  const nudge =
    !edit && availability.shortfallCents <= 0 && sourceIds.length > 0
      ? previewNudge?.(input) ?? null
      : null;

  function submit() {
    if (edit) {
      edit.onRevise((p) =>
        p.reviseTransaction(edit.event.id, {
          type: "oneTimeSpend",
          month: draft.month,
          label: draft.label,
          amountCents,
          fundingSourceIds: sourceIds,
        }),
      );
      return;
    }
    onAdd((p) => p.oneTimeSpend(input));
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
      <NumInput label="Amount" value={draft.amount} onChange={(amount) => patch({ amount })} prefix="$" step={1000} />
      <FundingSourcePicker
        pool={pool}
        selected={sourceIds}
        amountCents={amountCents}
        availability={availability}
        onChange={(sourceIds) => patch({ sourceIds })}
        label="Paid from"
      />
      <button className="btn primary" onClick={submit}>
        {edit ? "Save changes" : "Add event"}
      </button>
      {nudge && <InsolvencyNudge nudge={nudge} />}
      <p className="hint">
        Accounts are drained in the order you pick them; a credit card can pay too, which
        borrows against it rather than selling anything. A shortfall against the named
        sources blocks the projection at this month — nothing is moved for you.
      </p>
    </>
  );
}

/** Soft, non-dismissible advisory — never a block. Renders only while its condition holds. */
function InsolvencyNudge({ nudge }: { nudge: OneTimeSpendNudge }) {
  return (
    <div className="alert alert-amber soft-warning" role="status">
      <strong>Heads up.</strong> This purchase is affordable, but it makes your plan insolvent
      from {monthLabel(nudge.insolventFromMonth)} — its realized gain and the tax it owes widen
      the gap decumulation has to close. The purchase still records; this is advice, not a
      block.
    </div>
  );
}
