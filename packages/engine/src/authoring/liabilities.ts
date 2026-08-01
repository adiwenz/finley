/**
 * Debt transactions: opening a liability, and paying one down in a lump sum.
 *
 * A mortgage is not here — it is a *dependent artifact* of a home purchase and is minted by
 * `./housing` off the property's id, never authored on its own.
 */

import type { PersonId } from "../job";
import type { Jurisdiction } from "../jurisdiction";
import type { LiabilityKind } from "../liability";
import { PRE_NOW_MONTH } from "../projection/nowMarker";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";

interface TakeLoanCommon {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly openingBalanceCents: number;
  readonly apr: number;
}

/**
 * Discriminated on `kind`: a revolving card has a limit and never amortizes, a term loan
 * amortizes and has no limit.
 */
export type TakeLoanInput =
  | (TakeLoanCommon & { readonly kind: "creditCard"; readonly creditLimitCents: number })
  | (TakeLoanCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

interface CarryLoanCommon {
  readonly ownerId: PersonId;
  /** The balance still owed TODAY — the sole financial truth, never a reconstructed origination. */
  readonly balanceCents: number;
  readonly apr: number;
}

/**
 * A debt the household ALREADY carries — a holding, opened at {@link PRE_NOW_MONTH} with its
 * current balance and the term that REMAINS, so month 0 is its next amortizing payment. Distinct
 * from {@link TakeLoanInput}, whose `month` originates a fresh loan during the plan: a holding's
 * date is not a caller choice, so this shape has no `month`, and its numbers are current rather
 * than original (`balanceCents`, `remainingTermMonths`).
 */
export type CarryLoanInput =
  | (CarryLoanCommon & { readonly kind: "creditCard"; readonly creditLimitCents: number })
  | (CarryLoanCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly remainingTermMonths: number;
    });

/**
 * A lump-sum principal paydown: the liability's balance falls and `accountId` pays for it, as one
 * conserved movement.
 */
export interface PayOffDebtInput {
  readonly month: number;
  readonly liabilityId: string;
  /** The account the payment is drawn from; must exist at `month`. */
  readonly accountId: string;
  readonly amountCents: number;
}

/** Answers with the minted `"loan-N"` id, which is also the liability's. */
export function applyLoan(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: TakeLoanInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "loan");
  const common = {
    id,
    type: "LoanEvent",
    month: input.month,
    liabilityId: id,
    ownerId: input.ownerId,
    openingBalanceCents: input.openingBalanceCents,
    apr: input.apr,
  } as const;
  // Built per arm, not spread: the event union only accepts `kind` and its companion field
  // together.
  return {
    state: appendEvent(
      state,
      jurisdiction,
      input.kind === "creditCard"
        ? { ...common, kind: input.kind, creditLimitCents: input.creditLimitCents }
        : { ...common, kind: input.kind, termMonths: input.termMonths },
      nextSeq,
    ),
    result: id,
  };
}

/**
 * Open a pre-existing loan as a holding at {@link PRE_NOW_MONTH}. Reuses {@link applyLoan}
 * wholesale — a holding IS a `LoanEvent`, only dated `-1` with current terms — so it shares the
 * owner-exists and unique-id checks and mints the same `"loan-N"` id.
 */
export function applyCarryLoan(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: CarryLoanInput,
): Written<string> {
  const common = {
    month: PRE_NOW_MONTH,
    ownerId: input.ownerId,
    openingBalanceCents: input.balanceCents,
    apr: input.apr,
  } as const;
  return applyLoan(
    state,
    jurisdiction,
    input.kind === "creditCard"
      ? { ...common, kind: "creditCard", creditLimitCents: input.creditLimitCents }
      : { ...common, kind: input.kind, termMonths: input.remainingTermMonths },
  );
}

/**
 * A lump-sum paydown against an existing liability. Net worth is conserved: the same amount
 * leaves `accountId` as reduces the balance, both recorded by the one event. Answers with the
 * minted `"payoff-N"` id.
 */
export function applyDebtPayoff(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: PayOffDebtInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "payoff");
  return {
    state: appendEvent(
      state,
      jurisdiction,
      {
        id,
        type: "DebtPayoffEvent",
        month: input.month,
        liabilityId: input.liabilityId,
        accountId: input.accountId,
        amountCents: input.amountCents,
      },
      nextSeq,
    ),
    result: id,
  };
}
