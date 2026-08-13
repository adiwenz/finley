/**
 * Projects the annual taxable income knowable at the start of a tax year — without running the
 * stateful funding waterfall — and prices it, sizing the year's estimated federal income-tax
 * instalments.
 *
 * THREE sources of taxable income, in descending order of how firmly they are known:
 *
 *  1. SCHEDULED income, read straight off compiled plan data: wages, pensions, the taxable slice
 *     of a government benefit, this year's RMD. Read, never extrapolated from year-to-date.
 *  2. EXPLICITLY-FUNDED events — a home purchase, a one-time spend — whose obligation already
 *     names the accounts it drains and in what order. Their taxable income is not guessed; it is
 *     priced through the very function the simulator will use ({@link resolveOrderedFundingDraw}),
 *     against the balances the year opens with.
 *  3. FORECAST decumulation: the taxable withdrawals the funding waterfall will make to cover
 *     ordinary living costs the year's income does not. This is the estimate's whole reason for
 *     existing in a retired plan — a household living off a pre-tax account has essentially no
 *     scheduled income and a five-figure annual tax bill, and an estimate that saw only (1) put
 *     that entire bill into the December reconciliation. That is where the recurring December
 *     tax-and-net-worth spike came from.
 *
 * The forecast in (3) is LIGHTWEIGHT and annual: {@link forecastFundingDraws} against {@link
 * orderedLiquidationAccounts}, the real waterfall's own account priority. It runs no months,
 * compounds nothing, replays no events, and never re-enters `simulateHousehold`.
 *
 * TAX AND FUNDING ARE CIRCULAR — paying the tax is itself a cash need, which is funded by
 * withdrawals, which are taxable. That is solved here as a small fixed point (below), the annual
 * analogue of what the simulator does month to month, where each month's instalment enlarges the
 * next month's funding gap.
 *
 * None of this is authoritative. The real run accumulates ACTUAL taxable income into {@link
 * import("./runState").SimState.taxableIncomeByPersonYear} and reconciles against it in December
 * ({@link import("./annualTaxSettlement").settleAnnualTax}), unchanged. A better estimate does not
 * make the year's tax more or less correct — it makes it arrive evenly through the year instead
 * of all at once at the end.
 */

import type { Cents } from "../money/money";
import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { SimState } from "./runState";
import type { SimOwnedSeries } from "./simulate.types";
import { isPersonActiveAt } from "./simulate.types";
import type { IncomeSourceMonth } from "./waterfall";
import { deferralForSourceCents, taxableAfterDeferralCents } from "./waterfall";
import { addCategory, type SourceTaxable, type TaxableByCategory } from "./taxAttribution";
import { buildIncomeSources } from "./allocationStep";
import { buildGovernmentBenefitSources, type EarningsState } from "./governmentBenefit";
import { annualFederalTax, MONTHS_IN_TAX_YEAR, type EstimatedTaxYear } from "./federalIncomeTax";
import { automaticFundingTotal, buildObligations } from "./financialObligation";
import { resolveOrderedFundingDraw, type FundingSourceState } from "./fundingDrawStep";
import { orderedLiquidationAccounts } from "./withdrawal";
import { forecastFundingDraws, type ForecastAccount, type ForecastDraw } from "./fundingForecast";
import { RevolvingCard, SYNTHETIC_CARD_ID } from "../liability/liability";

export interface TaxYearProjectionInput {
  readonly state: SimState;
  readonly jurisdiction: Jurisdiction;
  readonly ctx: JurisdictionContext;
  /** The tax year's FIRST processed month. */
  readonly month: number;
  readonly startYear: number;
  readonly incomeSeries: readonly SimOwnedSeries[];
  /**
   * The compiled expense streams — budget lines, healthcare, event-spawned costs — read for the
   * OUTFLOW half of the year's funding need. Same series `buildObligations` reads every month, so
   * the need being forecast is the need the waterfall will actually be asked to cover.
   */
  readonly expenseSeries: readonly SimOwnedSeries[];
  /**
   * This month's scheduled liability payments, held flat across the year. An amortizing loan's
   * payment IS flat, so the only imprecision is a debt that retires mid-year, which this keeps
   * charging — an estimate that runs slightly high on a year a loan ends, and settles in December
   * like any other estimate. Recomputing it per month would need the amortization walk, which is
   * exactly the second simulation this must not be.
   */
  readonly liabilityPaymentsCents: ReadonlyMap<string, Cents>;
  readonly benefitColaRate: number;
  /**
   * This month's already-built non-withdrawal sources — reality, not a re-derivation. The year's
   * RMD is issued once, in this very month, so it arrives here rather than being predicted.
   */
  readonly openingMonthSources: readonly IncomeSourceMonth[];
  /** Each person's remaining annual deferral room as the year opens. */
  readonly remainingDeferralRoomCents: (personId: string) => number;
}

