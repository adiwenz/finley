import type { Jurisdiction, JurisdictionContext } from "../jurisdiction/jurisdiction";
import type { Cents } from "../money/money";
import { accumulateEarnings, buildGovernmentBenefitSources } from "./governmentBenefit";
import { buildRmdSources } from "./rmd";
import { buildWithdrawalSources, DEFAULT_LIQUIDATION_ORDER } from "./withdrawal";
import { buildFlows, type PrincipalDrawdownSource } from "./reportFlows";
import { buildObligations, automaticFundingTotal, fundedLiabilityPayments } from "./financialObligation";
import { resolveFundingAttribution, type FundingSupplyPlan } from "./resolvedFunding";
import {
  isPersonActiveAt,
  type HouseholdSimInput,
  type ObligationOutcome,
  type ProjectionMonth,
  type ProjectionSeries,
} from "./simulate.types";
import type { FinancialObligation, ObligationId } from "./financialObligation";
import { cloneSimState, initSimState, type SimState } from "./runState";
import { snapshotMonth } from "./monthSnapshot";
import {
  computeLiabilityPayments,
  buildLiabilityPaymentRecords,
  applyShortfallCascade,
  advanceLiabilities,
} from "./liabilitySteps";
import { applyAssetTransfers, compoundAssets, advanceProperties } from "./assetSteps";
import {
  resolveFundingDraws,
  buildTaxableByOwner,
  toTaxableRecord,
  type FundingBlock,
} from "./fundingDrawStep";
import {
  buildIncomeSources,
  buildInterestAccrualSources,
  allocateMonth,
  projectObligationShortfallCents,
  remainingDeferralRoomCents,
  unwindUnfundedContributions,
} from "./allocationStep";
import {
  dueTaxYearSettlements,
  finalizeTaxYear,
  pendingSettlementTotalCents,
} from "./taxYearSettlement";
import { projectKnownTaxYear } from "./taxYearProjection";
import { settleEstate, type EstateSettlement } from "./estateSettlement";
import type { IncomeSourceMonth } from "./waterfall";
import {
  annualFederalTax,
  estimatedPaymentForMonth,
  MONTHS_IN_TAX_YEAR,
  type EstimatedTaxYear,
  type FederalTaxPayment,
} from "./federalIncomeTax";

// Re-exported so importers (and the engine barrel in index.ts) keep resolving the
// simulator's public types through ./simulate. `SimPerson` is OMITTED: it is an
// engine-INTERNAL compiled shape (the app authors `Person`, the sim derives `SimPerson` via
// `compilePerson`), so internal code imports it directly from ./simulate.types.
export type {
  HouseholdSimInput,
  LiabilityPaymentRecord,
  SimOwnedSeries,
  ProjectionMonth,
  ProjectionMonthFlows,
  InsolvencyReport,
  ProjectionCashFlowIncomeSource,
  IncomeSourceCategory,
  ProjectionSeries,
  BlockedObligation,
  ObligationOutcome,
  SimProperty,
} from "./simulate.types";
export type { EstateSettlement } from "./estateSettlement";

const DEFAULT_START_YEAR = 2026;

/**
 * The fate of every explicitly-funded obligation, classified by what actually happened during
 * resolution — never by comparing months. `resolvedObligationIds` is the accumulated set of draws
 * {@link resolveFundingDraws} actually resolved (money moved, attribution recorded) across every
 * month the sim ran; that set, not a month comparison, is what makes a same-month sibling AFTER the
 * blocker read as `not-reached` rather than `executed` — resolution stops mid-month, so a draw
 * later in the SAME month as the blocker was never reached any more than one in a later month was.
 *
 * An absent block means the plan ran to the horizon: nothing stopped, so every draw resolved.
 */
function classifyObligationOutcomes(
  fundingDraws: readonly FinancialObligation[],
  resolvedObligationIds: ReadonlySet<ObligationId>,
  block: ProjectionSeries["blockingObligation"],
): Record<ObligationId, ObligationOutcome> {
  const outcomes: Record<ObligationId, ObligationOutcome> = {};
  for (const draw of fundingDraws) {
    const sourceEventId =
      draw.sourceEventId !== undefined ? { sourceEventId: draw.sourceEventId } : {};
    if (block === undefined) {
      outcomes[draw.id] = { status: "executed", ...sourceEventId };
    } else if (draw.id === block.obligationId) {
      outcomes[draw.id] = {
        status: "blocked",
        month: block.month,
        shortfallCents: block.shortfallCents,
        ...sourceEventId,
      };
    } else if (resolvedObligationIds.has(draw.id)) {
      outcomes[draw.id] = { status: "executed", ...sourceEventId };
    } else {
      outcomes[draw.id] = {
        status: "not-reached",
        blockedByObligationId: block.obligationId,
        ...sourceEventId,
      };
    }
  }
  return outcomes;
}

/**
 * Which of the two passes is running a month.
 *
 *  - `authoritative` — the run the caller gets back. Reports, and prices each tax year.
 *  - `forecast` — a throwaway twelve months on a cloned state, run to LEARN the year's taxable
 *    income before the authoritative pass commits to instalments for it.
 *
 * The distinction is deliberately NOT "which economic steps happen": every one of them happens in
 * both, because the whole value of the forecast pass is that a lumpy event, a mid-year loan payoff
 * or an exhausted account needs no separate model to be seen — the simulator itself sees it. Only
 * REPORTING is skipped, and only because a discarded state's snapshots and flow bands are read by
 * nobody. A forecast month that skipped an economic step would forecast a household that does not
 * exist.
 */
