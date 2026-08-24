/** Shared controls and props for the per-event authoring forms. */

import type { LifeEvent, Projection } from "@finley/engine";
import { monthLabel } from "../../format";

/** Props every event form receives from {@link AddEventForm}. */
export interface FormProps {
  defaultMonth: number;
  /** The plan's horizon in months (to life expectancy) — bounds the year picker. */
  horizonMonths: number;
  /**
   * Run one transaction against a momentary {@link Projection}. The facade mints every id, so
   * a form describes the event in the caller's terms and never invents an id of its own.
   */
  onAdd: (write: (projection: Projection) => void) => void;
}

/** The single `LifeEvent` variant a given form authors and edits — e.g. `EventOf<"ChildEvent">`. */
export type EventOf<T extends LifeEvent["type"]> = Extract<LifeEvent, { type: T }>;

/**
 * A form in edit mode: the event whose data seeds the draft, and the sink that commits the
 * revision. Passing this to a form flips it from authoring a new event to revising `event` in
 * place through `Projection.reviseTransaction` — its id, type, and everything the form doesn't
 * show (a partner's jobs, a mortgage) are kept by the engine. Absent means add mode.
 *
 * `onRevise` never reports the outcome: the surrounding surface closes on success and, on a
 * refusal, leaves the form open with the conflict shown — so a form never inspects the result.
 */
export interface EditProps<E extends LifeEvent> {
  readonly event: E;
  readonly onRevise: (write: (projection: Projection) => void) => void;
  /**
   * Why that same revision would be refused, or `null` when it would be taken — asked before the
   * click rather than after it, so Save can be disabled with the reason beside it instead of
   * doing nothing visible. The pattern the timeline's blocked Remove already uses.
   *
   * Optional, and a form that does not ask keeps the old behaviour: the refusal still arrives
   * from {@link onRevise}, as a banner elsewhere on the page.
   */
  readonly conflictOf?: (write: (projection: Projection) => void) => string | null;
}

/**
 * "When" for a HOLDING — a loan or a home the household already has. Its month is the now
 * marker, not an author's choice (the engine refuses a holding at any other pre-now month), so
 * an edit states the date rather than offering a picker that cannot represent it.
 *
 * An ANCHOR — a partnering or a birth already behind us — is the other pre-now shape and does
 * NOT use this: its month is authored, just in elapsed terms ("together for", "age today"),
 * which is what {@link elapsedYears}/{@link monthOfElapsedYears} convert.
 */
export function HoldingWhen() {
  return (
    <div className="field">
      <span className="field-label">When</span>
      <span>Already true on day one</span>
    </div>
  );
}

/**
 * An anchor's past month as the elapsed term its authoring form collects, and back again — how
 * long ago it happened, in whole years. The Starting position forms ask for exactly this ("Together
 * for", "Age today"), so an edit that reuses their vocabulary reuses their arithmetic.
 */
export const elapsedYears = (month: number): number => Math.round(-month / 12);
export const monthOfElapsedYears = (years: number): number => -years * 12;

/** The "When" year picker, shared by every event form. Spans the plan's horizon. */
export function MonthSelect({
  value,
  horizonMonths,
  onChange,
}: {
  value: number;
  horizonMonths: number;
  onChange: (month: number) => void;
}) {
  // Start-of-year months across the horizon: [0, 12, 24, …] up to life expectancy.
  const yearStartMonths = Array.from(
    { length: Math.floor(horizonMonths / 12) },
    (_, y) => y * 12,
  );
  return (
    <label className="field">
      <span className="field-label">When</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {yearStartMonths.map((m) => (
          <option key={m} value={m}>
            {monthLabel(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Who a debt or holding belongs to — always exactly one person. A debt is not co-owned here even
 * when both partners benefit from it: ownership is what decides who funds it first and what
 * happens to it at separation, and a jointly-owned liability has no answer to the second
 * question that the engine could act on (there is no half-loan to divide).
 *
 * Hidden entirely for a one-person household: with a single member and no partner to distinguish
 * them from, "whose is it" is not a question worth asking, and the answer is the primary either
 * way. Mirrors the Jobs panel's owner select, which hides itself on the same rule.
 */
export function OwnerPicker({
  label = "Whose is it?",
  people,
  value,
  onChange,
}: {
  label?: string;
  people: readonly { readonly id: string; readonly name: string }[];
  value: string;
  onChange: (ownerId: string) => void;
}) {
  if (people.length < 2) return null;
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

