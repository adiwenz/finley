/**
 * Every account the household holds, charted over the plan and grouped by whose it is.
 *
 * These used to sit in the sidebar beside the Budget's opening-balance fields, one per standing
 * account KIND. That could only ever show three charts, and it found each by kind, so a partner's
 * cash account was unreachable: the primary's was always the first of its kind. A household with
 * two earners could not watch the partner's balances move at all.
 *
 * Every account is drawn, including one flat at zero for the whole plan — an empty retirement
 * account is a fact about the household worth seeing, and a person whose three charts became two
 * would read as though they held something the others do not.
 */

import { AccountBalanceChart } from "./accountBalanceChart";
import { buildAccountBalanceData } from "./accountBalanceSeries";
import type { PlanAccountDescriptor, ProjectionSeries } from "@finley/engine";

export interface AccountBalancesPanelProps {
  /** Every account, the primary's and the ledger's alike. */
  readonly accounts: readonly PlanAccountDescriptor[];
  readonly series: ProjectionSeries;
  readonly horizonMonths: number;
  /** Person name by id, in household order — the order the groups appear in. */
  readonly personNames: ReadonlyMap<string, string>;
}

/**
 * A partner's account label is minted with their name ("Blake — Cash savings"); the primary's
 * never is. Under a heading that already says whose these are, that prefix only repeats it.
 */
function withoutOwnerPrefix(label: string, ownerName: string | undefined): string {
  const prefix = `${ownerName} — `;
  return ownerName !== undefined && label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

export function AccountBalancesPanel({
  accounts,
  series,
  horizonMonths,
  personNames,
}: AccountBalancesPanelProps) {
  if (accounts.length === 0) return null;
  const showOwners = personNames.size > 1;

  // Grouped by owner, people first in household order, so each person's three standing accounts
  // read together. An account whose owner is not a named member (none today) still gets drawn,
  // in a trailing group of its own rather than silently dropped.
  const owners = [
    ...[...personNames.keys()].filter((id) => accounts.some((a) => a.ownerId === id)),
    ...[...new Set(accounts.map((a) => a.ownerId))].filter((id) => !personNames.has(id)),
  ];

  return (
    <>
      <h3>Accounts over time</h3>
      {owners.map((ownerId) => {
        const ownerName = personNames.get(ownerId);
        return (
          <section key={ownerId} className="account-owner-group">
            {showOwners && <h4>{ownerName ?? ownerId}</h4>}
            {accounts
              .filter((a) => a.ownerId === ownerId)
              .map((descriptor) => (
                <figure key={descriptor.id} className="account-chart">
                  <figcaption>{withoutOwnerPrefix(descriptor.label, ownerName)}</figcaption>
                  <AccountBalanceChart
                    label={descriptor.label}
                    ownerLabel={showOwners ? (ownerName ?? null) : null}
                    data={buildAccountBalanceData(series, descriptor.id, horizonMonths)}
                  />
                </figure>
              ))}
          </section>
        );
      })}
    </>
  );
}