type RunMode = "authoritative" | "forecast";

/** What one month needs beyond {@link SimState} — fixed for the whole pass. */
interface RunContext {
  readonly input: HouseholdSimInput;
  readonly jurisdiction: Jurisdiction;
  readonly startYear: number;
  readonly mode: RunMode;
}

/** What a processed month reports back to the pass that ran it. */
interface MonthOutcome {
  readonly isInsolvent: boolean;
  readonly uncoveredCents: Cents;
  /** Explicit draws this month actually resolved — accumulated into the run's running set. */
  readonly resolvedObligationIds: readonly ObligationId[];
  /** The blocking draw, if this month had one. Terminal for whichever pass is running. */
  readonly block: FundingBlock | undefined;
  /** Every event whose artifacts the block suppressed, blocking event first. */
  readonly omittedSourceEventIds: ReadonlySet<string>;
  /** Absent in `forecast` mode, where nothing is reported and so nothing is built. */
  readonly snapshot: ProjectionMonth | undefined;
}

/**
 * Price the tax year opening at `month` by SIMULATING it, then hold the result as the year's
 * estimate so its twelve instalments pace the authoritative pass.
 *
 * Two passes, in order:
 *
 *  1. T₀, the cheap estimate ({@link projectKnownTaxYear}): scheduled income, this year's event
 *     draws, and a lightweight forecast of the year's decumulation, with the tax/funding
 *     circularity solved over it as a small fixed point. Never used as the year's schedule.
 *  2. T₁ — twelve months run on `opening`, a clone taken before this month touched anything, under
 *     T₀'s instalments. Its December total IS the estimate.
 *
 * The DIVISION OF LABOUR is the point. T₀ answers one question well: roughly how much taxable
 * withdrawal will this year take, once the tax on those withdrawals is itself funded by more of
 * them? That is the only part the forecast pass cannot bootstrap — it has to charge something each
 * month, and its answer is only as good as what it charged. Everything else T₀ is rough about
 * — an event in March, an account depleting in August, a loan maturing in June, contributions,
 * basis, a one-time transfer — the forecast pass gets exactly right by simply performing it.
 *
 * So T₀ seeds and the simulation corrects, which is why a decumulation-aware seed matters so much:
 * seeded with scheduled income alone, a retired household's forecast pass draws nothing for tax and
 * the year under-collects by the whole circular slice — five-figure Aprils, the sawtooth the annual
 * cycle exists to remove. Seeded with T₀ it lands within a rounding residue.
 *
 * ONE Newton step, not a fixed point over the simulation. What is left is second-order: T₀ is
 * approximate, so T₁'s draws differ slightly from the ones it priced. December closes on ACTUAL
 * income ({@link finalizeTaxYear}) and the following April charges the difference.
 */
function priceTaxYear(
  state: SimState,
  opening: SimState,
  run: RunContext,
  month: number,
  ctx: JurisdictionContext,
  openingMonthSources: readonly IncomeSourceMonth[],
): void {
  const key = (personId: string): string => `${personId}|${ctx.year}`;

  const provisional = projectKnownTaxYear({
    state,
    jurisdiction: run.jurisdiction,
    ctx,
    month,
    startYear: run.startYear,
    incomeSeries: run.input.incomeSeries,
    expenseSeries: run.input.expenseSeries,
    // The balance last December parked, which THIS year's April must fund — known now, because the
    // year it belongs to is already closed. Signed: an expected refund lowers the year's funding
    // need rather than raising it.
    priorYearSettlementCents: pendingSettlementTotalCents(state, ctx),
    benefitColaRate: run.input.benefitColaRate ?? run.input.annualInflationRate,
    openingMonthSources,
    remainingDeferralRoomCents: (pid) =>
      remainingDeferralRoomCents(state, run.jurisdiction, ctx, pid),
  });
  const writeProvisional = (into: SimState): void => {
    for (const pid of state.personIds) {
      const estimate = provisional.get(pid);
      if (estimate === undefined) into.estimatedFederalTaxByPersonYear.delete(key(pid));
      else into.estimatedFederalTaxByPersonYear.set(key(pid), estimate);
    }
  };
  writeProvisional(opening);

  // The full tax year regardless of `horizonMonths`: the estimate paces TWELVE instalments, so a
  // run stopping in August still owes each of its months a twelfth of a whole year's liability.
  // Sizing the estimate off the months that happen to remain would under-charge every one of them.
  const forecastRun: RunContext = { ...run, mode: "forecast" };
  for (let m = month; m < month + MONTHS_IN_TAX_YEAR; m++) {
    // `priorInsolvency` is reporting-only (it nulls a snapshot's net worth) and the forecast pass
    // takes no snapshots, so it has nothing to carry.
    const outcome = runMonth(opening, forecastRun, m, false);
    // A blocked forecast is a TRUNCATED year, not a cheap one: its remaining months were never
    // simulated, so pricing what it did accumulate would read a household whose March purchase
    // stranded it as owing a quarter of the wages it will still earn. The provisional schedule
    // knows the whole year's scheduled income and stands instead.
    if (outcome.block !== undefined) {
      writeProvisional(state);
      return;
    }
  }

  for (const pid of state.personIds) {
    const k = key(pid);
    // The year's ACTUAL taxable income on the clone — every draw, gain, benefit and accrual the
    // twelve months really produced, in whatever months they fell.
    const { totalCents, byCategoryCents } = annualFederalTax(
      run.jurisdiction,
      ctx,
      pid,
      opening.taxableIncomeByPersonYear.get(k) ?? {},
    );
    if (totalCents <= 0) {
      state.estimatedFederalTaxByPersonYear.delete(k);
      continue;
    }
    const estimate: EstimatedTaxYear = {
      totalCents,
      byCategoryCents,
      // The clone's own per-source totals, keyed exactly as the authoritative pass will key the
      // same sources — so each instalment bands under the account or job it anticipates.
      sourceWeights: [...(opening.taxableBySourceByPersonYear.get(k)?.values() ?? [])],
    };
    state.estimatedFederalTaxByPersonYear.set(k, estimate);
  }
}

