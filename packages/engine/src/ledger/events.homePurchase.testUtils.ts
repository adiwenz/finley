/**
 * The household every `events.homePurchase.*.test.ts` suite buys its home in.
 *
 * A `HomePurchaseEvent` is one event with three separable contracts — the property and its
 * embedded mortgage, the §4.5 affordability gate that decides whether the purchase is authorable
 * at all, and the draw that actually takes the down payment out of the accounts — so the suites
 * are split along those lines and share this one fixture set. A second copy of `purchase()` per
 * file is how two of them end up disagreeing about what $300k with $60k down means.
 *
 * Plain builders returning plain values. No shared mutable state: every `baseWith*` call mints
 * fresh accounts, so nothing one test spends is missing from the next.
 */
import { addEvent } from "./addEvent";
import type { LedgerBaseConfig } from "./ledgerBase";
import type { NewLifeEvent } from "./eventTypes";
import { CAPITAL_GAINS_TAX_PROFILE } from "../plan/simAccount";
import { type Jurisdiction } from "../jurisdiction/jurisdiction";
import { personLit } from "./events.testSupport";
import { planAccount, type PlanAccount } from "../plan/planAccount";
import type { PersonId } from "../job/job";
import type { Ledger } from "./ledger";

export function savings(openingCents: number, rate = 0): PlanAccount {
  return planAccount({
    id: "savings",
    owners: ["p1" as PersonId],
    liquid: true,
    taxProfile: CAPITAL_GAINS_TAX_PROFILE,
    balanceCents: openingCents,
    initialAnnualRate: rate,
  });
}

export function baseWith(openingCents: number, inflation = 0): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: inflation,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: [savings(openingCents)],
  };
}

export const PRICE = 30_000_000; // $300k
export const DOWN = 6_000_000; // $60k
export const FINANCED = PRICE - DOWN; // $240k

/** The liability id these fixtures author onto `house1`'s embedded mortgage. */
export const MORTGAGE_ID = "house1-mortgage";

/**
 * A `HomePurchaseEvent` that acquires the home and drains the down payment. A bare `purchase()` is
 * a cash acquisition (no embedded `mortgage`), which the down-payment gate scrutinises identically
 * since the gate never depends on the mortgage; pass a `mortgage` override to finance it.
 */
export function purchase(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "buy1",
    type: "HomePurchaseEvent",
    month: 3,
    propertyId: "house1",
    ownerId: "p1",
    purchasePriceCents: PRICE,
    downPaymentCents: DOWN,
    downPaymentSourceIds: ["savings"],
    ...overrides,
  } as NewLifeEvent;
}

/** A standalone amortizing `LoanEvent` — genuinely separate debt, not a purchase mortgage. */
export function loanEvent(overrides: Partial<NewLifeEvent> = {}): NewLifeEvent {
  return {
    id: "loan1",
    type: "LoanEvent",
    month: 3,
    liabilityId: "loan1",
    ownerId: "p1",
    kind: "mortgage",
    openingBalanceCents: FINANCED,
    apr: 0,
    termMonths: 360,
    ...overrides,
  } as NewLifeEvent;
}

/** Appends a fixture, asserting it passes. */
export function addWithBase(ledger: Ledger, base: LedgerBaseConfig, event: NewLifeEvent): Ledger {
  const result = addEvent(ledger, base, event);
  if (!result.ok) throw new Error(`event rejected: ${result.conflict}`);
  return result.ledger;
}

/**
 * Append a financed purchase the way `buyHome` composes one: ONE event carrying the mortgage
 * inline, authored at `MORTGAGE_ID` (a real `buyHome` call mints this off the shared counter; a
 * fixture names it directly). The financed balance follows the price/down overrides automatically.
 */
export function addFinanced(
  ledger: Ledger,
  base: LedgerBaseConfig,
  homeOverrides: Partial<NewLifeEvent> = {},
): Ledger {
  const o = homeOverrides as { purchasePriceCents?: number; downPaymentCents?: number };
  const financed = (o.purchasePriceCents ?? PRICE) - (o.downPaymentCents ?? DOWN);
  return addWithBase(
    ledger,
    base,
    purchase({
      ...homeOverrides,
      mortgage: { liabilityId: MORTGAGE_ID, openingBalanceCents: financed, apr: 0, termMonths: 360 },
    }),
  );
}

export function liquidAcct(id: string, openingCents: number, rate = 0, label?: string): PlanAccount {
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

export function baseWithAccounts(accounts: PlanAccount[], inflation = 0): LedgerBaseConfig {
  return {
    horizonMonths: 24,
    annualInflationRate: inflation,
    initialPersons: [personLit("p1", "Alice")],
    initialAccounts: accounts,
  };
}

/** Taxes `capitalGains` at `rate`, basis returned pro-rata. Monotone, as the gross-up requires. */
export function flatCapitalGains(rate: number): Jurisdiction {
  return {
    id: "test-capital-gains",
    computeTaxCents: (byCat) => Math.round((byCat.capitalGains ?? 0) * rate),
    computeTaxByCategoryCents: (byCat) => {
      const tax = Math.round((byCat.capitalGains ?? 0) * rate);
      return tax > 0 ? { capitalGains: tax } : {};
    },
    taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) => {
      const basisFraction = balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0;
      return grossCents - Math.round(grossCents * basisFraction); // the gain over basis
    },
  };
}

/**
 * A gain stacked on ordinary income: untaxed up to `thresholdCents`, taxed at `rate` above, so
 * its tax depends on the owner's OTHER income. Ordinary income is untaxed, to isolate the gain.
 */
export function bracketedCapitalGains(thresholdCents: number, rate: number): Jurisdiction {
  const gainTaxCents = (byCat: Partial<Record<string, number>>): number => {
    const ordinary = byCat.ordinaryIncome ?? 0;
    const gains = byCat.capitalGains ?? 0;
    // The slice of `gains` sitting above the threshold once stacked on ordinary income.
    const taxable =
      Math.max(0, ordinary + gains - thresholdCents) - Math.max(0, ordinary - thresholdCents);
    return Math.round(Math.max(0, taxable) * rate);
  };
  return {
    id: "test-bracketed-capital-gains",
    computeTaxCents: gainTaxCents,
    computeTaxByCategoryCents: (byCat) => {
      const tax = gainTaxCents(byCat);
      return tax > 0 ? { capitalGains: tax } : {};
    },
    taxableWithdrawalCents: ({ grossCents, basisCents, balanceCents }) => {
      const basisFraction = balanceCents > 0 ? Math.min(1, basisCents / balanceCents) : 0;
      return grossCents - Math.round(grossCents * basisFraction);
    },
  };
}
