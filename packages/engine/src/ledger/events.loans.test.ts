import { describe, it, expect } from "vitest";
import { emptyLedger } from "./ledger";
import { replayLedger } from "../projection/buildHouseholdInput";
import { snapshotAt } from "../projection/snapshot";
import type { LedgerBaseConfig } from "./ledgerBase";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { makeLiquidAccount, baseConfig, add } from "./events.testSupport";
import { addEvent } from "./addEvent";
import { HOUSEHOLD_OWNER_ID } from "../compile/projectionBase";


// LoanEvent + DebtPayoffEvent

describe("LoanEvent + DebtPayoffEvent", () => {
  it("LoanEvent adds a liability that reduces net worth at month 0", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 60,
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // $20k assets − $10k loan = $10k net worth at month 0
    expect(series.months[0].netWorthNominalCents).toBe(dollarsToCents(10_000));
  });

  it("a LoanEvent at month M originates the liability at M, not at month 0", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      horizonMonths: 24,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 12,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 60,
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);

    // Balance (a stock) is 0 until the loan originates, then the opening balance.
    expect(series.months[11].liabilityBalancesCents["car"]).toBe(0);
    expect(series.months[12].liabilityBalancesCents["car"]).toBe(dollarsToCents(10_000));
    // Net worth only carries the loan from month 12 onward.
    expect(series.months[11].netWorthNominalCents).toBe(dollarsToCents(20_000));
    expect(series.months[12].netWorthNominalCents).toBe(dollarsToCents(10_000));

    // Snapshot presence and projected balance agree about when it starts.
    expect(snapshotAt(ledger, 11).liabilities).toHaveLength(0);
    expect(snapshotAt(ledger, 12).liabilities.map((l) => l.id)).toEqual(["car"]);
  });

  it("DebtPayoffEvent reduces liability balance and account balance", () => {
    const cfg: LedgerBaseConfig = {
      ...baseConfig,
      initialAccounts: [makeLiquidAccount("checking", dollarsToCents(20_000))],
    };
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "loan1",
      type: "LoanEvent",
      month: 0,
      liabilityId: "car",
      ownerId: "p1",
      kind: "auto",
      openingBalanceCents: dollarsToCents(10_000),
      apr: 0,
      termMonths: 120,
    });
    // Lump-sum payoff at month 6: $5000
    ledger = add(ledger, {
      id: "payoff1",
      type: "DebtPayoffEvent",
      month: 6,
      liabilityId: "car",
      accountId: "checking",
      amountCents: dollarsToCents(5_000),
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    // Net worth is conserved (cash out = debt reduced): $10k every month at 0% APR with no
    // income/expense, since scheduled payments also zero the gap.
    expect(series.months[6].liabilityBalancesCents["car"]).toBeLessThan(
      dollarsToCents(10_000),
    );
  });
});

/**
 * A debt the household carries jointly, rather than one partner's own. `HOUSEHOLD_OWNER_ID` is
 * deliberately not on the roster — it earns nothing and holds no take-home — so it has to be
 * admitted by the owner gate explicitly, and it routes to the SHARED obligation bucket, where
 * the household's contribution scheme splits it between partners.
 */
describe("LoanEvent — owned by the household rather than by a person", () => {
  const cfg: LedgerBaseConfig = {
    ...baseConfig,
    initialAccounts: [makeLiquidAccount("checking", dollarsToCents(60_000))],
  };
  const householdLoan = {
    id: "loan1",
    type: "LoanEvent" as const,
    month: 0,
    liabilityId: "shared-car",
    ownerId: HOUSEHOLD_OWNER_ID,
    kind: "auto" as const,
    openingBalanceCents: dollarsToCents(12_000),
    apr: 0,
    termMonths: 12,
  };

  it("authors and simulates, though the household is on nobody's person roster", () => {
    const series = replayLedger(add(emptyLedger, householdLoan), cfg, nullJurisdiction);
    // Paid down like any other debt — being nobody's in particular does not make it unpayable.
    expect(series.months[1]!.liabilityBalancesCents["shared-car"]).toBe(dollarsToCents(11_000));
  });

  it("still refuses an owner that is neither a member nor the household", () => {
    const result = addEvent(emptyLedger, cfg, { ...householdLoan, ownerId: "nobody" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toContain(`owner "nobody" not found`);
  });

});