/**
 * One month of the fixed pipeline, run against whichever state the pass owns:
 *   3–6. allocation waterfall: per-source pre-tax deferrals, payroll tax and the month's
 *        estimated income-tax instalment, take-home pools, shared/personal goals, surplus —
 *        plus the deficit charge that feeds the cascade    → allocateMonth
 *     7. shortfall cascade                                 → applyShortfallCascade
 *  8–9. Asset one-time transfers, then compounding        → applyAssetTransfers / compoundAssets
 *   10. Liability transfers, interest, payments           → advanceLiabilities
 *  10b. Property appreciation                             → advanceProperties
 *   11. Snapshot                                          → snapshotMonth
 *
 * Every step above runs in BOTH modes. Step 11 and the flow bands beside it run only in
 * `authoritative` mode: they compute nothing the next month reads.
 */
function runMonth(
  state: SimState,
  run: RunContext,
  month: number,
  priorInsolvency: boolean,
): MonthOutcome {
  const { input, jurisdiction, startYear } = run;
  const reporting = run.mode === "authoritative";
  // Calendar year for this month's flows. Month 0 is now processed like any other, so
  // `months[0..11]` accrue a full 12 covered-earnings months in year 0 — a $5k/mo salary
  // contributes the whole $60k, closing the graph-vs-panel benefit gap. A mid-year start
  // (fewer than 12 real months left in this calendar year) is still unmodelled.
  const year = startYear + Math.floor(month / 12);
  const ctx: JurisdictionContext = { year };

  // The state the year's estimate will forecast from, captured before this month writes anything.
  // Cloning AFTER `accumulateEarnings` below would hand the forecast pass a state in which this
  // month's covered wages are already folded in, and its own first month would fold them again.
  const yearOpening =
    reporting && month % MONTHS_IN_TAX_YEAR === 0 ? cloneSimState(state) : null;

  // **The active-window gate**, applied once here and read by everything below it: an income
  // series pays this household only while its owner is a member of it and alive. The compiled
  // job series were already clipped to that window upstream, and re-clipping them costs
  // nothing; what this catches is every OTHER person-scoped stream — an event-authored one
  // like alimony, and anything later added beside it — which would otherwise have to remember
  // death on its own, as the government benefit once did. A series whose owner is not on the
  // roster is household-level and unbounded, which is also what an unwindowed person gets.
  const activeIncomeSeries = input.incomeSeries.filter((s) => {
    const owner = state.personsById.get(s.ownerId);
    return owner === undefined || isPersonActiveAt(owner, month);
  });
  // Fold this month's covered wages into the covered-earnings record before assembling
  // income, so a claim landing this month sees them. Gated the same way: a benefit is priced
  // off what a person earned, and they earn nothing after they die.
  accumulateEarnings(state.earningsByPerson, activeIncomeSeries, month, year, jurisdiction);
  // RMDs force this year's required draw out of pre-tax accounts BEFORE the waterfall
  // runs and re-enter here as taxable ordinary income, so the withdrawal is taxed once
  // at the single chokepoint.
  const nonWithdrawalSources = [
    ...buildIncomeSources(activeIncomeSeries, month),
    // Last month's credited cash interest, taxed as ordinary income at accrual; a
    // non-withdrawal source, so it shrinks the gap and feeds provisional income.
    ...buildInterestAccrualSources(state),
    ...buildGovernmentBenefitSources(
      state,
      jurisdiction,
      month,
      startYear,
      input.benefitColaRate ?? input.annualInflationRate,
    ),
    ...buildRmdSources(state, jurisdiction, month, startYear),
  ];

  // Price the tax year ONCE, at its first processed month, by running it — and only on the
  // authoritative pass, which is what stops a forecast year from spawning a forecast year.
  if (yearOpening !== null) {
    priceTaxYear(state, yearOpening, run, month, ctx, nonWithdrawalSources);
  }
  // The prior tax year's remaining balance, due this month if this is April — and CONSUMED
  // here, so it is charged exactly once. Signed: a positive balance joins the month's tax
  // charge, a refund nets against it and can turn the month's tax negative, which the waterfall
  // reads as extra take-home.
  const priorYearSettlements = dueTaxYearSettlements(state, ctx, month);
  // This month's even twelfth of the estimate, per person — charged below as an ordinary
  // deduction in the allocation waterfall, so a steady household pays a smooth monthly tax
  // rather than one year-end drop.
  const estimatedTaxPayments = new Map<string, FederalTaxPayment>();
  for (const pid of state.personIds) {
    estimatedTaxPayments.set(
      pid,
      estimatedPaymentForMonth(
        state.estimatedFederalTaxByPersonYear.get(`${pid}|${year}`),
        month % MONTHS_IN_TAX_YEAR,
      ),
    );
  }

  // Step 4: this month's scheduled debt payments, on beginning-of-month balances.
  const payments = computeLiabilityPayments(state, month);

  // The month's obligation list, built BEFORE decumulation sizes its gap: every downstream
  // "what must this month fund?" total now derives from this one list rather than being
  // recomputed in parallel, so the funded amount and the reported list cannot disagree.
  // Constructing here is safe against the later liability step: `advanceLiabilities` mutates
  // balances only, never the roster, and `payments` is already fixed — so the list is
  // identical wherever in the month it is built.
  const obligations = buildObligations(input.expenseSeries, month, state.liabilities, payments);
  // What the shared waterfall must cover: the automatically-funded slice of the obligation
  // list. Sized off the list — not a parallel scalar — so explicit funding (Slice #4)
  // subtracts cleanly; in this slice every obligation is automatic, so it equals the month's
  // whole expense-plus-debt bill.
  const automaticFundingCents = automaticFundingTotal(obligations);

  // Explicit obligations resolve FIRST, in event sequence, against pre-decumulation balances:
  // the down-payment / one-time-spend draw sells its named sources before the automatic
  // waterfall sizes what to liquidate. Its gains difference over non-withdrawal income alone —
  // decumulation has not run, so that ordinary income and benefits are the whole marginal
  // context. Each source sells exactly what the obligation needs and is drained here (before
  // compounding, so a drained balance does not earn this month) — no gross-up: the gain rides
  // into `allocateMonth`'s taxable pool uncharged, settled with the rest of the year's. `taxableByOwnerAfter`
  // — this base with the draws' gains stacked in — is exposed on the flow view so the §4.5 gate
  // prices a candidate over its siblings the SAME way (exact under any regime).
  const fundingBase = buildTaxableByOwner(nonWithdrawalSources);
  const fundingDraw = resolveFundingDraws(state, month, jurisdiction, ctx, fundingBase);
  // An omitted draw suppresses the property and mortgage its authoring event would originate this
  // month — otherwise `advanceProperties`/`advanceLiabilities` would mint a house and a loan with
  // no cash ever leaving, which is the very fabrication blocking exists to stop. Keyed off EVERY
  // omitted event, not just the blocking one: a block stops resolution, so a later same-month
  // purchase's down payment is never withdrawn either, and suppressing only the blocker would let
  // that purchase's house and mortgage through unfunded. The block is terminal, so only this
  // month needs suppressing.
  const omittedEventIds = fundingDraw.omittedSourceEventIds;
  const suppressedProperties = state.properties.filter(
    (p) => p.causedByEventId !== undefined && omittedEventIds.has(p.causedByEventId),
  );
  const suppressedPropertyIds = new Set(suppressedProperties.map((p) => p.id));
  // The mortgage is a dependent artifact of the purchase, reached through the property's
  // `mortgageLiabilityId`. It shares the purchase event's `causedByEventId`, so suppressing the
  // property suppresses the loan it would originate with it.
  const suppressedLiabilityIds = new Set(
    suppressedProperties.flatMap((p) =>
      p.mortgageLiabilityId != null ? [p.mortgageLiabilityId] : [],
    ),
  );

  // Snapshot balances/basis at THIS seam — after the explicit draws sold their sources, before
  // decumulation liquidates anything — because that is the state a would-be money-out event
  // resolves against. `resolveFundingDraws` has already written the sibling draws; decumulation
  // and this month's `compoundAssets` have not, so the end-of-month snapshot would understate
  // what an appended candidate can draw from an account decumulation later drains.
  const accountBalancesAfterFundingCents: Record<string, Cents> = {};
  const accountBasisAfterFundingCents: Record<string, Cents> = {};
  if (reporting) {
    for (const acc of state.accounts) {
      accountBalancesAfterFundingCents[acc.id] = state.assetBalances.get(acc.id) ?? 0;
      accountBasisAfterFundingCents[acc.id] = state.basisByAccount.get(acc.id) ?? 0;
    }
  }

  // The explicit draws' realized gain is net-neutral cash-wise (no gross-up sold it) but
  // still taxable — `gainSources` carries it in so it reaches the taxable pool and the year's
  // accumulator, settled with the rest of the year's.
  const preDecumulationSources = [...nonWithdrawalSources, ...fundingDraw.gainSources];
  // How short the month REALLY is, from the waterfall itself: the same allocation the month is
  // about to be charged by, run over the income the household has before anything is sold, and
  // then thrown away. Nothing is deposited or accumulated by it — only the gap is kept.
  //
  // Decumulation used to size this itself, as `obligations − (income − income tax)`, and that
  // second model of take-home is what silently omitted payroll tax: the waterfall docked FICA, the
  // gap did not, and a household short by exactly its FICA borrowed on a card every month with
  // investments untouched — for decades, since a working household's gap is small and a card
  // compounds. There is now one subtraction, so a deduction added to the waterfall is netted here
  // by construction.
  const shortfallBeforeDecumulationCents = projectObligationShortfallCents(
    state,
    preDecumulationSources,
    ctx,
    jurisdiction,
    automaticFundingCents,
    month,
    estimatedTaxPayments,
    priorYearSettlements,
  );
  // Decumulation then operates on the balances the explicit draws left behind: liquidate
  // investment accounts BEFORE the waterfall — same seam as RMD/benefit — to close that measured
  // gap, spending the liquid buffer first and spilling whatever the accounts cannot cover to the
  // credit cascade. No gross-up anywhere: each draw sells exactly the gap, and its realized gain
  // rides `taxableCents` into THIS year's accumulator. RMD income is already inside the gap (it
  // was income in the pass that measured it), so the draw never double-withdraws.
  const withdrawal = buildWithdrawalSources(
    state,
    jurisdiction,
    shortfallBeforeDecumulationCents,
    ctx,
    DEFAULT_LIQUIDATION_ORDER,
  );
  const incomeSources = [...nonWithdrawalSources, ...withdrawal.sources];
  const allocationSources = [...incomeSources, ...fundingDraw.gainSources];

  // Fold this month's early-withdrawal penalty into the year's flat additional tax liability —
  // never netted out of what a draw delivered (see `withdrawal.ts`/`fundingDrawStep.ts`'s module
  // docs) — so it settles through the SAME annual true-up as ordinary income tax
  // (`finalizeTaxYear`, below) rather than as an immediate cash haircut.
  for (const byOwner of [
    fundingDraw.earlyWithdrawalPenaltyByOwnerCents,
    withdrawal.earlyWithdrawalPenaltyByOwnerCents,
  ]) {
    for (const [ownerId, cents] of byOwner) {
      const key = `${ownerId}|${ctx.year}`;
      state.earlyWithdrawalPenaltyByPersonYear.set(
        key,
        (state.earlyWithdrawalPenaltyByPersonYear.get(key) ?? 0) + cents,
      );
    }
  }

  const {
    taxCents,
    payrollTaxCents,
    payrollTaxBySourceCents,
    taxByCategoryCents,
    taxBySourceCents,
    deferralBySourceCents,
    contributions,
    shortfallCents: preCascadeShortfallCents,
    obligationShortfallCents: preCascadeObligationShortfallCents,
  } = allocateMonth(
    state,
    allocationSources,
    ctx,
    jurisdiction,
    automaticFundingCents,
    month,
    estimatedTaxPayments,
    priorYearSettlements,
  );
  // Snapshot every cascade card's balance before the cascade runs, so the REAL amount it borrows
  // onto credit (see below) is measured off actual liability movement rather than inferred from
  // the sizing pass. The two passes agree on the household's take-home now, but they run over
  // different income — decumulation's own draws are in the second — so a rounding-sized residual
  // the liquid buffer quietly absorbs must not be reported as a card that was never touched.
  // Reporting-only, hence taken only when there is a report to build.
  const cascadeCardBalancesBeforeCents = reporting
    ? new Map(state.cascadeCards.map((card) => [card.id, state.liabilityBalances.get(card.id) ?? 0]))
    : null;
  // Nothing — savings or credit — could absorb this: the terminal flag. A tax balance settled
  // this month is inside it, having been charged as ordinary tax cash above; the year's close
  // below moves no money and so can add nothing here.
  const uncoveredCents = applyShortfallCascade(state, month);
  const isInsolvent = uncoveredCents > 0;
  // What the cascade actually moved onto a card this month, in real cents — ground truth for the
  // "credit" layer of the attribution below, independent of any estimate. Measured HERE and not
  // with the rest of the reporting: `advanceLiabilities` charges every card its interest and
  // payment further down, and a difference taken after that reads the month's amortization as
  // borrowing.
  const borrowedOntoCreditCents =
    cascadeCardBalancesBeforeCents === null
      ? 0
      : state.cascadeCards.reduce(
          (total, card) =>
            total +
            Math.max(
              0,
              (state.liabilityBalances.get(card.id) ?? 0) -
                (cascadeCardBalancesBeforeCents.get(card.id) ?? 0),
            ),
          0,
        );
  // A committed contribution deposits in full and borrows the rest; if that borrowing
  // couldn't be funded (this uncovered slice), unwind the phantom deposit.
  unwindUnfundedContributions(state, contributions, uncoveredCents);

  // The cascade's scarce covering capacity (savings + credit) funded obligations BEFORE
  // contributions — the same ranking OBLIGATION_PRIORITY already gives mandatory debt/needs
  // over a goal — so it covers the pre-cascade obligation shortfall first, leaving any
  // contribution/goal shortfall to absorb what's left. Only what's still short of
  // obligations after that reduces the total this month actually funded toward them.
  const coveredCapacityCents = preCascadeShortfallCents - uncoveredCents;
  const unfundedObligationCents = Math.max(
    0,
    preCascadeObligationShortfallCents - coveredCapacityCents,
  );
  const fundedObligationTotalCents = Math.max(0, automaticFundingCents - unfundedObligationCents);
  const appliedLiabilityPayments = fundedLiabilityPayments(obligations, fundedObligationTotalCents);

  // Close the tax year — a no-op every month but December, and NOT a cash event. By now this
  // month's own income has folded into `state.taxableIncomeByPersonYear` (see `allocateMonth`,
  // above), so the base this prices is the year's complete ACTUAL taxable income regardless of
  // which month each dollar landed in. All it does is park the remaining balance (liability
  // less the instalments already collected, signed) against this year, for the NEXT year's
  // April to charge or refund through the ordinary waterfall. Nothing is sold, nothing is
  // borrowed, no balance moves — which is what removed the December net-worth sawtooth, and
  // with it the recursive gross-up that a same-month settlement needed to solve.
  finalizeTaxYear(state, jurisdiction, ctx, month);

  applyAssetTransfers(state, month);
  compoundAssets(state, month, jurisdiction, ctx);
  advanceLiabilities(state, month, appliedLiabilityPayments, suppressedLiabilityIds);
  advanceProperties(state, month, suppressedPropertyIds);

  const outcome = {
    isInsolvent,
    uncoveredCents,
    resolvedObligationIds: fundingDraw.resolvedFunding.map((r) => r.obligationId),
    block: fundingDraw.block,
    omittedSourceEventIds: omittedEventIds,
  };
  if (cascadeCardBalancesBeforeCents === null) return { ...outcome, snapshot: undefined };

  // Per-line funding attribution — a partition of the SAME funded total, in the order the
  // cascade consumed its sources: income cash, liquid drawdown, decumulation, then credit. The
  // real, sized movements (each account liquidated, cards actually borrowed against) are
  // attributed as-is; income is the waterfall's own obligation coverage net of the decumulation
  // folded into it, and liquid absorbs whatever of the obligation's own share of the cascade's
  // covering capacity ({@link obligationCoveredCents}) the real credit draw didn't need — so a
  // rounding-sized gap the pre-allocation withdrawal sizing missed, but the liquid buffer (with
  // room to spare) quietly covered, is attributed to savings rather than falsely to a card that
  // was never touched.
  const decumulationTotalCents = withdrawal.decumulationDraws.reduce(
    (total, d) => total + d.netDeliveredCents,
    0,
  );
  // Returned basis within this month's decumulation draws, one entry per account — not income, so
  // it bands below with the other investment-principal draws rather than as capital-gains/ordinary
  // income. `decumulationDraws` never includes the liquid account (see `buildWithdrawalSources`),
  // so every entry here is genuinely an investment.
  const decumulationPrincipalDraws: PrincipalDrawdownSource[] = withdrawal.decumulationDraws
    .filter((d) => d.principalCents > 0)
    .map((d) => ({
      sourceId: d.sourceId,
      label: state.accounts.find((a) => a.id === d.sourceId)?.label ?? d.sourceId,
      cents: d.principalCents,
    }));
  // Obligations' own slice of what the cascade's shared liquid+credit capacity covered this
  // month (see the `unfundedObligationCents` comment above for the priority-over-contributions
  // reasoning) — the total this layer split has to divide between liquid and credit.
  const obligationCoveredCents = preCascadeObligationShortfallCents - unfundedObligationCents;
  // Real credit used for obligations: obligations claim the cascade's combined capacity before
  // contributions, so a card is only touched on their behalf once the household's REAL liquid
  // contribution (covering capacity minus what genuinely landed on a card) can't cover them.
  const realHouseholdLiquidCents = Math.max(0, coveredCapacityCents - borrowedOntoCreditCents);
  const creditForObligationsCents = Math.max(0, obligationCoveredCents - realHouseholdLiquidCents);
  const liquidToObligationsCents = obligationCoveredCents - creditForObligationsCents;
  const incomeToObligationsCents = Math.max(
    0,
    Math.min(
      automaticFundingCents - preCascadeObligationShortfallCents - decumulationTotalCents,
      Math.max(0, fundedObligationTotalCents - liquidToObligationsCents - decumulationTotalCents),
    ),
  );
  const supply: FundingSupplyPlan = {
    incomeCents: incomeToObligationsCents,
    liquidDrawdown:
      state.liquidAccount !== null && liquidToObligationsCents > 0
        ? { sourceId: state.liquidAccount.id, amountCents: liquidToObligationsCents }
        : null,
    decumulationDraws: withdrawal.decumulationDraws,
    creditCents: Math.max(
      0,
      fundedObligationTotalCents -
        incomeToObligationsCents -
        liquidToObligationsCents -
        decumulationTotalCents,
    ),
  };
  // Explicit draws resolved first in the month, so their records lead the flat list; the
  // automatic obligations follow, attributed from the shared supply. Both are the same shape —
  // a consumer reads `kind`, never the id, to tell an account-drained purchase from an
  // income-funded line.
  const resolvedFunding = [
    ...fundingDraw.resolvedFunding,
    ...resolveFundingAttribution(obligations, supply),
  ];

  const paymentRecords = buildLiabilityPaymentRecords(payments);
  // The double-count tripwire: an explicitly-funded `expense` (a One-Time Spend) must appear
  // in the expense graph at its full amount without inflating what the shared waterfall was
  // asked for (`automaticFundingCents`, sized off `obligations` alone, above). An
  // `asset-acquisition` draw (a home down payment) is deliberately excluded: it is not an
  // expense. Reported at the full owed amount regardless of whether this month's draw actually
  // resolved, mirroring how a liability's payment is reported — the funding outcome is a
  // separate fact ({@link ObligationOutcome}), not a discount on what was owed.
  const explicitExpenseObligations = state.fundingDraws.filter(
    (o) => o.month === month && o.treatment === "expense",
  );
  const bands = buildFlows(
    // `reportedGainSources`, NOT `gainSources`: an asset acquisition's realized gain is taxed
    // (it went to `allocateMonth` above, in `allocationSources`) but never banded, because the
    // cash it raised passed straight through into the house and no matching entry appears on
    // the spending side. The tax it causes is still charged, and `buildFlows` charges it to the
    // sources that did deliver cash. Reporting-only in both cases: `cashInflowCents` is the
    // gain, with no waterfall inflow.
    [...incomeSources, ...fundingDraw.reportedGainSources],
    taxCents,
    // The very list the waterfall funded above — expenses, debt and per-line rollups all
    // derive from it, so none can drift from the funded amount.
    obligations,
    // Actual cash spent from the liquid buffer this month — decumulation's own drawdown plus
    // an explicit funding draw's share, when that draw named the liquid account as a source.
    // A month funded entirely from savings still needs this band, or it reads as zero income.
    withdrawal.liquidDrawdownCents + fundingDraw.liquidPrincipalDrawdownCents,
    // Undefined when the jurisdiction declines a breakdown; the app then draws one band.
    taxByCategoryCents,
    // SAME-MONTH per-source haircut on `netCashFlowCents`: every cent of tax this month
    // charged — the instalment, plus April's settled prior-year balance — since all of it
    // really did come out of this month's take-home.
    taxBySourceCents,
    deferralBySourceCents,
    // Employee payroll tax (FICA) — its own line, already removed from take-home.
    payrollTaxCents,
    // The finer per-SOURCE payroll-tax splits, mirroring `taxBySourceCents`.
    payrollTaxBySourceCents,
    // DISPLAY-only per-source split for the tax chart. Identical to the haircut above now that
    // both describe the same month's cash; kept as its own argument because the two answer
    // different questions and only coincide while no tax is raised outside the waterfall.
    taxBySourceCents,
    explicitExpenseObligations,
    // Every investment account's returned principal this month, decumulation and explicit draws
    // both — one band per account, so a brokerage sale and a retirement-account sale read as
    // separate events rather than one anonymous "investment" line.
    [...decumulationPrincipalDraws, ...fundingDraw.investmentPrincipalDraws],
  );
  // The taxable base after this month's explicit draws but BEFORE decumulation, so the
  // authoring gate prices a would-be draw on top of any sibling draw at this month — and NOT
  // on top of decumulation, which now resolves after the candidate and so is not tax it
  // induces. A newly appended event's draw is last in ledger order, hence last among the
  // explicit draws in resolution, so this base is its marginal context.
  const flows = {
    ...bands,
    resolvedFunding,
    taxableByOwnerAfterFundingCents: toTaxableRecord(fundingDraw.taxableByOwnerAfter),
    accountBalancesAfterFundingCents,
    accountBasisAfterFundingCents,
  };

  return {
    ...outcome,
    snapshot: snapshotMonth(state, {
      month,
      // `month + 1`, NOT `month`: this snapshot is the END of month `month`, so that many
      // months plus one have passed since "now". Deflating by `month` would understate a
      // year of inflation by a twelfth, every month, all the way out.
      elapsedMonths: month + 1,
      annualInflationRate: input.annualInflationRate,
      isInsolvent,
      uncoveredCents,
      priorInsolvency,
      liabilityPaymentRecords: paymentRecords,
      flows,
    }),
  };
}

