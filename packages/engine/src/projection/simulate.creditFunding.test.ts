/**
 * Credit as an authored funding source, through the whole simulator. An explicitly-funded expense
 * may name a credit card among its ordered sources; the draw borrows against the card's headroom in
 * the user's stated order, INCREASING the card's liability rather than selling an asset or minting
 * cash. The engine never adds a card the user did not name — an explicit spend whose named sources
 * fall short blocks, it does not silently borrow.
 *
 * Seam: `simulateHousehold`'s public month series — `liabilityBalancesCents`, `accountBalancesCents`,
 * `netWorthNominalCents`, `resolvedFunding`, and `status`. `computeLiabilityPayments` runs before the
 * draw and off the card's start-of-month balance, so a card that opens the draw month at 0 owes no
 * payment that month and the freshly-borrowed balance is observed intact.
 */

import { describe, it, expect } from "vitest";
import { simulateHousehold } from "./simulate";
import type { HouseholdSimInput, SimPerson } from "./simulate.types";
import type { FinancialObligation } from "./financialObligation";
import { OBLIGATION_PRIORITY } from "./financialObligation";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { RevolvingCard } from "../liability/liability";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";

const PERSON: SimPerson = { id: "p1", name: "Alice" };
const SPEND_MONTH = 1;

/** A liquid cash account (basis == balance ⇒ a draw books no gain and no tax). */
function cash(id: string, openingCents: number): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

/** A revolving card present from the start (startMonth 0), no interest, with an entered limit. */
function card(id: string, creditLimitCents: number): RevolvingCard {
  return new RevolvingCard({ id, ownerId: "p1", openingBalanceCents: 0, apr: 0, creditLimitCents });
}

/** An explicitly-funded expense draining `orderedAccountIds` in order at `SPEND_MONTH`. */
function explicitSpend(id: string, amountCents: number, orderedAccountIds: readonly string[]): FinancialObligation {
  return {
    id: `draw:${id}`,
    sourceId: id,
    month: SPEND_MONTH,
    amountCents,
    treatment: "expense",
    funding: { kind: "explicit", orderedAccountIds },
    priority: OBLIGATION_PRIORITY.untracked,
    sourceKind: "untracked",
    editable: false,
    label: id,
    category: "other",
  };
}

function run(input: Partial<HouseholdSimInput> & Pick<HouseholdSimInput, "accounts">) {
  return simulateHousehold(
    {
      horizonMonths: 6,
      annualInflationRate: 0,
      persons: [PERSON],
      incomeSeries: [],
      expenseSeries: [],
      ...input,
    },
    nullJurisdiction,
  );
}

describe("credit as an authored funding source", () => {
  it("borrows a credit-funded expense onto the card's liability without selling an asset", () => {
    const series = run({
      accounts: [cash("checking", 1_000_00)],
      liabilities: [card("visa", 10_000_00)],
      fundingDraws: [explicitSpend("trip", 6_000_00, ["visa"])],
    });

    expect(series.status).toBe("ran-to-horizon");
    const m = series.months[SPEND_MONTH];
    // The $6k borrow lands on the card in full — no same-month payment, since the card opened the
    // month at 0.
    expect(m.liabilityBalancesCents.visa).toBe(6_000_00);
    // No asset was sold to fund it — the borrow is the funding action, not a cash spend.
    expect(m.accountBalancesCents.checking).toBe(1_000_00);
    // The spend leaves net worth by exactly the new debt: $1k cash − $6k owed.
    expect(m.netWorthNominalCents).toBe(1_000_00 - 6_000_00);
    // Attribution names the card as a credit source for the whole draw, tax-free.
    const record = m.flows?.resolvedFunding.find((r) => r.obligationId === "draw:trip");
    expect(record?.sources).toEqual([{ kind: "credit", sourceId: "visa", amountCents: 6_000_00 }]);
  });

  it("draws cash before credit in the authored order, borrowing only the remainder", () => {
    const series = run({
      accounts: [cash("checking", 2_000_00)],
      liabilities: [card("visa", 10_000_00)],
      // Checking first, then the card: exhaust $2k cash, borrow the remaining $4k.
      fundingDraws: [explicitSpend("trip", 6_000_00, ["checking", "visa"])],
    });

    const m = series.months[SPEND_MONTH];
    expect(m.accountBalancesCents.checking).toBe(0);
    expect(m.liabilityBalancesCents.visa).toBe(4_000_00);
    const record = m.flows?.resolvedFunding.find((r) => r.obligationId === "draw:trip");
    expect(record?.sources.map((s) => ({ kind: s.kind, sourceId: s.sourceId, amountCents: s.amountCents }))).toEqual([
      { kind: "account", sourceId: "checking", amountCents: 2_000_00 },
      { kind: "credit", sourceId: "visa", amountCents: 4_000_00 },
    ]);
  });

  it("blocks rather than borrowing on a card the user did not name", () => {
    const series = run({
      accounts: [cash("checking", 2_000_00)],
      // A card with ample headroom exists, but the spend names only checking.
      liabilities: [card("visa", 10_000_00)],
      fundingDraws: [explicitSpend("trip", 6_000_00, ["checking"])],
    });

    expect(series.status).toBe("blocked");
    expect(series.blockedAtMonth).toBe(SPEND_MONTH);
    // The engine recommends, never chooses: the unnamed card was not silently borrowed against.
    expect(series.months[SPEND_MONTH].liabilityBalancesCents.visa ?? 0).toBe(0);
  });

  it("blocks a named card's own shortfall rather than partially borrowing — nothing moves", () => {
    const series = run({
      accounts: [],
      // $2k owed on a $10k limit leaves $8k headroom, short of the $12k trip.
      liabilities: [card("visa", 10_000_00)],
      fundingDraws: [explicitSpend("trip", 12_000_00, ["visa"])],
    });

    expect(series.status).toBe("blocked");
    // Pre-flighted: a draw that falls short applies none of it, not even the $8k headroom.
    expect(series.months[SPEND_MONTH].liabilityBalancesCents.visa ?? 0).toBe(0);
  });

  it("never borrows on a card with no entered limit — a null limit is zero headroom, not unlimited", () => {
    // No `creditLimitCents` at all — the sim-input shape a card with no limit entered compiles to.
    const noLimitCard = new RevolvingCard({ id: "visa", ownerId: "p1", openingBalanceCents: 0, apr: 0 });
    const series = run({
      accounts: [],
      liabilities: [noLimitCard],
      fundingDraws: [explicitSpend("trip", 1_000_00, ["visa"])],
    });

    expect(series.status).toBe("blocked");
    expect(series.months[SPEND_MONTH].liabilityBalancesCents.visa ?? 0).toBe(0);
  });
});
