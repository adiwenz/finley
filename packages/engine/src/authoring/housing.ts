/**
 * Buying a home: the transaction that authors one, and the soft debt-to-income read on one that
 * has not been authored yet.
 *
 * Both live here because they price the same purchase. The preview reads the household's real
 * numbers at the purchase month and classifies; the transaction is what actually lands, subject
 * to the down-payment hard block the append gate applies. The DTI guideline is never a gate —
 * authoring is refused on funding, not on ratios — so the preview classifies and the caller
 * decides whether to say anything.
 */

import type { GrowthMode } from "../cashFlowSeries";
import type { PersonId } from "../job";
import type { Jurisdiction } from "../jurisdiction";
import type { Cents } from "../money";
import type { Household } from "../ledger/household";
import type { ProjectionSeries } from "../projection/simulate";
import { buildSnapshot } from "../projection/snapshot";
import { assessDti, mortgagePaymentForPurchaseCents } from "../affordability";
import type { DtiAssessment } from "../affordability";
import { PRE_NOW_MONTH } from "../projection/nowMarker";
import type { ProjectionState, Written } from "./state";
import { mint } from "./mint";
import { appendEvent } from "./eventWrite";

/** The mortgage a pre-existing home still carries — current terms, never a reconstructed origination. */
export interface OwnHomeMortgageInput {
  /** The balance still owed TODAY, the sole financial truth. */
  readonly balanceCents: number;
  /** The term that REMAINS, so month 0 is the next amortizing payment. */
  readonly remainingTermMonths: number;
  readonly apr: number;
}

/**
 * A home the household ALREADY owns at simulation start — a holding, the counterpart to
 * {@link BuyHomeInput}. Its date is the now marker, not a caller choice, so there is no `month`;
 * its numbers are current (`valueCents`, and the mortgage's balance + remaining term), and it
 * draws no down payment. `mortgage` omitted means owned outright.
 */
export interface OwnHomeInput {
  readonly ownerId: PersonId;
  /** Current market value — never a reconstructed purchase price. */
  readonly valueCents: number;
  readonly mortgage?: OwnHomeMortgageInput;
  /**
   * Behavior-free basis metadata for a future sale: the month it was acquired and what was
   * originally paid. Read by no current-balance logic — the sim opens the property at
   * `valueCents`.
   */
  readonly acquiredMonth?: number;
  readonly originalPriceCents?: number;
  readonly appreciationMode?: GrowthMode;
}

/** `appreciationMode` defaults to `inflationLinked` at base inflation. */
export interface BuyHomeInput {
  readonly month: number;
  readonly ownerId: PersonId;
  readonly purchasePriceCents: number;
  readonly downPaymentCents: number;
  /** Liquid funding accounts drained for the down payment, in order. */
  readonly downPaymentSourceIds: readonly string[];
  readonly mortgageApr: number;
  readonly mortgageTermMonths: number;
  readonly appreciationMode?: GrowthMode;
}

/** A purchase being *considered* — the same numbers a `buyHome` transaction would carry. */
export interface HomePurchaseInput {
  /** The month it would land; gross income and existing debt are read there. */
  readonly month: number;
  readonly purchasePriceCents: Cents;
  readonly downPaymentCents: Cents;
  /** Fractional annual rate (0.065), matching the mortgage `LoanEvent`'s `apr`. */
  readonly apr: number;
  readonly termMonths: number;
}

/**
 * The soft guideline read, never a gate: authoring a home purchase is refused on funding, not on
 * debt-to-income, so this classifies and the caller decides whether to say anything.
 */
export interface HomePurchaseAssessment {
  readonly assessment: DtiAssessment;
  /** The level monthly mortgage payment the purchase would add. */
  readonly monthlyMortgageCents: Cents;
  /** Gross monthly income the ratios are measured against (0 → nothing is flagged). */
  readonly monthlyGrossCents: Cents;
  /** True when either the front- or back-end guideline is exceeded. */
  readonly exceeded: boolean;
}

/**
 * Feed the guideline arithmetic the household's real numbers at the purchase month: gross income
 * is every active income stream's rate, and the debt already being serviced is the projected
 * month's scheduled liability payments — 0 where nothing is owed or the month sits past the
 * horizon. Housing counts only the new mortgage; total debt counts it on top of the rest. With
 * zero gross income {@link assessDti} flags nothing, so an unearning month cannot produce a
 * divide-by-zero warning.
 *
 * Takes the run's artifacts rather than state: the question is about a *completed* pass, so
 * asking it must not cost a second simulation.
 */
