import { describe, it, expect } from "vitest";
import { emptyLedger } from "./ledger";
import { replayLedger } from "../projection/buildHouseholdInput";
import { interpretLedger } from "./interpret";
import type { LedgerBaseConfig } from "./ledgerBase";
import { dollarsToCents } from "../money/cashFlowSeries";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit, makeLiquidAccount, baseConfig, add } from "./events.testSupport";
import { ZERO_PARTNER_ACCOUNTS } from "./eventTypes";
import { freshProjection } from "../testing/projectionFacadeFixtures";
import { partnerAccountId } from "../compile/projectionBase";
import type { PersonId } from "../job/job";

describe("RelationshipEvent — partner accounts", () => {
  const cfg: LedgerBaseConfig = { ...baseConfig, initialAccounts: [makeLiquidAccount()] };

  it("a partner's authored balance lands at the join month, not month 0", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 3,
      person: personLit("p2", "Bob"),
      accounts: {
        ...ZERO_PARTNER_ACCOUNTS,
        savingsBalanceCents: dollarsToCents(10_000),
      },
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    expect(series.months[2].netWorthNominalCents).toBe(0);
    expect(series.months[3].netWorthNominalCents).toBe(dollarsToCents(10_000));
  });

  it("a partner with no accounts field contributes nothing (existing fixtures unchanged)", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    expect(series.months[11].netWorthNominalCents).toBe(0);
  });

  it("a departing partner's individually-owned account stops counting toward net worth", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
      accounts: { ...ZERO_PARTNER_ACCOUNTS, savingsBalanceCents: dollarsToCents(10_000) },
    });
    ledger = add(ledger, {
      id: "sep1",
      type: "SeparationEvent",
      month: 6,
      partnerPersonId: "p2",
      alimonyMonthlyCents: 0,
      alimonyDurationMonths: 0,
      childSupportMonthlyCents: 0,
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    expect(series.months[5].netWorthNominalCents).toBe(dollarsToCents(10_000));
    expect(series.months[6].netWorthNominalCents).toBe(0);
  });

  it("reports net worth broken out by owner", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
      accounts: { ...ZERO_PARTNER_ACCOUNTS, savingsBalanceCents: dollarsToCents(5_000) },
    });
    const series = replayLedger(ledger, cfg, nullJurisdiction);
    const month0 = series.months[0];
    expect(month0.netWorthByPersonCents?.["p1"]).toBe(0);
    expect(month0.netWorthByPersonCents?.["p2"]).toBe(dollarsToCents(5_000));
  });

  it("partner accounts appear in the interpreted household, owned by the partner", () => {
    let ledger = emptyLedger;
    ledger = add(ledger, {
      id: "r1",
      type: "RelationshipEvent",
      month: 0,
      person: personLit("p2", "Bob"),
      accounts: { ...ZERO_PARTNER_ACCOUNTS, retirementBalanceCents: dollarsToCents(1_000) },
    });
    const household = interpretLedger(ledger, cfg);
    const partnerAccounts = household.accounts.filter((a) => a.owners.includes("p2"));
    expect(partnerAccounts).toHaveLength(3);
    expect(partnerAccounts.every((a) => a.owners.length === 1)).toBe(true);
  });
});

describe("marry() — authoring a partner's accounts", () => {
  it("defaults an unstated balance to 0 and an unstated return rate to the primary's own", () => {
    const p = freshProjection();
    const partnerId = p.marry({
      month: 12,
      name: "Partner",
      birthYear: 1988,
      lifeExpectancy: p.state.scenario.plan.primary.lifeExpectancy,
      accounts: { savingsBalanceCents: dollarsToCents(2_000) },
    });
    const event = p.state.scenario.ledger.events[0];
    if (event?.type !== "RelationshipEvent") throw new Error("expected a RelationshipEvent");
    expect(event.accounts).toEqual({
      savingsBalanceCents: dollarsToCents(2_000),
      savingsReturnPct: p.state.scenario.plan.savingsReturnPct,
      retirementBalanceCents: 0,
      retirementReturnPct: p.state.scenario.plan.retirementReturnPct,
      brokerageBalanceCents: 0,
      brokerageReturnPct: p.state.scenario.plan.brokerageReturnPct,
    });

    // Month 12 also compounds that same month's return, so it lands at or above the deposit
    // (the exact post-growth figure is pinned by `simAccount.test.ts`, not re-derived here).
    const savingsId = partnerAccountId("savings", partnerId as PersonId);
    const result = p.run(nullJurisdiction);
    expect(result.series.months[11].accountBalancesCents[savingsId]).toBe(0);
    expect(result.series.months[12].accountBalancesCents[savingsId]).toBeGreaterThanOrEqual(
      dollarsToCents(2_000),
    );
  });
});
