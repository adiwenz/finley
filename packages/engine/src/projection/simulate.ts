import type { Jurisdiction, JurisdictionContext } from "../jurisdiction";
import type { Cents } from "../money";
import { accumulateEarnings, buildGovernmentBenefitSources } from "./governmentBenefit";
import { buildRmdSources } from "./rmd";
import { buildWithdrawalSources, DEFAULT_LIQUIDATION_ORDER } from "./withdrawal";
import { buildFlows } from "./reportFlows";
import { buildObligations, automaticFundingTotal, fundedLiabilityPayments } from "./financialObligation";
import { resolveFundingAttribution, type FundingSupplyPlan } from "./resolvedFunding";
import type {
  HouseholdSimInput,
  ProjectionMonth,
  ProjectionSeries,
} from "./simulate.types";
import { initSimState } from "./runState";
import { snapshotMonth } from "./monthSnapshot";
import {
  computeLiabilityPayments,
  buildLiabilityPaymentRecords,
  applyShortfallCascade,
  advanceLiabilities,
} from "./liabilitySteps";
import { applyAssetTransfers, compoundAssets, advanceProperties } from "./assetSteps";
import { resolveFundingDraws, buildTaxableByOwner, toTaxableRecord } from "./fundingDrawStep";
import {
  buildIncomeSources,
  buildInterestAccrualSources,
  allocateMonth,
  unwindUnfundedContributions,
} from "./allocationStep";

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
  ProjectionIncomeSource,
  IncomeSourceCategory,
  ProjectionSeries,
  BlockedObligation,
  SimProperty,
} from "./simulate.types";

const DEFAULT_START_YEAR = 2026;

/**
 * Household simulator. Fixed pipeline per month, each step a named helper:
 *   3–6. allocation waterfall: per-source pre-tax deferrals, tax seam,
 *        take-home pools, shared/personal goals, surplus — plus the deficit charge
 *        that feeds the cascade                            → allocateMonth
 *     7. shortfall cascade                                 → applyShortfallCascade
 *  8–9. Asset one-time transfers, then compounding        → applyAssetTransfers / compoundAssets
 *   10. Liability transfers, interest, payments           → advanceLiabilities
 *  10b. Property appreciation                             → advanceProperties
 *   11. Snapshot                                          → snapshotMonth
 * The tax chokepoint lives inside the waterfall and nowhere else. The pre-flow state is
 * captured once as {@link ProjectionSeries.opening}; every entry in `months` is a real,
 * processed month, `months[i]` folding in `months[i-1]`'s flows plus its own.
 */
