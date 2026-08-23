/**
 * Every account the household holds, charted over the plan — the primary's and each partner's
 * side by side.
 *
 * These used to sit in the sidebar beside the Budget's opening-balance fields, one per standing
 * account KIND. That could only ever show three charts, and it found each by kind, so a partner's
 * cash account was unreachable: the primary's was always the first of its kind. A household with
 * two earners could not watch the partner's balances move at all. Full width, one chart per
 * account, is what makes the comparison the accounts exist for possible.
 */

import { AccountBalanceChart } from "./accountBalanceChart";
import { buildAccountBalanceData } from "./accountBalanceSeries";
import type { PlanAccountDescriptor, ProjectionSeries } from "@finley/engine";

export interface AccountBalancesPanelProps {
  /** Every account, the primary's and the ledger's alike — the order they chart in. */
  readonly accounts: readonly PlanAccountDescriptor[];
  readonly series: ProjectionSeries;
  readonly horizonMonths: number;
  /** Names the owner caption reads. A household of one gets no caption at all. */
  readonly personNames: ReadonlyMap<string, string>;
}

export function AccountBalancesPanel({
  accounts,
  series,
  horizonMonths,
  personNames,
}: AccountBalancesPanelProps) {
  const showOwners = personNames.size > 1;
  const charts = accounts
    .map((descriptor) => ({
      descriptor,
      data: buildAccountBalanceData(series, descriptor.id, horizonMonths),
    }))
    // An account that is flat zero for the whole plan charts nothing worth looking at — the same
    // drop-if-always-zero rule the net-worth breakdown applies to its bands.
    .filter(({ data }) => data.points.some((p) => p.balanceCents !== 0));

  if (charts.length === 0) return null;

  return (
    <>
      <h3>Accounts over time</h3>
      <div className="account-chart-grid">
        {charts.map(({ descriptor, data }) => (
          <AccountBalanceChart
            key={descriptor.id}
            label={descriptor.label}
            ownerLabel={showOwners ? (personNames.get(descriptor.ownerId) ?? null) : null}
            data={data}
          />
        ))}
      </div>
    </>
  );
}
