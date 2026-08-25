/**
 * Household funding splits shared costs between active partners — proportionally to income, or
 * to eligible account balances once income runs out — and prefers each person's own accounts.
 * None of that may reach a transaction the user funded EXPLICITLY. An authored source list is an
 * instruction, not a hint: the order is honoured account by account, each depleted before the
 * next is touched, and an account outside the list stays untouched however well its owner could
 * have afforded the draw.
 *
 * These run in a two-partner household, and deliberately name a PARTNER's account ahead of the
 * primary person's, so any ownership-aware reordering or proportional redistribution would show
 * up as a changed balance rather than passing by coincidence.
 */
import { describe, it, expect } from "vitest";
import { emptyLedger, type Ledger } from "../ledger/ledger";
import { addEvent } from "../ledger/addEvent";
import { interpretLedger } from "../ledger/interpret";
import { buildProjection } from "./buildHouseholdInput";
import type { LedgerBaseConfig } from "../ledger/ledgerBase";
import type { NewLifeEvent } from "../ledger/eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { nullJurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "../ledger/events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import { dollarsToCents } from "../money/cashFlowSeries";

/** Rate 0 throughout, so a balance moves only when something draws on it. */
function ownedAccount(id: string, owner: string, dollars: number): PlanAccount {
  return planAccount({
    id,
    owners: [owner as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: dollarsToCents(dollars),
    initialAnnualRate: 0,
  });
}

/**
 * Two active partners. `designated-a` belongs to the PARTNER and holds less than the draw;
 * `designated-b` belongs to the primary person and can finish it. `untouched` is the control —
 * the largest account in the household, and never named by any authored order below.
 */
const base: LedgerBaseConfig = {
  horizonMonths: 24,
  annualInflationRate: 0,
  initialPersons: [personLit("p1", "Alice"), personLit("p2", "Bob")],
  initialAccounts: [
    ownedAccount("designated-a", "p2", 5_000),
    ownedAccount("designated-b", "p1", 10_000),
    ownedAccount("untouched", "p1", 25_000),
  ],
};

const SPEND_MONTH = 3;
const DRAW = dollarsToCents(8_000);

function addWithBase(ledger: Ledger, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

/** Balances in the month the draw lands, through the same public path the app runs. */
function balancesAt(event: NewLifeEvent, month = SPEND_MONTH): Readonly<Record<string, number>> {
  const ledger = addWithBase(emptyLedger, event);
  const series = buildProjection(interpretLedger(ledger, base), base, nullJurisdiction);
  return series.months[month]!.accountBalancesCents;
}

describe("Explicitly designated funding outranks household proportional funding", () => {
  it("drains a one-time spend's first authored account to zero before touching the second", () => {
    const at = balancesAt({
      id: "spend1",
      type: "OneTimeSpendEvent",
      month: SPEND_MONTH,
      label: "Car",
      amountCents: DRAW,
      fundingSourceIds: ["designated-a", "designated-b"],
    } as NewLifeEvent);

    // First authored source is spent to the cent before the second opens — not $5k/$15k of the
    // draw split across the two by balance, which is what proportional funding would do.
    expect(at["designated-a"]).toBe(0);
    expect(at["designated-b"]).toBe(dollarsToCents(10_000 - 3_000));
    // The household's largest account was never named, so it never paid — despite belonging to
    // the higher-resourced partner that a proportional split would have leaned on first.
    expect(at["untouched"]).toBe(dollarsToCents(25_000));
  });

  it("reverses which account is depleted when the authored order is reversed", () => {
    // The proof that the ORDER decides, not ownership, balance size, or roster position: the
    // same household and the same draw, with only the list reversed.
    const at = balancesAt({
      id: "spend1",
      type: "OneTimeSpendEvent",
      month: SPEND_MONTH,
      label: "Car",
      amountCents: DRAW,
      fundingSourceIds: ["designated-b", "designated-a"],
    } as NewLifeEvent);

    // `designated-b` alone covers the whole $8,000 now, so the draw stops there and the
    // partner's account — depleted to zero in the test above — is not touched at all.
    expect(at["designated-b"]).toBe(dollarsToCents(10_000 - 8_000));
    expect(at["designated-a"]).toBe(dollarsToCents(5_000));
    expect(at["untouched"]).toBe(dollarsToCents(25_000));
  });

  it("funds a house purchase's down payment in the authored order, partner account first", () => {
    // A cash acquisition, so the down payment IS the whole price and no mortgage payment rides
    // along to move balances in the same month.
    const at = balancesAt({
      id: "buy1",
      type: "HomePurchaseEvent",
      month: SPEND_MONTH,
      propertyId: "house1",
      ownerId: "p1",
      purchasePriceCents: DRAW,
      downPaymentCents: DRAW,
      downPaymentSourceIds: ["designated-a", "designated-b"],
    } as NewLifeEvent);

    // The buyer is p1, yet p1's accounts are not preferred: the authored list put the PARTNER's
    // account first, so it goes first and goes empty.
    expect(at["designated-a"]).toBe(0);
    expect(at["designated-b"]).toBe(dollarsToCents(10_000 - 3_000));
    expect(at["untouched"]).toBe(dollarsToCents(25_000));
  });
});
