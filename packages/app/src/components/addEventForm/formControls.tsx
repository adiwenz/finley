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
}

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
