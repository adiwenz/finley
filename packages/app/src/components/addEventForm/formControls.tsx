/** Shared controls and props for the per-event authoring forms. */

import type { NewLifeEvent } from "@finley/engine";
import { monthLabel } from "../../format";

/** Props every event form receives from {@link AddEventForm}. */
export interface FormProps {
  defaultMonth: number;
  nextId: number;
  /** The plan's horizon in months (to life expectancy) — bounds the year picker. */
  horizonMonths: number;
  onAdd: (event: NewLifeEvent) => void;
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
