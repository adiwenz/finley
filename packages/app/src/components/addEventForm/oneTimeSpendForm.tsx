/**
 * A dated, source-directed spend is authored — a OneTimeSpendEvent. The boundary rule this form
 * exists to draw: "my grocery spending was temporarily higher" is a dated expense override
 * (edited under Budget); "I'm spending $30k from my brokerage on a car, and I want it to fail if
 * that can't cover it" is this. Reuses the same funding-source picker Home Purchase's down
 * payment does, extended here to list eligible credit cards alongside cash and investment
 * accounts — an expense, unlike a down payment, may borrow against one.
 *
 * Never refuses on affordability: an underfunded selection still submits, and the coverage line
 * only WARNS that the projection will block rather than gating `submit` the way Home Purchase's
 * down payment does.
 */

import { useMemo, useRef, useState } from "react";
import {
  dollarsToCents,
  type FundingLookup,
  type ProjectionResult,
} from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { monthLabel } from "../../format";
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

/** The first month a run reads as insolvent, or `null` while solvent throughout. */
function insolventFromMonth(result: ProjectionResult): number | null {
  return result.series.months.find((m) => m.isInsolvent)?.month ?? null;
}

/**
 * The post-add nudge's content, derived fresh from `beforeMonth` (the insolvency onset captured
 * right before the add, `null` meaning the plan was solvent throughout — a valid baseline, not
 * "no comparison pending") and the live `result`. Pure and exported so the specifically broken
 * case — solvent before, insolvent after — is pinned without rendering: a `null` baseline used to
 * be indistinguishable from "nothing to compare," which silently swallowed exactly this case.
 * `null` here means no nudge; the caller decides separately whether a baseline exists at all.
 */
export function insolvencyNudgeMessage(
  beforeMonth: number | null,
  result: ProjectionResult,
): string | null {
  // A block already says its own piece; the nudge is only for a plan that RUNS TO THE HORIZON
  // but insolvent, and only when this add is what moved the onset earlier (or introduced it) — a
  // pre-existing, unmoved insolvency is not this purchase's doing.
  if (result.series.status === "blocked") return null;
  const after = insolventFromMonth(result);
  if (after === null) return null;
  if (beforeMonth !== null && after >= beforeMonth) return null;
  return `This purchase is affordable, but it makes your plan insolvent from ${monthLabel(after)}.`;
}

export function OneTimeSpendForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  result,
  funding,
  edit,
}: FormProps & {
  /** The live run — the post-add insolvency nudge reads it, never re-simulated here. */
  result: ProjectionResult;
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

  // The post-add nudge: advisory, never a block, and only ABOUT an add just made — an edit does
  // not re-open it, matching Home Purchase's DTI advisory. `undefined` means no add has happened
  // yet this mount (no nudge); `null` is a legitimate baseline — the plan was solvent throughout
  // before the add — and must compare exactly like any other month. Derived fresh from `result`
  // on every render rather than latched into state, so it disappears the moment the condition no
  // longer holds, exactly as the advisory is specified to.
  const insolventBefore = useRef<number | null | undefined>(undefined);
  const nudge = useMemo(
    () => (insolventBefore.current === undefined ? null : insolvencyNudgeMessage(insolventBefore.current, result)),
    [result],
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
    insolventBefore.current = insolventFromMonth(result);
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
      <button className="btn primary" onClick={submit} disabled={!draft.label.trim() || sourceIds.length === 0}>
        {edit ? "Save changes" : "Add event"}
      </button>
      {nudge && (
        <div className="alert alert-amber soft-warning" role="status">
          {nudge}
        </div>
      )}
      <p className="hint">
        Accounts and credit cards are drained in the order you pick them. If they can&rsquo;t
        cover it, the projection blocks at this month rather than spilling to credit you didn&rsquo;t
        choose — this is different from a dated expense override, which finances itself from
        whatever the plan has and never blocks.
      </p>
    </>
  );
}