export function assessHomePurchase(
  household: Household,
  series: ProjectionSeries,
  input: HomePurchaseInput,
): HomePurchaseAssessment {
  const monthlyMortgageCents = mortgagePaymentForPurchaseCents(
    input.purchasePriceCents,
    input.downPaymentCents,
    input.apr,
    input.termMonths,
  );
  const monthlyGrossCents = buildSnapshot(household, input.month, series).income.reduce(
    (sum, s) => sum + s.monthlyCents,
    0,
  );
  const existingDebtCents = series.months[input.month]?.flows?.liabilityPaymentsCents ?? 0;
  const assessment = assessDti(
    monthlyGrossCents,
    monthlyMortgageCents,
    existingDebtCents + monthlyMortgageCents,
  );
  return {
    assessment,
    monthlyMortgageCents,
    monthlyGrossCents,
    exceeded: assessment.frontEndExceeded || assessment.backEndExceeded,
  };
}

/**
 * Author the purchase as two composed primitives: the financing mortgage (a `LoanEvent`) and the
 * property that names it. The mortgage is emitted FIRST so it replays before the property, whose
 * precondition requires the securing liability to already exist.
 *
 * Both ids derive from the one minted property id — the mortgage liability is parent-suffixed
 * (`<propertyId>-mortgage`) so a sort groups it under its home, and the loan event reuses that id
 * (it is not a separately-authored loan, so it need not consume a fresh `loan-N` slot). Answers
 * with the property id; subject to the down-payment hard block, which fires on the property.
 */
export function applyHomePurchase(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: BuyHomeInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "home");
  const mortgageId = `${id}-mortgage`;
  const withMortgage = appendEvent(
    state,
    jurisdiction,
    {
      id: mortgageId,
      type: "LoanEvent",
      month: input.month,
      liabilityId: mortgageId,
      ownerId: input.ownerId,
      kind: "mortgage",
      openingBalanceCents: input.purchasePriceCents - input.downPaymentCents,
      apr: input.mortgageApr,
      termMonths: input.mortgageTermMonths,
    },
    nextSeq,
  );
  return {
    state: appendEvent(
      withMortgage,
      jurisdiction,
      {
        id,
        type: "HomePurchaseEvent",
        month: input.month,
        propertyId: id,
        ownerId: input.ownerId,
        purchasePriceCents: input.purchasePriceCents,
        downPaymentCents: input.downPaymentCents,
        downPaymentSourceIds: input.downPaymentSourceIds,
        securedByLiabilityId: mortgageId,
        ...(input.appreciationMode !== undefined
          ? { appreciationMode: input.appreciationMode }
          : {}),
      },
      nextSeq,
    ),
    result: id,
  };
}

/**
 * Author a home the household ALREADY owns — the holding counterpart to {@link applyHomePurchase}.
 * Composed from the same two primitives, both dated {@link PRE_NOW_MONTH}: the mortgage (a
 * `LoanEvent`) when there is one, emitted FIRST so it replays before the property whose
 * precondition names it, then the property that opens at its current value with NO down-payment
 * draw and NO §4.5 gate. Owned outright omits the loan and the securing link.
 *
 * The mortgage id derives from the property id (`<propertyId>-mortgage`), the same scheme
 * {@link applyHomePurchase} uses — so a sort groups it under its home and a revision reaches it
 * through the `takeLoan` verb. `acquiredMonth`/`originalPriceCents` ride along as behavior-free
 * basis metadata. Answers with the property id.
 */
export function applyOwnHome(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: OwnHomeInput,
): Written<string> {
  const { id, nextSeq } = mint(state, "home");
  const mortgageId = `${id}-mortgage`;
  const withMortgage =
    input.mortgage !== undefined
      ? appendEvent(
          state,
          jurisdiction,
          {
            id: mortgageId,
            type: "LoanEvent",
            month: PRE_NOW_MONTH,
            liabilityId: mortgageId,
            ownerId: input.ownerId,
            kind: "mortgage",
            openingBalanceCents: input.mortgage.balanceCents,
            apr: input.mortgage.apr,
            termMonths: input.mortgage.remainingTermMonths,
          },
          nextSeq,
        )
      : state;
  return {
    state: appendEvent(
      withMortgage,
      jurisdiction,
      {
        id,
        type: "HomePurchaseEvent",
        month: PRE_NOW_MONTH,
        propertyId: id,
        ownerId: input.ownerId,
        purchasePriceCents: input.valueCents,
        // A holding draws nothing — the source list is empty and the amount is zero, and the
        // holding branch in the handler skips the draw and the affordability gate entirely.
        downPaymentCents: 0,
        downPaymentSourceIds: [],
        ...(input.mortgage !== undefined ? { securedByLiabilityId: mortgageId } : {}),
        ...(input.acquiredMonth !== undefined ? { acquiredMonth: input.acquiredMonth } : {}),
        ...(input.originalPriceCents !== undefined
          ? { originalPriceCents: input.originalPriceCents }
          : {}),
        ...(input.appreciationMode !== undefined
          ? { appreciationMode: input.appreciationMode }
          : {}),
      },
      nextSeq,
    ),
    result: id,
  };
}
