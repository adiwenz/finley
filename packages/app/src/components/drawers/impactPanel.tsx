/**
 * The "Impact on your plan" block at the foot of an event editor.
 *
 * A sunken cream panel rather than a card: it belongs to the editor above it, and giving it its
 * own white surface would read as a separate thing the reader has to deal with.
 */

import { impactToneColor, type ImpactView } from "../../impactView";

export interface ImpactPanelProps {
  readonly view: ImpactView;
}

export function ImpactPanel({ view }: ImpactPanelProps) {
  return (
    <div className="rounded-card bg-surface-sunken px-4.5 py-4">
      <div className="eyebrow mb-2.5">Impact on your plan</div>
      {view.rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-3 py-1">
          <span className="text-[14px] text-ink-700">{row.label}</span>
          <span className="font-mono text-[15px]" style={{ color: impactToneColor(row.tone) }}>
            {row.value}
          </span>
        </div>
      ))}
      <p className="mt-2 text-[13px] leading-normal text-ink-600">{view.note}</p>
    </div>
  );
}
