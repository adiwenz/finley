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

import type { GrowthMode } from "../money/cashFlowSeries";
import type { PersonId } from "../job/job";
import type { Jurisdiction } from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import type { Household } from "../ledger/household";
import type { ProjectionSeries } from "../projection/simulate";
import { buildSnapshot } from "../projection/snapshot";
import { assessDti, mortgagePaymentForPurchaseCents } from "../liability/affordability";
import type { DtiAssessment } from "../liability/affordability";
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
 * Author the purchase as ONE event carrying the financing terms inline: the mortgage rides as a
 * dependent artifact of this event (no second event to order before it), but its identity is
 * minted right here — off the SAME counter the property/event id draws from, one call after the
 * other — never derived or conjured at interpret time. The financed balance is
 * `purchasePriceCents − downPaymentCents` — the revision recomputes it when either changes, which
 * is what keeps price and mortgage from drifting apart.
 *
 * Answers with the property id; subject to the down-payment hard block, which fires on this event.
 */
export function applyHomePurchase(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: BuyHomeInput,
): Written<string> {
  const { id, nextSeq: afterHome } = mint(state, "home");
  // One counter, threaded property → mortgage: the mortgage draws the next id off the same
  // monotonic run, so the two never collide and a restored plan's counter floors past both.
  const { id: mortgageLiabilityId, nextSeq } = mint({ ...state, nextSeq: afterHome }, "mortgage");
  return {
    state: appendEvent(
      state,
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
        mortgage: {
          liabilityId: mortgageLiabilityId,
          openingBalanceCents: input.purchasePriceCents - input.downPaymentCents,
          apr: input.mortgageApr,
          termMonths: input.mortgageTermMonths,
        },
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
 * One event dated {@link PRE_NOW_MONTH}, carrying the mortgage inline when there is one: a holding
 * opens at the mortgage's CURRENT balance (not price − down), draws NO down payment, and skips the
 * §4.5 gate. Owned outright omits `mortgage`, and the handler leaves the property unsecured.
 *
 * `acquiredMonth`/`originalPriceCents` ride along as behavior-free basis metadata. Answers with
 * the property id.
 */
export function applyOwnHome(
  state: ProjectionState,
  jurisdiction: Jurisdiction,
  input: OwnHomeInput,
): Written<string> {
  const { id, nextSeq: afterHome } = mint(state, "home");
  // A holding's mortgage is optional, so the second mint only fires when there is one — an
  // owned-outright home leaves the counter exactly where the property id left it.
  const mintedMortgage =
    input.mortgage !== undefined ? mint({ ...state, nextSeq: afterHome }, "mortgage") : undefined;
  const mortgageLiabilityId = mintedMortgage?.id;
  const nextSeq = mintedMortgage?.nextSeq ?? afterHome;
  return {
    state: appendEvent(
      state,
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
        ...(input.mortgage !== undefined && mortgageLiabilityId !== undefined
          ? {
              mortgage: {
                liabilityId: mortgageLiabilityId,
                openingBalanceCents: input.mortgage.balanceCents,
                apr: input.mortgage.apr,
                termMonths: input.mortgage.remainingTermMonths,
              },
            }
          : {}),
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
