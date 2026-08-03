/** A new liability is taken on — a LoanEvent. */

import { useRef, useState } from "react";
import { dollarsToCents, PRIMARY_PERSON_ID, type OriginableLoanKind } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type FormProps } from "./formControls";

const DEFAULT_TERM_YEARS = 5;

/**
 * The form's live state, mirroring the engine's `LoanEvent`. A credit card is revolving and
 * carries a credit limit instead of a term, so its arm has NO term — the union gives the
 * in-progress form the same illegal-state guard the submitted event has.
 */
type LoanCommon = { readonly month: number; readonly amount: number; readonly apr: number };
type LoanDraft =
  | (LoanCommon & { readonly kind: "creditCard" })
  | (LoanCommon & {
      readonly kind: Exclude<OriginableLoanKind, "creditCard">;
      readonly termYears: number;
    });

export function LoanForm({ defaultMonth, horizonMonths, onAdd }: FormProps) {
  const [draft, setDraft] = useState<LoanDraft>(() => ({
    month: defaultMonth,
    kind: "studentLoan",
    amount: 2000,
    apr: 6,
    termYears: DEFAULT_TERM_YEARS,
  }));

  // Switching to a credit card drops the term arm; switching back restores the last term
  // entered rather than the default. UX memory, not domain state, so it stays out of the draft
  // and the active arm's `termYears` remains the single truth. (Mirrors `jobForm`'s `endAge`.)
  const lastTermYears = useRef(DEFAULT_TERM_YEARS);

  // Shared fields live on every arm, so a spread patch preserves whichever arm is active.
  const patch = (fields: Partial<LoanCommon>) => setDraft((d) => ({ ...d, ...fields }));

  // Switching kind rebuilds the arm with a valid value for its own field, preserving the
  // shared amount/apr/month.
  function setKind(kind: OriginableLoanKind) {
    setDraft((d) => {
      if (d.kind === kind) return d;
      const common: LoanCommon = { month: d.month, amount: d.amount, apr: d.apr };
      return kind === "creditCard"
        ? { ...common, kind }
        : { ...common, kind, termYears: lastTermYears.current };
    });
  }

  const setTermYears = (termYears: number) => {
    lastTermYears.current = termYears;
    setDraft((d) => (d.kind === "creditCard" ? d : { ...d, termYears }));
  };

  function submit() {
    const common = {
      month: draft.month,
      ownerId: PRIMARY_PERSON_ID,
      openingBalanceCents: dollarsToCents(draft.amount),
      apr: draft.apr / 100,
    } as const;
    onAdd((p) =>
      p.takeLoan(
        draft.kind === "creditCard"
          ? { ...common, kind: draft.kind, creditLimitCents: dollarsToCents(draft.amount * 2) }
          : { ...common, kind: draft.kind, termMonths: draft.termYears * 12 },
      ),
    );
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      <label className="field">
        <span className="field-label">Type</span>
        <select value={draft.kind} onChange={(e) => setKind(e.target.value as OriginableLoanKind)}>
          <option value="studentLoan">Student loan</option>
          <option value="creditCard">Credit card</option>
        </select>
      </label>
      <NumInput label="Amount" value={draft.amount} onChange={(amount) => patch({ amount })} prefix="$" step={1000} />
      <NumInput label="APR" value={draft.apr} onChange={(apr) => patch({ apr })} suffix="%" step={0.25} />
      {draft.kind !== "creditCard" && (
        <NumInput label="Term" value={draft.termYears} onChange={setTermYears} suffix="yr" min={1} />
      )}
      <button className="btn primary" onClick={submit}>
        Add event
      </button>
    </>
  );
}
