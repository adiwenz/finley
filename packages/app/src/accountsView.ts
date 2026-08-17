/**
 * The Accounts workspace's grouped ledger: what the household owns, then what it owes.
 *
 * Assets and debt are two groups with their own subtotals rather than one signed list, because
 * "you have $180k and you owe $310k" is two facts a reader checks separately — a single column
 * of mixed signs makes them do the sorting.
 *
 * Balances come off month 0 of the run, and the account names off the engine's own descriptors,
 * so nothing here hardcodes an account id or invents a label.
 */

import {
  liabilityKindLabel,
  type Household,
  type Projection,
  type ProjectionResult,
} from "@finley/engine";
import { formatDollars } from "./format";
import { abbreviateDollars } from "./homeView";
import type { IconName } from "./components/ds/icon";

export interface AccountRow {
  readonly id: string;
  readonly label: string;
  /** What kind of thing this is, in plain language — "Cash", "Retirement", "Mortgage". */
  readonly kind: string;
  readonly value: string;
  readonly icon: IconName;
  /** Bark for debt, leaf for assets. A category signal, not a verdict on the number. */
  readonly iconColor: string;
}

export interface AccountGroup {
  readonly title: string;
  /** The group's subtotal, abbreviated — a scanning figure, not one to reconcile against. */
  readonly total: string;
  readonly rows: readonly AccountRow[];
}

export interface AccountsView {
  readonly groups: readonly AccountGroup[];
  readonly netWorth: string;
  readonly assets: string;
  readonly debt: string;
}

/** The glyph per plan-account kind. Property and liabilities are handled separately below. */
const ACCOUNT_ICON: Record<string, { readonly icon: IconName; readonly kind: string }> = {
  cash: { icon: "wallet", kind: "Cash" },
  retirement: { icon: "piggy-bank", kind: "Retirement" },
  brokerage: { icon: "trending-up", kind: "Brokerage" },
  goal: { icon: "target", kind: "Goal fund" },
};

export function accountsView(
  projection: Projection,
  household: Household,
  result: ProjectionResult,
): AccountsView {
  const opening = result.series.opening;

  const assetRows: AccountRow[] = [];
  let assetsCents = 0;

  for (const descriptor of projection.accountDescriptors()) {
    const balance = opening.accountBalancesCents[descriptor.id] ?? 0;
    assetsCents += balance;
    // An empty account is noise in a list of what you have. It stays out until it holds
    // something — the surfaces that CREATE one say so themselves.
    if (balance === 0) continue;
    const style = ACCOUNT_ICON[descriptor.kind] ?? { icon: "wallet" as const, kind: "Account" };
    assetRows.push({
      id: descriptor.id,
      label: descriptor.label,
      kind: style.kind,
      value: formatDollars(balance),
      icon: style.icon,
      iconColor: "var(--leaf-700)",
    });
  }

  for (const [id, value] of Object.entries(opening.propertyValuesCents)) {
    assetsCents += value;
    assetRows.push({
      id,
      label: "Home",
      kind: "Property",
      value: formatDollars(value),
      icon: "home",
      iconColor: "var(--leaf-700)",
    });
  }

  const debtRows: AccountRow[] = [];
  let debtCents = 0;

  for (const liability of household.liabilities) {
    const balance = opening.liabilityBalancesCents[liability.id] ?? 0;
    if (balance === 0) continue;
    debtCents += balance;
    debtRows.push({
      id: liability.id,
      label: liabilityKindLabel(liability.kind),
      kind: "Owed",
      value: `−${formatDollars(balance)}`,
      icon: "landmark",
      iconColor: "var(--bark-600)",
    });
  }

  const groups: AccountGroup[] = [];
  if (assetRows.length > 0) {
    groups.push({ title: "Assets", total: abbreviateDollars(assetsCents), rows: assetRows });
  }
  if (debtRows.length > 0) {
    groups.push({ title: "Debt", total: abbreviateDollars(-debtCents), rows: debtRows });
  }

  return {
    groups,
    netWorth: abbreviateDollars(opening.netWorthRealCents ?? assetsCents - debtCents),
    assets: abbreviateDollars(assetsCents),
    debt: abbreviateDollars(debtCents),
  };
}
