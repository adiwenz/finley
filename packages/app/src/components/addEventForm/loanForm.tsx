/** A new liability is taken on — a LoanEvent. */

import { useRef, useState } from "react";
import { dollarsToCents, type LiabilityKind } from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { MonthSelect, type FormProps } from "./formControls";

/** Opening term for an amortizing loan (years) — the value the user edits from. */
const DEFAULT_TERM_YEARS = 5;

/**
 * The form's live state, a discriminated union on `kind` — mirroring the engine's
 * `LoanEvent`. A term (in years) applies to every amortizing loan; a credit card is
 * revolving and carries a credit limit instead, so its arm has NO term. Modeling it this
 * way keeps the in-progress form from ever holding a field that its kind doesn't have (a
 * credit card with a term, an auto loan with a limit) — the same illegal-state guard the
 * event it submits enjoys.
 */
type LoanCommon = { readonly month: number; readonly amount: number; readonly apr: number };
type LoanDraft =
  | (LoanCommon & { readonly kind: "creditCard" })
  | (LoanCommon & { readonly kind: Exclude<LiabilityKind, "creditCard">; readonly termYears: number });

export function LoanForm({ defaultMonth, nextId, horizonMonths, onAdd }: FormProps) {
  const [draft, setDraft] = useState<LoanDraft>(() => ({
    month: defaultMonth,
    kind: "auto",
    amount: 2000,
    apr: 6,
    termYears: DEFAULT_TERM_YEARS,
  }));

  // The last term the user had, remembered across a credit-card toggle: switching to a
  // credit card drops the term arm (the field disappears), and switching back restores
  // THIS value rather than snapping to the default. Not part of the draft — it's a UX
  // memory, not domain state — so the active arm's `termYears` stays the single truth.
  // (Mirrors `jobForm`'s open-ended `endAge` ref.)
  const lastTermYears = useRef(DEFAULT_TERM_YEARS);

  // Shared fields live on every arm, so a spread patch preserves whichever arm is active.
  const patch = (fields: Partial<LoanCommon>) => setDraft((d) => ({ ...d, ...fields }));

  // Switching kind can't flip a flag — the arms carry different fields, so rebuild the arm
  // with a valid value for its own field, preserving the shared amount/apr/month.
  function setKind(kind: LiabilityKind) {
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
    // LoanEvent is discriminated on `kind`, so each arm carries only its own
    // kind-determined field — no `undefined` placeholder for the other's.
    const common = {
      id: `e${nextId}`,
      type: "LoanEvent",
      month: draft.month,
      liabilityId: `loan-${nextId}`,
      ownerId: "p1",
      openingBalanceCents: dollarsToCents(draft.amount),
      apr: draft.apr / 100,
    } as const;
    onAdd(
      draft.kind === "creditCard"
        ? { ...common, kind: draft.kind, creditLimitCents: dollarsToCents(draft.amount * 2) }
        : { ...common, kind: draft.kind, termMonths: draft.termYears * 12 },
    );
  }

  return (
    <>
      <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      <label className="field">
        <span className="field-label">Type</span>
        <select value={draft.kind} onChange={(e) => setKind(e.target.value as LiabilityKind)}>
          <option value="auto">Auto loan</option>
          <option value="studentLoan">Student loan</option>
          <option value="mortgage">Mortgage</option>
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
