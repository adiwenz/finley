/**
 * Debt transactions: opening a liability, and paying one down in a lump sum.
 *
 * A mortgage is not here — it is a *dependent artifact* of a home purchase and is minted by
 * `./housing` off the property's id, never authored on its own.
 */

import type { PersonId } from "../job/job";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { LiabilityKind } from "../liability/liability";
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
 * The kinds a loan can be ORIGINATED as during the plan — a strict subset of
 * {@link LiabilityKind}, and the narrowest part of this module's contract.
 *
 * A `LoanEvent` books a liability and nothing else: there are no proceeds, no destination
 * account, no asset. That is right for exactly these two:
 *
 *   - `creditCard` — the opening balance IS money already spent; there was never an inflow.
 *   - `studentLoan` — the thing bought is an education, which no balance sheet carries.
 *
 * It is wrong for `auto` (you have a car) and for `mortgage` (you have a house). Originating
 * either as a bare liability books the debt and drops the asset, so net worth falls by the whole
 * loan and keeps falling as the payments are serviced — a $30k auto loan costs the household
 * $30k of net worth and delivers nothing. Rather than model that half-right, this type refuses
 * to express it.
 *
 * A mortgage is not lost: it is originated by {@link import("./housing").applyHomePurchase},
 * which mints the loan AND the property together, so the two sides land in the same transaction.
 * An auto loan has no such path yet — see the tracking issue on financed purchases.
 *
 * {@link CarryLoanInput} is deliberately NOT restricted. A debt the household already carries is
 * a statement about today's balance sheet, and someone who already owns the car and owes on it
 * is describing a real position, not originating a one-sided one.
 */
export type OriginableLoanKind = "creditCard" | "studentLoan";

/**
 * Discriminated on `kind`: a revolving card has a limit and never amortizes, a term loan
 * amortizes and has no limit. Restricted to {@link OriginableLoanKind}.
 */
export type TakeLoanInput =
  | (TakeLoanCommon & { readonly kind: "creditCard"; readonly creditLimitCents: number })
  | (TakeLoanCommon & {
      readonly kind: Exclude<OriginableLoanKind, "creditCard">;
      readonly termMonths: number;
    });

/** Runtime counterpart to {@link OriginableLoanKind}, for input that never met the compiler. */
const ORIGINABLE_LOAN_KINDS: ReadonlySet<string> = new Set<OriginableLoanKind>([
  "creditCard",
  "studentLoan",
]);

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

/**
 * Every kind a `LoanEvent` can carry — what {@link appendLoanEvent} accepts. Wider than
 * {@link TakeLoanInput} because a HOLDING may be any kind: `carryLoan` opens a mortgage or auto
 * loan the household already has, which is a description of today, not an origination.
 */
type AnyLoanOrigination =
  | (TakeLoanCommon & { readonly kind: "creditCard"; readonly creditLimitCents: number })
  | (TakeLoanCommon & {
      readonly kind: Exclude<LiabilityKind, "creditCard">;
      readonly termMonths: number;
    });

/** The shared write. Kind-agnostic; the origination rule is {@link applyLoan}'s alone. */
function appendLoanEvent(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: AnyLoanOrigination,
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
 * Originate a loan during the plan. REFUSED for any kind outside {@link OriginableLoanKind} —
 * a bare `auto` or `mortgage` liability books debt with no asset against it, and the engine
 * declines to author a balance sheet it knows to be one-sided.
 *
 * The type already excludes both; this guard is for input that never met the compiler — a stored
 * scenario written before the restriction, or JSON crossing the boundary untyped.
 *
 * Answers with the minted `"loan-N"` id, which is also the liability's.
 */
export function applyLoan(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: TakeLoanInput,
): Written<string> {
  if (!ORIGINABLE_LOAN_KINDS.has(input.kind)) {
    throw new Error(
      `Projection: cannot apply transaction — a "${input.kind}" loan cannot be originated on its own: ` +
        `it would book the debt without the asset it paid for. A mortgage is originated by buying ` +
        `a home (which mints both); a loan the household ALREADY carries is authored with ` +
        `carryLoan. Originable kinds: ${[...ORIGINABLE_LOAN_KINDS].join(", ")}.`,
    );
  }
  return appendLoanEvent(state, jurisdiction, input);
}

/**
 * Open a pre-existing loan as a holding at {@link PRE_NOW_MONTH}. Goes straight to
 * {@link appendLoanEvent} — a holding IS a `LoanEvent`, only dated `-1` with current terms — so
 * it shares the owner-exists and unique-id checks and mints the same `"loan-N"` id, while
 * keeping every {@link LiabilityKind}: an existing car loan is a fact, not an origination.
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
  return appendLoanEvent(
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
