/**
 * The body of a read-only summary drawer: one big total, then what it is made of.
 *
 * The total is mono and very large because it is the answer the reader opened the drawer for;
 * the rows beneath it are the working. Group rows are eyebrow-cased subtotals, so a reader
 * scanning down can tell a component from a sum without reading the numbers.
 */

import type { SummaryDrawerView } from "../../summaryView";
import { Button } from "../ds";

export interface SummaryBodyProps {
  readonly view: SummaryDrawerView;
  readonly onFollowCta: () => void;
}

export function SummaryBody({ view, onFollowCta }: SummaryBodyProps) {
  return (
    <>
      <div>
        <div className="eyebrow">{view.eyebrow}</div>
        <div className="mt-1.5 font-mono text-[38px] font-medium tracking-[-0.03em] text-leaf-900">
          {view.total}
        </div>
        <div className="text-[13.5px] text-muted">{view.totalSub}</div>
      </div>

      <div className="flex flex-col gap-0.5">
        {view.rows.map((row) =>
          row.isGroup ? (
            <div
              key={row.id}
              className="flex items-baseline justify-between gap-2.5 border-b border-border-subtle px-2.5 py-2.5"
            >
              <span className="eyebrow text-ink-400">{row.label}</span>
              <span className="font-mono text-[13px] text-ink-400">{row.value}</span>
            </div>
          ) : (
            <div
              key={row.id}
              className="flex items-center gap-2.5 border-b border-border-subtle px-2.5 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-semibold text-ink-900">{row.label}</span>
                {row.sub ? (
                  <span className="block text-[12.5px] text-muted">{row.sub}</span>
                ) : null}
              </span>
              <span
                className={[
                  "font-mono text-[15px]",
                  row.tone === "debt" ? "text-bark-600" : "text-ink-900",
                ].join(" ")}
              >
                {row.value}
              </span>
            </div>
          ),
        )}
      </div>

      <div className="border-t border-border-subtle pt-4">
        <Button
          variant="secondary"
          size="md"
          fullWidth
          iconRight="arrow-right"
          onClick={onFollowCta}
        >
          {view.cta.label}
        </Button>
      </div>
    </>
  );
}