export function simulateHousehold(
  input: HouseholdSimInput,
  jurisdiction: Jurisdiction,
): ProjectionSeries {
  const startYear = input.startYear ?? DEFAULT_START_YEAR;
  const state = initSimState(input);
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

  // `< horizonMonths` (not `<=`): the opening snapshot is no longer an array slot, so the
  // same span now yields exactly `horizonMonths` processed months, `month` 0-based.
  for (let month = 0; month < input.horizonMonths; month++) {
    // Calendar year for this month's flows. Month 0 is now processed like any other, so
    // `months[0..11]` accrue a full 12 covered-earnings months in year 0 — a $5k/mo salary
    // contributes the whole $60k, closing the graph-vs-panel benefit gap. A mid-year start
    // (fewer than 12 real months left in this calendar year) is still unmodelled.
    const year = startYear + Math.floor(month / 12);
    const ctx: JurisdictionContext = { year };

    // Fold this month's covered wages into the covered-earnings record before assembling
    // income, so a claim landing this month sees them.
    accumulateEarnings(state.earningsByPerson, input.incomeSeries, month, year, jurisdiction);
    // RMDs force this year's required draw out of pre-tax accounts BEFORE the waterfall
    // runs and re-enter here as taxable ordinary income, so the withdrawal is taxed once
    // at the single chokepoint.
    const nonWithdrawalSources = [
      ...buildIncomeSources(input.incomeSeries, month),
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
    // context. Each source is grossed up over the tax its sale induces and drained here (before
    // compounding, so a drained balance does not earn this month); its net-neutral tax source
    // rides into `allocateMonth` so the gain is charged exactly once. `taxableByOwnerAfter` —
    // this base with the draws' gains stacked in — is exposed on the flow view so the §4.5 gate
    // prices a candidate over its siblings the SAME way (exact under any regime).
    const fundingBase = buildTaxableByOwner(nonWithdrawalSources);
    const fundingDraw = resolveFundingDraws(state, month, jurisdiction, ctx, fundingBase);
    // A blocked draw suppresses the property and mortgage its authoring event would originate this
    // month — otherwise `advanceProperties`/`advanceLiabilities` would mint a house and a loan with
    // no cash ever leaving, which is the very fabrication blocking exists to stop. Keyed off the
    // event id the draw carries; the block is terminal, so only this month needs suppressing.
    const blockedEventId = fundingDraw.block?.obligation.sourceEventId;
    const suppressedProperties = state.properties.filter((p) => p.causedByEventId === blockedEventId);
    const suppressedPropertyIds = new Set(
      blockedEventId !== undefined ? suppressedProperties.map((p) => p.id) : [],
    );
    const suppressedLiabilityIds = new Set(
      blockedEventId !== undefined
        ? suppressedProperties.flatMap((p) =>
            p.mortgageLiabilityId != null ? [p.mortgageLiabilityId] : [],
          )
        : [],
    );

    // Snapshot balances/basis at THIS seam — after the explicit draws sold their sources, before
    // decumulation liquidates anything — because that is the state a would-be money-out event
    // resolves against. `resolveFundingDraws` has already written the sibling draws; decumulation
    // and this month's `compoundAssets` have not, so the end-of-month snapshot would understate
    // what an appended candidate can draw from an account decumulation later drains.
    const accountBalancesAfterFundingCents: Record<string, Cents> = {};
    const accountBasisAfterFundingCents: Record<string, Cents> = {};
    for (const acc of state.accounts) {
      accountBalancesAfterFundingCents[acc.id] = state.assetBalances.get(acc.id) ?? 0;
      accountBasisAfterFundingCents[acc.id] = state.basisByAccount.get(acc.id) ?? 0;
    }

    // Decumulation then operates on the balances the explicit draws left behind: when
    // non-withdrawal income can't cover the month's automatic obligations, liquidate investment
    // accounts BEFORE the waterfall — same seam as RMD/benefit. Its gap is still sized on the
    // automatic total (explicit obligations excluded); only the assets left to close it have
    // shrunk, and any shortfall spills to the credit cascade. Its gains stack on the explicit
    // draws' via `taxableByOwnerAfter`, so the month's capital-gains tax is charged once,
    // marginally, in resolution order. RMD income is already counted, so the draw never
    // double-withdraws.
    const withdrawal = buildWithdrawalSources(
      state,
      jurisdiction,
      nonWithdrawalSources,
      automaticFundingCents,
      ctx,
      DEFAULT_LIQUIDATION_ORDER,
      fundingDraw.taxableByOwnerAfter,
    );
    const incomeSources = [...nonWithdrawalSources, ...withdrawal.sources];
    const allocationSources = [...incomeSources, ...fundingDraw.taxSources];

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
    } = allocateMonth(state, allocationSources, ctx, jurisdiction, automaticFundingCents, month);
    // Snapshot every cascade card's balance before the cascade runs, so the REAL amount it
    // borrows onto credit (see below) is measured off actual liability movement rather than
    // re-derived from the pre-allocation withdrawal sizing pass, which is estimated off
    // `netIncomeCents` and can miss a shortfall only `allocateMonth`'s exact tax math finds —
    // a residual the liquid buffer alone (with room to spare) absorbs without a card ever
    // being touched.
    const cascadeCardBalancesBeforeCents = new Map(
      state.cascadeCards.map((card) => [card.id, state.liabilityBalances.get(card.id) ?? 0]),
    );
    // Nothing — savings or credit — could absorb this: the terminal flag.
    const uncoveredCents = applyShortfallCascade(state, month);
    const isInsolvent = uncoveredCents > 0;
    // What the cascade actually moved onto a card this month, in real cents — ground truth for
    // the "credit" layer below, independent of any estimate.
    const borrowedOntoCreditCents = state.cascadeCards.reduce(
      (total, card) =>
        total +
        Math.max(
          0,
          (state.liabilityBalances.get(card.id) ?? 0) - (cascadeCardBalancesBeforeCents.get(card.id) ?? 0),
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

    applyAssetTransfers(state, month);
    compoundAssets(state, month, jurisdiction, ctx);
    advanceLiabilities(state, month, appliedLiabilityPayments, suppressedLiabilityIds);
    advanceProperties(state, month, suppressedPropertyIds);
    const paymentRecords = buildLiabilityPaymentRecords(payments);
    const bands = buildFlows(
      // The down-payment gain bands are reporting-only: `cashInflowCents` the gain, no
      // waterfall inflow — its tax already rode the net-neutral source through allocation.
      [...incomeSources, ...fundingDraw.gainSources],
      taxCents,
      // The very list the waterfall funded above, re-shaped into the flow record — expenses,
      // debt and per-line rollups all derive from it, so none can drift from the funded amount.
      obligations,
      // The withdrawal channel's liquid-buffer drawdown PLUS a down payment's returned
      // principal (and any cash source's whole draw) — one `savingsDrawdown` source, so a
      // month spent from savings isn't a zero band.
      withdrawal.liquidDrawdownCents + fundingDraw.principalDrawdownCents,
      // Undefined when the jurisdiction declines a breakdown; the app then draws one band.
      taxByCategoryCents,
      // The finer per-SOURCE splits, so a chart can band tax by job and show take-home
      // per source.
      taxBySourceCents,
      deferralBySourceCents,
      // Employee payroll tax (FICA) — its own line, already removed from take-home.
      payrollTaxCents,
      // The finer per-SOURCE payroll-tax splits, mirroring `taxBySourceCents`.
      payrollTaxBySourceCents,
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

    months.push(
      snapshotMonth(state, {
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
    );
    if (isInsolvent) priorInsolvency = true;

    // Truncate at the first blocked month: it ran to completion (income, tax, cascade, compounding
    // above) with only the blocking obligation and its artifacts omitted, and its net worth is a
    // genuine end-of-month figure. Nothing after it is simulated — a truncated curve the caller can
    // trust beats an extended one it cannot.
    if (fundingDraw.block !== undefined) {
      const { obligation, requiredCents, availableCents, shortfallCents } = fundingDraw.block;
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
        markerNetWorthCents: blockedNetWorth === null ? null : blockedNetWorth - shortfallCents,
      };
      break;
    }
  }

  const blockedAtMonth = blockingObligation?.month;
  return {
    opening,
    months,
    status: blockedAtMonth !== undefined ? "blocked" : "ran-to-horizon",
    // The last emitted month's index; equals `blockedAtMonth` when blocked, since the loop breaks
    // right after pushing that month.
    simulatedThroughMonth: months.length - 1,
    ...(blockedAtMonth !== undefined ? { blockedAtMonth } : {}),
    ...(blockingObligation !== undefined ? { blockingObligation } : {}),
  };
}
