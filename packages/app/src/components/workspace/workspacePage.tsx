/**
 * The frame every workspace shares: back link, title block, one optional action, tabs, summary
 * tiles, then content.
 *
 * Uniform on purpose — Jobs, Spending, Accounts and Settings differ in what they hold, not in how
 * they are entered or left, so the reader learns the shape once. The single action slot enforces
 * the system's "one green CTA per view" rule structurally: there is nowhere to put a second.
 */

import type { ReactNode } from "react";
import { Button, Icon, SummaryTile, Tabs, type Tab, type SummaryTileProps } from "../ds";

export interface WorkspacePageProps<T extends string> {
  readonly title: string;
  readonly sub: string;
  readonly onBack: () => void;
  readonly narrow: boolean;
  readonly action?: { readonly label: string; readonly onClick: () => void };
  readonly tabs?: { readonly items: readonly Tab<T>[]; readonly value: T; readonly onChange: (v: T) => void };
  readonly summary?: readonly SummaryTileProps[];
  readonly children: ReactNode;
}

export function WorkspacePage<T extends string>({
  title,
  sub,
  onBack,
  narrow,
  action,
  tabs,
  summary,
  children,
}: WorkspacePageProps<T>) {
  return (
    <main
      className={[
        "min-w-0 flex-1 bg-surface-page",
        narrow ? "px-4.5 pt-5 pb-12" : "overflow-y-auto px-10 pt-6 pb-16",
      ].join(" ")}
    >
      <div className="mx-auto max-w-[1180px]">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-link"
        >
          <Icon name="arrow-left" size={15} />
          Back to plan
        </button>

        <div className="mt-3 mb-5.5 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-display text-[34px] font-bold tracking-[-0.025em] text-leaf-900">
              {title}
            </h1>
            <p className="mt-1.5 max-w-[640px] text-[15.5px] text-ink-600">{sub}</p>
          </div>
          {action ? (
            <Button variant="primary" size="md" iconLeft="plus" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
        </div>

        {tabs ? (
          <div className="mb-5.5">
            <Tabs tabs={tabs.items} value={tabs.value} onChange={tabs.onChange} label={title} />
          </div>
        ) : null}

        {summary && summary.length > 0 ? (
          <div className="mb-5 flex flex-wrap gap-3.5">
            {summary.map((tile) => (
              <SummaryTile key={tile.label} {...tile} />
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-5">{children}</div>
      </div>
    </main>
  );
}