/**
 * The fixed point stops when a full round trip moves the household's annual tax by less than a
 * dollar. Well inside the estimate's own accuracy — this is a forecast being spread over twelve
 * instalments, not a filing — and December reconciles whatever is left regardless.
 */
const CONVERGENCE_TOLERANCE_CENTS = 100;

/**
 * Defensive only. The iteration is a contraction (each round trip multiplies the previous
 * change by a marginal tax rate, which is < 1), so a realistic plan settles in a handful of
 * passes; this stops a pathological jurisdiction from spinning. Falling out at the cap leaves the
 * last estimate standing, which is still enormously better than no forecast at all — and December
 * reconciles it either way.
 */
const MAX_FIXED_POINT_ITERATIONS = 24;

/** A person's taxable base and the per-source weights each instalment is apportioned across. */
interface PersonYearBase {
  readonly byCategory: TaxableByCategory;
  readonly weights: Map<string, SourceTaxable>;
}

function baseFor(bases: Map<string, PersonYearBase>, personId: string): PersonYearBase {
  let base = bases.get(personId);
  if (base === undefined) {
    base = { byCategory: {}, weights: new Map() };
    bases.set(personId, base);
  }
  return base;
}

/** Fold one taxable amount into a person's base, under a source key the tax chart bands on. */
function addTaxable(
  bases: Map<string, PersonYearBase>,
  personId: string,
  key: string,
  category: SourceTaxable["category"],
  taxableCents: Cents,
): void {
  if (taxableCents <= 0) return;
  const base = baseFor(bases, personId);
  addCategory(base.byCategory, category, taxableCents);
  const existing = base.weights.get(key);
  base.weights.set(
    key,
    existing === undefined
      ? { key, category, taxableCents }
      : { ...existing, taxableCents: existing.taxableCents + taxableCents },
  );
}

function cloneBases(bases: Map<string, PersonYearBase>): Map<string, PersonYearBase> {
  const copy = new Map<string, PersonYearBase>();
  for (const [pid, base] of bases) {
    copy.set(pid, { byCategory: { ...base.byCategory }, weights: new Map(base.weights) });
  }
  return copy;
}

