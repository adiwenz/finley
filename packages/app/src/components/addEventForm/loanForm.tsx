/** A new liability is taken on — a LoanEvent. */

import { useRef, useState } from "react";
import {
  dollarsToCents,
  isPreExisting,
  liabilityKindLabel,
  PRIMARY_PERSON_ID,
  type LiabilityKind,
  type OriginableLoanKind,
} from "@finley/engine";
import { NumInput } from "../numInput/numInput";
import { HoldingWhen, MonthSelect, type EditProps, type EventOf, type FormProps } from "./formControls";

const DEFAULT_TERM_YEARS = 5;

/**
 * The form's live state, mirroring the engine's `LoanEvent`. A credit card is revolving and
 * carries a credit limit instead of a term, so its arm has NO term — the union gives the
 * in-progress form the same illegal-state guard the submitted event has. The term arm spans
 * every non-card {@link LiabilityKind}, not just the originable ones: adding a loan offers only
 * `studentLoan`, but *editing* reaches a mortgage or auto loan minted elsewhere (a home
 * purchase's financing), whose rate and term are revised through this same form.
 */
type LoanCommon = { readonly month: number; readonly amount: number; readonly apr: number };
type LoanDraft =
  | (LoanCommon & { readonly kind: "creditCard" })
  | (LoanCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termYears: number;
    });

/** Seed a draft from the loan being edited, in the dollar/percent/year units the fields speak. */
function draftFromEvent(event: EventOf<"LoanEvent">): LoanDraft {
  const common = { month: event.month, amount: event.openingBalanceCents / 100, apr: event.apr * 100 };
  return event.kind === "creditCard"
    ? { ...common, kind: "creditCard" }
    : { ...common, kind: event.kind, termYears: event.termMonths / 12 };
}

export function LoanForm({
  defaultMonth,
  horizonMonths,
  onAdd,
  edit,
}: FormProps & { edit?: EditProps<EventOf<"LoanEvent">> }) {
  const [draft, setDraft] = useState<LoanDraft>(() =>
    edit
      ? draftFromEvent(edit.event)
      : { month: defaultMonth, kind: "studentLoan", amount: 2000, apr: 6, termYears: DEFAULT_TERM_YEARS },
  );

  // Switching to a credit card drops the term arm; switching back restores the last term
  // entered rather than the default. UX memory, not domain state, so it stays out of the draft
  // and the active arm's `termYears` remains the single truth. (Mirrors `jobForm`'s `endAge`.)
  const lastTermYears = useRef(DEFAULT_TERM_YEARS);

  // Shared fields live on every arm, so a spread patch preserves whichever arm is active.
  const patch = (fields: Partial<LoanCommon>) => setDraft((d) => ({ ...d, ...fields }));

  /**
   * A holding — a debt already carried when the plan starts, or the mortgage under a home that
   * was. Its month is the now marker and nothing else is legal, so the date is stated rather
   * than picked, and its figures are today's: the balance and the term still to run, which is
   * how the Starting position form asked for them.
   */
  const holding = edit !== undefined && isPreExisting(edit.event.month);

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
    // A revision keeps the loan's `kind` (and its id/owner) fixed, so it names only the
    // amount, rate, month, and the one kind-determined field. The wrong-arm field for the kind
    // is left off, which is exactly what the engine's revision guard requires.
    if (edit) {
      const common = { month: draft.month, openingBalanceCents: dollarsToCents(draft.amount), apr: draft.apr / 100 } as const;
      edit.onRevise((p) =>
        p.reviseTransaction(
          edit.event.id,
          draft.kind === "creditCard"
            ? { type: "takeLoan", ...common, creditLimitCents: dollarsToCents(draft.amount * 2) }
            : { type: "takeLoan", ...common, termMonths: draft.termYears * 12 },
        ),
      );
      return;
    }
    const common = {
      month: draft.month,
      ownerId: PRIMARY_PERSON_ID,
      openingBalanceCents: dollarsToCents(draft.amount),
      apr: draft.apr / 100,
    } as const;
    // The kind literals are named directly, not read off the draft: the add picker offers only
    // these two, so authoring never reaches the mortgage/auto kinds the widened draft admits for
    // editing — and `takeLoan` accepts only these originable kinds.
    onAdd((p) =>
      p.takeLoan(
        draft.kind === "creditCard"
          ? { ...common, kind: "creditCard", creditLimitCents: dollarsToCents(draft.amount * 2) }
          : { ...common, kind: "studentLoan", termMonths: draft.termYears * 12 },
      ),
    );
  }

  return (
    <>
      {holding ? (
        <HoldingWhen />
      ) : (
        <MonthSelect value={draft.month} horizonMonths={horizonMonths} onChange={(month) => patch({ month })} />
      )}
      {/* Kind is fixed on a revision — a card and a term loan are different instruments — so an
          edit names it read-only rather than offering the picker. */}
      {edit ? (
        <div className="field">
          <span className="field-label">Type</span>
          <span>{liabilityKindLabel(draft.kind)}</span>
        </div>
      ) : (
        <label className="field">
          <span className="field-label">Type</span>
          <select value={draft.kind} onChange={(e) => setKind(e.target.value as OriginableLoanKind)}>
            <option value="studentLoan">Student loan</option>
            <option value="creditCard">Credit card</option>
          </select>
        </label>
      )}
      {/* A holding opens at what it is worth NOW, so its two figures are named as today's —
          the same words the Starting position form used to collect them. */}
      <NumInput
        label={holding ? "Balance today" : "Amount"}
        value={draft.amount}
        onChange={(amount) => patch({ amount })}
        prefix="$"
        step={1000}
      />
      <NumInput label="APR" value={draft.apr} onChange={(apr) => patch({ apr })} suffix="%" step={0.25} />
      {draft.kind !== "creditCard" && (
        <NumInput
          label={holding ? "Term remaining" : "Term"}
          value={draft.termYears}
          onChange={setTermYears}
          suffix="yr"
          min={1}
        />
      )}
      <button className="btn primary" onClick={submit}>
        {edit ? "Save changes" : "Add event"}
      </button>
    </>
  );
}
