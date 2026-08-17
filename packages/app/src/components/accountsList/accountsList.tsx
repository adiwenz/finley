/**
 * The grouped account ledger: an eyebrow-cased group header carrying its subtotal, then one row
 * per account with its icon chip, kind, and balance.
 *
 * Rows are hairline-separated rather than carded, because the list is read as a column of
 * comparable figures — a card each would put a border between every number and slow the scan.
 */

import type { AccountsView } from "../../accountsView";
import { EmptyState, IconChip } from "../ds";

export interface AccountsListProps {
  readonly view: AccountsView;
}

export function AccountsList({ view }: AccountsListProps) {
  if (view.groups.length === 0) {
    return (
      <EmptyState
        title="Add what you have today"
        body="Savings, investments, property, and debt all contribute to your financial picture."
      />
    );
  }

  return (
    <div>
      {view.groups.map((group) => (
        <div key={group.title}>
          <div className="flex items-baseline justify-between border-b border-border-subtle px-0.5 pt-4 pb-1.5">
            <span className="eyebrow text-ink-400">{group.title}</span>
            <span className="font-mono text-[13px] text-ink-400">{group.total}</span>
          </div>
          {group.rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-3.5 border-b border-border-subtle px-2 py-3"
            >
              <IconChip
                name={row.icon}
                size={32}
                color={row.iconColor}
                background="var(--cream-100)"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink-900">{row.label}</span>
                <span className="block text-[13px] text-muted">{row.kind}</span>
              </span>
              <span
                className={[
                  "w-[130px] text-right font-mono text-[15px]",
                  row.iconColor === "var(--bark-600)" ? "text-bark-600" : "text-ink-900",
                ].join(" ")}
              >
                {row.value}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
