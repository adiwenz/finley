import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "./ledger";
import { addEvent, fundingLookup } from "./addEvent";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import { PRE_NOW_MONTH } from "../projection/nowMarker";
import { RevolvingCard } from "../liability/liability";
import { simulateHousehold } from "../projection/simulate";
import { SimAccount } from "../plan/simAccount";
import { OBLIGATION_PRIORITY, type FinancialObligation } from "../projection/financialObligation";

function liquidAcct(id: string, openingCents: number, rate = 0, label?: string): PlanAccount {
  return planAccount({
    id,
    owners: ["p1" as PersonId],
    ...(label !== undefined ? { label } : {}),
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

function baseWithAccounts(accounts: PlanAccount[], inflation = 0): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: inflation,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: accounts,
  };
}

/** Appends a fixture, asserting it passes. */
function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

/**
 * A card taken via a standalone `LoanEvent` — the only way a `RevolvingCard` becomes part of the
 * ledger so far, since credit is never in `initialAccounts`. Carried from `PRE_NOW_MONTH`, so its
 * `openingBalanceCents` is seeded directly rather than only appearing once month 0 originates it —
 * otherwise even the `opening` snapshot would read the card at $0 owed.
 */
function cardLoanEvent(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "card1",
    type: "LoanEvent",
    month: PRE_NOW_MONTH,
    liabilityId: "visa",
    ownerId: "p1",
    kind: "creditCard",
    openingBalanceCents: 0,
    apr: 0,
    creditLimitCents: 10_000_00,
    ...overrides,
  } as NewLifeEvent;
}

describe("fundingLookup — sourcesAt's pool by treatment", () => {
  it("omits credit by default (asset-acquisition) and includes it only for expense", () => {
    const base = baseWithAccounts([liquidAcct("savings", 1_000_00)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      cardLoanEvent({ creditLimitCents: 5_000_00, openingBalanceCents: 1_000_00 }),
    );
    const { sourcesAt } = fundingLookup(ledger, base, nullJurisdiction);

    expect(sourcesAt(0).map((s) => s.id)).toEqual(["savings"]);
    expect(sourcesAt(0, "asset-acquisition").map((s) => s.id)).toEqual(["savings"]);

    const expensePool = sourcesAt(0, "expense");
    expect(expensePool.map((s) => s.id).sort()).toEqual(["savings", "visa"]);
    const card = expensePool.find((s) => s.id === "visa");
    expect(card).toMatchObject({ kind: "credit", limited: true, balanceCents: 4_000_00 });
  });
});

// `fundingLookup` resolves an explicitly-named card the same way `resolveFundingDraws` does, so a
// mixed `[account, credit]` selection prices identically whether the household is still editing
// (the gate) or the draw has actually run (the simulator).
describe("fundingLookup — credit sources", () => {
  it("reports a named card's remaining headroom, tax-free — not its owed balance", () => {
    const base = baseWithAccounts([]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      cardLoanEvent({ creditLimitCents: 10_000_00, openingBalanceCents: 1_000_00 }),
    );

    // Month 0: the `opening` snapshot, before the card's own minimum-payment mechanics have had a
    // month to nudge the owed balance — otherwise a later month's amortization, not the headroom
    // math under test, would move the number.
    const gate = fundingLookup(ledger, base, nullJurisdiction).availabilityAt("expense", ["visa"], 5_000_00, 0);

    expect(gate.shortfallCents).toBe(0);
    expect(gate.availableCents).toBe(5_000_00);
    expect(gate.taxCents).toBe(0);
    expect(gate.sources).toEqual([
      { id: "visa", label: "visa", balanceCents: 9_000_00, kind: "credit", limited: true },
    ]);
  });

  it("blocks a candidate a maxed card cannot cover — headroom clamps at zero, not the owed balance", () => {
    const base = baseWithAccounts([]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      cardLoanEvent({ creditLimitCents: 5_000_00, openingBalanceCents: 5_000_00 }),
    );

    const gate = fundingLookup(ledger, base, nullJurisdiction).availabilityAt("expense", ["visa"], 1_000_00, 0);

    expect(gate.availableCents).toBe(0);
    expect(gate.shortfallCents).toBe(1_000_00);
  });

  it("prices a mixed [account, credit] selection exactly as the simulator resolves the equivalent draw", () => {
    const ACCOUNT_ID = "checking";
    const CARD_ID = "visa";
    const MONTH = 1;
    const AMOUNT = 6_000_00;
    const OPENING_CASH = 2_000_00;
    const CARD_LIMIT = 10_000_00;

    // The gate side: an account from the base plus a card authored via `LoanEvent`.
    const base = baseWithAccounts([liquidAcct(ACCOUNT_ID, OPENING_CASH)]);
    const ledger = addWithBase(
      emptyLedger,
      base,
      cardLoanEvent({ liabilityId: CARD_ID, creditLimitCents: CARD_LIMIT, openingBalanceCents: 0 }),
    );
    const gate = fundingLookup(ledger, base, nullJurisdiction).availabilityAt(
      "expense",
      [ACCOUNT_ID, CARD_ID],
      AMOUNT,
      MONTH,
    );

    // The simulator side: the identical starting balances, drawn by an explicit expense naming
    // the same sources in the same order.
    const obligation: FinancialObligation = {
      id: "draw:trip",
      sourceId: "trip",
      month: MONTH,
      amountCents: AMOUNT,
      treatment: "expense",
      funding: { kind: "explicit", orderedAccountIds: [ACCOUNT_ID, CARD_ID] },
      priority: OBLIGATION_PRIORITY.untracked,
      sourceKind: "untracked",
      editable: false,
      label: "trip",
      category: "other",
    };
    const series = simulateHousehold(
      {
        horizonMonths: 6,
        annualInflationRate: 0,
        persons: [{ id: "p1", name: "Alice" }],
        incomeSeries: [],
        expenseSeries: [],
        accounts: [
          new SimAccount({
            id: ACCOUNT_ID,
            ownerId: "p1",
            liquid: true,
            taxProfile: CAPITAL_GAINS_TAX_PROFILE,
            openingBalanceCents: OPENING_CASH,
            initialAnnualRate: 0,
          }),
        ],
        liabilities: [
          new RevolvingCard({ id: CARD_ID, ownerId: "p1", openingBalanceCents: 0, apr: 0, creditLimitCents: CARD_LIMIT }),
        ],
        fundingDraws: [obligation],
      },
      nullJurisdiction,
    );

    expect(series.status).toBe("ran-to-horizon");
    expect(gate.shortfallCents).toBe(0);
    // Cash drains first, the remainder borrows on the card — the gate's predicted delivery equals
    // exactly what the sim actually applied, in the same authored order.
    expect(gate.availableCents).toBe(AMOUNT);
    expect(series.months[MONTH].accountBalancesCents[ACCOUNT_ID]).toBe(0);
    expect(series.months[MONTH].liabilityBalancesCents[CARD_ID]).toBe(AMOUNT - OPENING_CASH);
  });
});