/**
 * Household simulator. Each month runs the fixed pipeline in {@link runMonth}; this function owns
 * the horizon, the terminal conditions (insolvency, a blocked draw, death) and the reported series.
 *
 * Federal income tax is priced ONCE per calendar year and paid on a schedule this function
 * owns: twelve even estimated instalments through the waterfall, then — after the year's actual
 * taxable income is complete at December — a single remaining balance carried to the FOLLOWING
 * April, where it is charged (or refunded) through that month's ordinary waterfall. A closed year
 * is never reopened. The estimate itself comes from SIMULATING the year first, on a discarded
 * clone ({@link priceTaxYear}), which is why nothing here has to anticipate a lumpy event, a loan
 * that matures in June or an account that runs dry in March.
 *
 * Where the run ends because the household DIED, the April that would have settled the last year
 * never comes; that balance is weighed against estate assets instead, once, after the loop
 * ({@link import("./estateSettlement").settleEstate}). The
 * pre-flow state is captured once as {@link ProjectionSeries.opening}; every entry in `months` is
 * a real, processed month, `months[i]` folding in `months[i-1]`'s flows plus its own.
 */
export function simulateHousehold(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const state = initSimState(input);
  const run: RunContext = { input, jurisdiction, startYear, mode: "authoritative" };
  // "Now", before any flow: the net-worth chart's first point and the baseline every
  // processed month builds on. Captured before the loop mutates state; carries no flows.
  const opening = snapshotMonth(state, {
    month: 0,
    // "Now" itself: nothing has elapsed, so real dollars equal nominal here.
    elapsedMonths: 0,
    annualInflationRate: input.annualInflationRate,
    isInsolvent: false,
    uncoveredCents: 0,
    priorInsolvency: false,
    liabilityPaymentRecords: {},
    flows: undefined,
  });
  const months: ProjectionMonth[] = [];
  // Insolvency is terminal for net-worth reporting: the month that exhausts all credit, and
  // every month after it, reports net worth as null. The insolvent month is included because
  // it is already contaminated — see {@link snapshotMonth}.
  let priorInsolvency = false;
  // A block is terminal for the whole simulation: the blocked month is emitted and completed, then
  // the loop stops. Set once, in the first month a funding draw falls short.
  let blockingObligation: ProjectionSeries["blockingObligation"];
  // Every event whose draw the block omitted — the blocker and the same-month draws after it,
  // whose artifacts were suppressed alongside its own. Captured with `blockingObligation`.
  let omittedSourceEventIds: ProjectionSeries["omittedSourceEventIds"];
  // Every explicit obligation actually resolved (money moved, attribution recorded) across every
  // month the loop ran — the ground truth `classifyObligationOutcomes` reports outcomes from,
  // never a month comparison.
  const resolvedObligationIds = new Set<ObligationId>();

  // `< horizonMonths` (not `<=`): the opening snapshot is no longer an array slot, so the
  // same span now yields exactly `horizonMonths` processed months, `month` 0-based.
  for (let month = 0; month < input.horizonMonths; month++) {
    const outcome = runMonth(state, run, month, priorInsolvency);
    for (const id of outcome.resolvedObligationIds) resolvedObligationIds.add(id);
    // `authoritative` mode always reports; the non-null assertion is the mode contract.
    months.push(outcome.snapshot!);
    if (outcome.isInsolvent) priorInsolvency = true;

    // Truncate at the first blocked month: it ran to completion (income, tax, cascade, compounding
    // above) with only the blocking obligation and its artifacts omitted, and its net worth is a
    // genuine end-of-month figure. Nothing after it is simulated — a truncated curve the caller can
    // trust beats an extended one it cannot.
    if (outcome.block !== undefined) {
      const { obligation, requiredCents, availableCents, shortfallCents, fundingFailure } =
        outcome.block;
      // The just-pushed blocked month's genuine net worth, dropped by the shortfall for the marker.
      // `null` when the month has no stated net worth (also insolvent) — the offset has no anchor.
      const blockedNetWorth = months[months.length - 1]?.netWorthNominalCents ?? null;
      blockingObligation = {
        obligationId: obligation.id,
        ...(obligation.sourceEventId !== undefined
          ? { sourceEventId: obligation.sourceEventId }
          : {}),
        label: obligation.label,
        month,
        requiredCents,
        availableCents,
        shortfallCents,
        fundingFailure,
        markerNetWorthCents: blockedNetWorth === null ? null : blockedNetWorth - shortfallCents,
      };
      // Insertion order from `resolveFundingDraws` is resolution order, so the blocking event leads.
      omittedSourceEventIds = [...outcome.omittedSourceEventIds];
      break;
    }
  }

  const blockedAtMonth = blockingObligation?.month;

  // The run reached the month the household ends, so there is an estate to settle: the final tax
  // year is finished, every balance is where death left it, and what remains is arithmetic on that
  // state — no month, no waterfall, no second pass. Only for a run the caller sized by the
  // household's own lifetime and that reached the end of it; a horizon stopping early, running
  // past the last death, or truncated by a block is not a death, and says so by settling nothing.
  const diedAtHorizon =
    blockedAtMonth === undefined &&
    input.householdDeathMonthExclusive === input.horizonMonths &&
    months.length === input.horizonMonths;
  const finalMonth = months.length - 1;
  const estateSettlement: EstateSettlement | undefined = diedAtHorizon
    ? settleEstate(state, jurisdiction, { year: startYear + Math.floor(finalMonth / 12) }, finalMonth)
    : undefined;

  return {
    opening,
    months,
    status: blockedAtMonth !== undefined ? "blocked" : "ran-to-horizon",
    ...(estateSettlement !== undefined ? { estateSettlement } : {}),
    // The last emitted month's index; equals `blockedAtMonth` when blocked, since the loop breaks
    // right after pushing that month.
    simulatedThroughMonth: months.length - 1,
    ...(blockedAtMonth !== undefined ? { blockedAtMonth } : {}),
    ...(blockingObligation !== undefined ? { blockingObligation } : {}),
    ...(omittedSourceEventIds !== undefined ? { omittedSourceEventIds } : {}),
    obligationOutcomes: classifyObligationOutcomes(
      state.fundingDraws,
      resolvedObligationIds,
      blockingObligation,
    ),
  };
}
