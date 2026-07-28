import { addEvent, type Ledger, type LedgerBaseConfig, type NewLifeEvent } from "./index";
import { SimAccount, CAPITAL_GAINS_TAX_PROFILE } from "./simAccount";
import type { Person } from "./person";

// Shared builders for the events.* test files, co-located with them, mirroring
// engine/src/testing/. Behaviour-identical to the originals from the top of events.test.ts,
// so the partitioned sibling suites stay byte-for-byte green.

export const personLit = (id: string, name: string): Person => ({
  id,
  name,
  birthYear: 1990,
  retirementTargetAge: 65,
  benefitClaimingAge: 67,
  jobs: [],
});

export function makeLiquidAccount(id = "checking", openingCents = 0): SimAccount {
  return new SimAccount({
    id,
    ownerId: "p1",
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    openingBalanceCents: openingCents,
    initialAnnualRate: 0,
  });
}

export const baseConfig: LedgerBaseConfig = {
  horizonMonths: 12,
  annualInflationRate: 0,
  initialPersons: [personLit("p1", "Alice")],
};

// Validation base for fixtures — baseConfig plus a liquid account so DebtPayoff fixtures
// (which need one to draw from) pass. Validates fixture events only; each test still
// replays against its own base.
export const addBase: LedgerBaseConfig = { ...baseConfig, initialAccounts: [makeLiquidAccount()] };

/** Append a fixture event, asserting it passes validation. */
export function add(ledger: Ledger, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, addBase, event);
  if (!result.ok) throw new Error(`fixture event rejected: ${result.conflict}`);
  return result.ledger;
}
