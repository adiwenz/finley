/**
 * Jobs over time, as bars on one calendar.
 *
 * Scrolls horizontally under a 680px floor rather than compressing: past a point the bars stop
 * being comparable and the chart stops answering the question it exists for.
 *
 * The bar carries its own name and pay inside it, so reading one job needs no legend. When a bar
 * is too short to hold both, the name ellipsises and the pay is what survives — a job you can't
 * name but can price is more use than the reverse on a chart about earning.
 */

import type { JobsGanttView } from "../../jobsGanttView";

export interface JobsGanttProps {
  readonly view: JobsGanttView;
}

export function JobsGantt({ view }: JobsGanttProps) {
  if (view.groups.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <div className="relative min-w-[680px] pt-2.5">
        <div className="flex justify-between border-b border-border-subtle pb-1.5">
          {view.ticks.map((tick) => (
            <span key={tick} className="font-mono text-[12px] text-ink-400">
              {tick}
            </span>
          ))}
        </div>

        <div
          className="absolute top-8 bottom-0 w-[1.5px] bg-leaf-700 opacity-55"
          style={{ left: view.todayPct }}
        />
        <div
          className="absolute -top-2 -translate-x-1/2 bg-surface-card px-1.5 text-[10.5px] font-semibold tracking-[var(--tracking-caps)] text-leaf-700 uppercase"
          style={{ left: view.todayPct }}
        >
          Today
        </div>

        <div className="pt-3.5">
          {view.groups.map((group) => (
            <div key={group.personId}>
              {view.named ? (
                <div className="eyebrow pt-3.5 pb-0.5 text-ink-400">{group.label}</div>
              ) : null}
              {group.bars.map((bar) => (
                <div key={bar.id} className="relative h-[46px] rounded-md">
                  <div
                    className="absolute top-2 flex h-[30px] min-w-16 items-center gap-2 overflow-hidden rounded-pill px-3"
                    style={{ left: bar.left, width: bar.width, background: bar.color }}
                  >
                    <span className="truncate text-[13px] font-semibold text-cream-50">
                      {bar.name}
                    </span>
                    <span className="font-mono text-[12px] whitespace-nowrap text-leaf-100">
                      {bar.pay}
                    </span>
                  </div>
                  <div
                    className="absolute top-[38px] font-mono text-[11.5px] whitespace-nowrap text-ink-400"
                    style={{ left: bar.left }}
                  >
                    {bar.range}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
