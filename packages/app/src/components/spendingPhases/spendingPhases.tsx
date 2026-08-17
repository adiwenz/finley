/**
 * The spending phase strip: what the household spends now, and at each of the next changes.
 *
 * Sunken cream blocks rather than white cards — these sit inside a section, and the system keeps
 * white for the card layer. Each block leads with WHEN, because the reader scans the strip for a
 * moment in their life before they read the figure attached to it.
 */

import type { SpendingPhase } from "../../spendingView";

export interface SpendingPhasesProps {
  readonly phases: readonly SpendingPhase[];
}

export function SpendingPhases({ phases }: SpendingPhasesProps) {
  if (phases.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-3.5">
      {phases.map((phase) => (
        <div
          key={`${phase.when}-${phase.why}`}
          className="min-w-[200px] flex-1 rounded-card bg-surface-sunken px-4.5 py-4"
        >
          <div className="text-[13px] text-ink-600">{phase.when}</div>
          <div className="mt-1 mb-0.5 font-mono text-[22px] text-leaf-900">{phase.value}</div>
          <div className="text-[13px] text-muted">{phase.why}</div>
        </div>
      ))}
    </div>
  );
}
