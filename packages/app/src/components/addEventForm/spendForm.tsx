/** A one-time spend — an OneTimeSpendEvent (a pure, source-directed outflow). */

import { useMemo, useState } from "react";
import { dollarsToCents, type FundingLookup } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type FormProps } from "./formControls";
import { FundingSourcePicker } from "./fundingSourcePicker";

/**
 * Opening values for the form — a plausible starter spend the user edits, not a
 * recommendation. Dollars, matching the input below; the cents conversion happens at the
 * engine boundary on submit.
 */
const DEFAULTS: Omit<SpendDraft, "month" | "sourceIds"> = {
  amount: 30_000,
  label: "Big purchase",
};

/**
 * The form's live state — one draft in the units the fields edit (dollars), not a hook per
 * field. The cents conversion happens at the engine boundary on submit.
 */
interface SpendDraft {
  readonly month: number;
  readonly amount: number;
  readonly label: string;
  /**
   * The accounts the spend drains, IN ORDER — the first empties before the next. The render
   * filters it to what can still pay at `month` before anything reads it, so treat this as the
   * stored intent rather than the live selection.
   */
  readonly sourceIds: readonly string[];
}

export function SpendForm({
  defaultMonth,
  nextId,
  horizonMonths,
  onAdd,
  funding,
}: FormProps & {
  /** The engine's funding questions — the same pair `addEvent`'s hard block answers with. */
  funding: FundingLookup;
}) {
  // The accounts that can actually pay at `month`, in the engine's drain-order-friendly
  // largest-first order. Only these can be selected.
  const fundableAt = (month: number) =>
    funding.sourcesAt(month).filter((s) => s.balanceCents > 0).map((s) => s.id);

  const [draft, setDraft] = useState<SpendDraft>(() => ({
    month: defaultMonth,
    ...DEFAULTS,
    // Open on the largest account that can pay at that month, so the form is usable without a
    // choice — the user then reorders or adds.
    sourceIds: fundableAt(defaultMonth).slice(0, 1),
  }));
  const patch = (fields: Partial<SpendDraft>) => setDraft((d) => ({ ...d, ...fields }));

  /**
   * Moving the spend re-prices every account: one the user picked while it held money may hold
   * nothing at the new month. Drop it from the draft as the month moves — a selection the user
   * can no longer see is a selection they no longer have. Nothing takes its place: which
   * account pays is the user's call, and quietly substituting one would spend money they did
   * not choose to spend.
   */
  const setMonth = (month: number) =>
    setDraft((d) => {
      const fundable = new Set(fundableAt(month));
      return { ...d, month, sourceIds: d.sourceIds.filter((id) => fundable.has(id)) };
    });

  // The pool and the verdict for the CURRENT month/selection/amount. Both come from one
  // projection inside `funding`, so this re-derives on edit without re-simulating the plan.
  const pool = useMemo(() => funding.sourcesAt(draft.month), [funding, draft.month]);
  // The selection actually in play. `setMonth` prunes on the path a user takes, but the pool
  // also moves when `funding` itself changes; filtering here makes it an invariant — what the
  // picker shows checked, what the coverage line counts, and what `submit` records are one list.
  const sourceIds = useMemo(
    () => draft.sourceIds.filter((id) => pool.some((s) => s.id === id && s.balanceCents > 0)),
    [draft.sourceIds, pool],
  );
  const availability = useMemo(
    () => funding.availabilityAt(sourceIds, dollarsToCents(draft.amount), draft.month),
    [funding, sourceIds, draft.amount, draft.month],
  );

  function submit() {
    onAdd({
      id: `e${nextId}`,
      type: "OneTimeSpendEvent",
      month: draft.month,
      amountCents: dollarsToCents(draft.amount),
      // The user's chosen accounts, in the order they chose them — the drain order the
      // simulator resolves the spend against. The pruned list, so an account that emptied under
      // a month change cannot ride onto the event unseen.
      fundingSourceIds: sourceIds,
      label: draft.label,
    });
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={setMonth} />
      <label className="field">
        <span className="field-label">What for</span>
        <input
          type="text"
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </label>
      <NumInput label="Amount" value={draft.amount} onChange={(amount) => patch({ amount })} prefix="$" step={5000} />
      <FundingSourcePicker
        pool={pool}
        selected={sourceIds}
        amountCents={dollarsToCents(draft.amount)}
        availability={availability}
        onChange={(sourceIds) => patch({ sourceIds })}
        label="Spending paid from"
      />
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
      <p className="hint">
        Accounts are drained in the order you pick them, and only cash and
        investment accounts can pay — retirement savings and credit can’t. If the
        chosen accounts can’t cover it, the spend is blocked.
      </p>
    </>
  );
}