export function projectKnownTaxYear(
  input: TaxYearProjectionInput,
): Map<string, EstimatedTaxYear> {
  const { state, jurisdiction, ctx, month, startYear, incomeSeries, benefitColaRate } = input;

  // ── 1. Scheduled taxable income, and the gross cash it brings in ────────────────────────────

  // Pricing a FUTURE month's benefit must not advance the real run's caches: the base is
  // priced once at claim and re-priced when a completed year adds covered earnings, and a
  // projection that wrote those markers would silently skip the real re-pricing later.
  const benefitState: EarningsState = {
    earningsByPerson: state.earningsByPerson,
    personsById: state.personsById,
    governmentBenefitBaseByPerson: new Map(state.governmentBenefitBaseByPerson),
    lastComputedThroughYear: new Map(state.lastComputedThroughYear),
  };

  const roomRemaining = new Map<string, number>();
  for (const pid of state.personIds) {
    roomRemaining.set(pid, input.remainingDeferralRoomCents(pid));
  }

  // Everything (1) and (2) contribute — fixed for the whole solve. Only the forecast layer (3)
  // is recomputed as the fixed point turns.
  const knownBases = new Map<string, PersonYearBase>();
  // The INFLOW half of the year's funding need: gross cash reaching the waterfall, which is what
  // `buildWithdrawalSources` sizes its monthly gap against (it nets the tax instalment off this
  // same gross figure, which is precisely the circularity the fixed point below resolves).
  let expectedInflowCents = 0;

  const fold = (sources: readonly IncomeSourceMonth[]): void => {
    for (const src of sources) {
      expectedInflowCents += src.waterfallInflowCents;
      const room = roomRemaining.get(src.ownerId) ?? Infinity;
      const deferred = deferralForSourceCents(src, room);
      if (deferred > 0) roomRemaining.set(src.ownerId, room - deferred);
      addTaxable(
        knownBases,
        src.ownerId,
        src.sourceId ?? src.taxCategory,
        src.taxCategory,
        taxableAfterDeferralCents(src, deferred),
      );
    }
  };

  fold(input.openingMonthSources);
  // The remaining eleven months, from the compiled series alone. The same active-window gate
  // the simulator applies each month: a series stops paying this household when its owner
  // leaves it or dies, and an estimate that ignored that would over-withhold all year.
  for (let m = month + 1; m < month + MONTHS_IN_TAX_YEAR; m++) {
    const active = incomeSeries.filter((s) => {
      const owner = state.personsById.get(s.ownerId);
      return owner === undefined || isPersonActiveAt(owner, m);
    });
    fold([
      ...buildIncomeSources(active, m),
      ...buildGovernmentBenefitSources(benefitState, jurisdiction, m, startYear, benefitColaRate),
    ]);
  }

  // ── 2. Explicitly-funded events, priced off their own resolved allocation ───────────────────

  // Working balances, threaded from here on: an event that drains the brokerage in March leaves
  // less of it for the ordinary decumulation forecast in (3), exactly as it will in the real run.
  const workingBalances = new Map(state.assetBalances);
  const workingBasis = new Map(state.basisByAccount);
  // What an event's named sources could NOT deliver — the one case its funding is not actually
  // resolved. Only that residue falls through to the forecast; the part the allocation does
  // cover is already counted here and must not be counted again.
  let unresolvedEventCents = 0;

  const thisYearsDraws = state.fundingDraws
    .filter(
      (o) =>
        o.funding.kind === "explicit" &&
        o.month >= month &&
        o.month < month + MONTHS_IN_TAX_YEAR,
    )
    .sort((a, b) => a.month - b.month);

  for (const obligation of thisYearsDraws) {
    if (obligation.funding.kind !== "explicit") continue; // narrowing; the filter established it
    const sources: FundingSourceState[] = [];
    for (const sourceId of obligation.funding.orderedAccountIds) {
      const account = state.accounts.find((a) => a.id === sourceId);
      if (account !== undefined) {
        sources.push({
          kind: "account",
          id: sourceId,
          ownerId: account.ownerId,
          category: account.taxProfile.withdrawalCategory,
          balanceCents: workingBalances.get(sourceId) ?? 0,
          basisCents: Math.max(0, workingBasis.get(sourceId) ?? 0),
        });
        continue;
      }
      const card = state.liabilities.find(
        (l): l is RevolvingCard =>
          l instanceof RevolvingCard && l.id === sourceId && l.id !== SYNTHETIC_CARD_ID,
      );
      if (card !== undefined) {
        sources.push({
          kind: "credit",
          id: sourceId,
          ownerId: card.ownerId,
          balanceCents: state.liabilityBalances.get(sourceId) ?? 0,
          creditLimitCents: card.creditLimitCents,
        });
      }
    }

    // The simulator's own draw resolution, not a re-derivation of it: same order, same
    // jurisdiction basis/gain seam, so "the realized gain on the $30k brokerage slice" is
    // whatever the real draw will book, and a credit-funded slice realizes nothing at all.
    // No gross-up — a mid-year event is never grossed up for federal income tax, here or there;
    // its gain simply joins the year's taxable income like any other.
    const { perSource, shortfallCents } = resolveOrderedFundingDraw(
      obligation.amountCents,
      sources,
      jurisdiction,
      ctx,
      new Map(),
    );
    unresolvedEventCents += shortfallCents;

    for (const s of perSource) {
      if (s.kind === "credit" || s.grossCents <= 0) continue;
      workingBalances.set(s.id, (workingBalances.get(s.id) ?? 0) - s.grossCents);
      workingBasis.set(s.id, Math.max(0, (workingBasis.get(s.id) ?? 0) - s.principalCents));
      // Keyed exactly as the simulator will key this draw's reporting band, so the estimated tax
      // and the actual tax land on the same chart band rather than two lookalikes.
      addTaxable(
        knownBases,
        s.ownerId,
        `${obligation.sourceId}:${s.id}`,
        s.category,
        s.gainCents,
      );
    }
  }

  // ── 3. The unresolved annual funding need ───────────────────────────────────────────────────

  // The OUTFLOW half: every automatically-funded obligation across the year's twelve months, from
  // the same `buildObligations` the simulator runs — so the forecast is sized against the same
  // list, not a parallel total. Explicitly-funded obligations are excluded by
  // `automaticFundingTotal` itself, which is what stops an event counted in (2) being counted
  // again here.
  let expectedOutflowCents = 0;
  for (let m = month; m < month + MONTHS_IN_TAX_YEAR; m++) {
    expectedOutflowCents += automaticFundingTotal(
      buildObligations(input.expenseSeries, m, state.liabilities, input.liabilityPaymentsCents),
    );
  }

  // SIGNED, deliberately: a household whose income comfortably exceeds its costs carries a
  // negative need, and its tax is paid out of that surplus — clamping the shortfall at zero
  // first would make the tax itself look like an unfunded need and forecast a working household
  // selling investments every year to pay withholding it actually pays from wages. The clamp
  // belongs at the point of drawing (`forecastFundingDraws` returns nothing for a need ≤ 0),
  // not before the tax is added in.
  const netFundingNeedCents =
    expectedOutflowCents - expectedInflowCents + unresolvedEventCents;

  // The waterfall's own account priority — liquid cash first, then the liquidation order — with
  // the year's explicit event draws already taken out of the balances above.
  const liquidId = state.liquidAccount?.id ?? null;
  const forecastAccounts: ForecastAccount[] = orderedLiquidationAccounts(
    state.accounts,
    liquidId,
  ).map((a) => ({
    id: a.id,
    ownerId: a.ownerId,
    category: a.taxProfile.withdrawalCategory,
    balanceCents: workingBalances.get(a.id) ?? 0,
    basisCents: Math.max(0, workingBasis.get(a.id) ?? 0),
    liquidBuffer: a.id === liquidId,
  }));

  // ── 4. Solve the tax/funding circularity ────────────────────────────────────────────────────

  /** Price the year with a given forecast layer stacked on the known base. */
  const price = (
    forecast: readonly ForecastDraw[],
  ): { estimates: Map<string, EstimatedTaxYear>; totalCents: Cents } => {
    const bases = cloneBases(knownBases);
    for (const draw of forecast) {
      // Keyed on the account id, the same `sourceId` `buildWithdrawalSources` gives the real
      // draw — so a year's estimated instalments band under "Retirement account" alongside the
      // actual withdrawals they are anticipating.
      addTaxable(bases, draw.ownerId, draw.accountId, draw.category, draw.taxableCents);
    }
    const estimates = new Map<string, EstimatedTaxYear>();
    let totalCents = 0;
    for (const pid of state.personIds) {
      const base = bases.get(pid);
      const { totalCents: personCents, byCategoryCents } = annualFederalTax(
        jurisdiction,
        ctx,
        pid,
        base?.byCategory ?? {},
      );
      if (personCents <= 0) continue;
      totalCents += personCents;
      estimates.set(pid, {
        totalCents: personCents,
        byCategoryCents,
        sourceWeights: [...(base?.weights.values() ?? [])],
      });
    }
    return { estimates, totalCents };
  };

  // T₀ — what the year owes on scheduled income and resolved event funding alone, before any
  // decumulation is forecast. This is exactly the estimate this function used to return.
  let priced = price([]);
  let taxCents = priced.totalCents;

  for (let i = 0; i < MAX_FIXED_POINT_ITERATIONS; i++) {
    // Tₙ₊₁ = Tax(I_known + I_event + TaxableIncome(FundingForecast(D + Tₙ))). The tax is added to
    // the need because paying it IS a cash need — which is why one pass is not enough: the draws
    // that fund the tax realize income that raises the tax.
    const { draws } = forecastFundingDraws(
      netFundingNeedCents + taxCents,
      forecastAccounts,
      jurisdiction,
      ctx,
    );
    const next = price(draws);
    const converged = Math.abs(next.totalCents - taxCents) < CONVERGENCE_TOLERANCE_CENTS;
    priced = next;
    taxCents = next.totalCents;
    if (converged) break;
  }

  return priced.estimates;
}
