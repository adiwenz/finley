/** Shared controls and props for the per-event authoring forms (§10.5). */

import type { NewLifeEvent, Person } from "@finley/engine";
import { HORIZON_MONTHS } from "../../config";
import { monthLabel } from "../../format";

/** Props every event form receives from {@link AddEventForm}. */
export interface FormProps {
  defaultMonth: number;
  nextId: number;
  onAdd: (event: NewLifeEvent) => void;
}

/** Start-of-year months across the horizon: [0, 12, 24, …]. Constant — hoisted. */
const YEAR_START_MONTHS = Array.from(
  { length: HORIZON_MONTHS / 12 },
  (_, y) => y * 12,
);

/** The "When" year picker, shared by every event form. */
export function MonthSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (month: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">When</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {YEAR_START_MONTHS.map((m) => (
          <option key={m} value={m}>
            {monthLabel(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The "Whose" owner picker, shared by the income and expense forms. */
export function OwnerSelect({
  owners,
  value,
  onChange,
}: {
  owners: readonly Person[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">Whose</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {owners.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
