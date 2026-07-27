/**
 * Allocation waterfall — pipeline step 3 in detail (§5.0).
 *
 * ONE opinionated, FIXED-structure waterfall — not a pile of configurable knobs.
 * The order is never user-rearrangeable; exactly four levers are exposed
 * (§5.0 RESOLVED):
 *   1. each person's pre-tax deferral % (per income source's `planDescriptor`),
 *   2. the shared-contribution scheme (proportional default / even split),
 *   3. the goal priority order,
 *   4. the surplus-cash destination (idle-in-liquid default / swept-to-investment).
 *
 * Per month, in strict order:
 *   1. Per-income-source pre-tax deferrals come off each source's gross first.
 *      Only sources carrying a `planDescriptor` (§5.5) defer; a source without one
 *      defers nothing. Each person's combined deferral is capped at the shared
 *      annual IRS limit (§5.4); overflow re-enters the waterfall as taxable cash.
 *   2. gross − deferral = taxable → `computeTaxCents` (§5.3 seam 1) → take-home.
 *      Non-wage income (government benefit/alimony/dividends) has no `planDescriptor`, so it enters
 *      POST-deferral yet still feeds the taxable pool (placement reads
 *      `planDescriptor`; taxation reads `taxCategory` — never conflated).
 *   3. Shared obligations are split across people by the scheme (proportional to
 *      take-home by default, or even). A share a person cannot cover is a shortfall
 *      (§5.1) — never silently absorbed by the other partner.
 *   4. Shared goals funded from the combined discretionary pool in priority order.
 *   5. Each person's remaining leftover funds their own personal goals.
 *   6. Whatever remains lands in the surplus destination.
 *
 * This module is pure: it takes a month's resolved figures and returns per-account
 * deposits plus the household shortfall. The simulator applies the deposits and
 * routes the shortfall through the §5.1 cascade.
 */

import { splitEven, type Cents } from "../money";
import type { TaxCategory } from "../cashFlowSeries";
import {
  addCategory,
  attributeTaxToSources,
  type SourceTaxable,
  type TaxableByCategory,
} from "./taxAttribution";
import type { SimGoal } from "../goal";
import { requiredContributionCents } from "../requiredContribution";
import type { WaterfallInput, WaterfallResult } from "./waterfall.types";
import {
  assertPersonTaxBreakdownReconciles,
  assertTaxAttributionReconciles,
} from "./waterfallInvariants";

// The separately-tested reconciliation invariants now live in ./waterfallInvariants;
// re-exported here so the engine barrel keeps exposing them unchanged.
export { assertPersonTaxBreakdownReconciles, assertTaxAttributionReconciles };

// The waterfall's public type block now lives in ./waterfall.types; re-exported here so
// existing importers (and the engine barrel in index.ts) keep resolving them through
// ./waterfall unchanged.
export type {
  PlanDescriptor,
  IncomeSourceMonth,
  SharedContributionScheme,
  SurplusDestination,
  WaterfallInput,
  WaterfallResult,
} from "./waterfall.types";

/** Add `amount` to `map[key]` (creating the entry at 0 first). */
function addDeposit(map: Map<string, Cents>, accountId: string, amount: Cents): void {
  if (amount === 0) return;
  map.set(accountId, (map.get(accountId) ?? 0) + amount);
}

/**
 * Step 1 — per-income-source pre-tax deferrals, capped per person against the
 * annual limit (§5.4). Writes each deferral plus its employer match into
 * `deposits`; returns each person's summed gross, their taxable amount broken down
 * by {@link TaxCategory} (the full per-source gross, minus any pre-tax deferral,
 * booked under the source's own category — the jurisdiction later applies whatever
 * inclusion % each category deserves), and the amount actually deferred. Overflow
 * past the cap is simply not deferred: it stays in the person's gross and re-enters
 * the waterfall as taxable take-home (§5.0 RESOLVED).
 */
function applyDeferrals(
  input: WaterfallInput,
  deposits: Map<string, Cents>,
): {
  grossByPerson: Map<string, Cents>;
  taxableByPerson: Map<string, TaxableByCategory>;
  sourceTaxableByPerson: Map<string, SourceTaxable[]>;
  deferralBySource: Map<string, Cents>;
  deferredByPerson: Map<string, Cents>;
} {
  const roomRemaining = new Map<string, number>();
  for (const pid of input.personIds) roomRemaining.set(pid, input.remainingDeferralRoomCents(pid));

  const grossByPerson = new Map<string, Cents>();
  const taxableByPerson = new Map<string, TaxableByCategory>();
  // Per person, each source's taxable weight (for the per-source tax split), and the
  // household deferral keyed the same way (both keyed by `sourceId` ?? tax category, the
  // reporting key the income side bands on — see `buildFlows`).
  const sourceTaxableByPerson = new Map<string, SourceTaxable[]>();
  const deferralBySource = new Map<string, Cents>();
  const deferredByPerson = new Map<string, Cents>();
  const taxableFor = (pid: string): TaxableByCategory => {
    let m = taxableByPerson.get(pid);
    if (m === undefined) {
      m = {};
      taxableByPerson.set(pid, m);
    }
    return m;
  };
  for (const src of input.incomeSources) {
    grossByPerson.set(src.ownerId, (grossByPerson.get(src.ownerId) ?? 0) + src.waterfallInflowCents);
    const sourceKey = src.sourceId ?? src.taxCategory;

    let deferred = 0;
    if (src.planDescriptor && src.waterfallInflowCents > 0) {
      const desired = Math.round(src.waterfallInflowCents * src.planDescriptor.deferralFraction);
      const room = roomRemaining.get(src.ownerId) ?? Infinity;
      deferred = Math.max(0, Math.min(desired, room));
      if (deferred > 0) {
        roomRemaining.set(src.ownerId, room - deferred);
        deferredByPerson.set(src.ownerId, (deferredByPerson.get(src.ownerId) ?? 0) + deferred);
        deferralBySource.set(sourceKey, (deferralBySource.get(sourceKey) ?? 0) + deferred);
        const match = Math.round(deferred * (src.planDescriptor.employerMatchFraction ?? 0));
        addDeposit(deposits, src.planDescriptor.fundAccountId, deferred + match);
      }
    }

    // The taxable base for this source is its gross (or its explicit `taxableCents`
    // when the taxable amount differs from the cash — a returned-basis fund draw or
    // an accrued-interest booking, #94) booked under its own provenance category,
    // less any pre-tax deferral (which reduces taxable income from that same source).
    // The jurisdiction's tax seam applies each category's inclusion % — the whole
    // gross is still paid out as take-home below.
    const sourceTaxable = Math.max(0, (src.taxableCents ?? src.waterfallInflowCents) - deferred);
    addCategory(taxableFor(src.ownerId), src.taxCategory, sourceTaxable);
    // Record this source's taxable weight so its share of the category's tax can be
    // attributed back to it below (§5.3, #110). The weight is exactly the amount added
    // to the category total, so the per-source split reconciles to the category tax.
    if (sourceTaxable > 0) {
      let list = sourceTaxableByPerson.get(src.ownerId);
      if (list === undefined) {
        list = [];
        sourceTaxableByPerson.set(src.ownerId, list);
      }
      list.push({ key: sourceKey, category: src.taxCategory, taxableCents: sourceTaxable });
    }
  }
  return { grossByPerson, taxableByPerson, sourceTaxableByPerson, deferralBySource, deferredByPerson };
}

/**
 * Step 2 — each person's taxable-by-category map is taxed through the single §5.3
 * seam to give take-home. `computeTaxCents` is called ONCE per person and nowhere
 * else: the whole point of the seam is that no tax logic lives in the allocation
 * code — the jurisdiction decides how much of each category is taxed. Take-home is
 * charged against the FULL gross (a partially-taxed benefit still pays its whole
 * check), and the gross minus deferral was fed per-category to the seam (§5.4).
 */
function computeTakeHome(
  input: WaterfallInput,
  grossByPerson: Map<string, Cents>,
  taxableByPerson: Map<string, TaxableByCategory>,
  sourceTaxableByPerson: Map<string, SourceTaxable[]>,
  deferredByPerson: Map<string, Cents>,
): {
  taxCents: Cents;
  takeHomeByPerson: Map<string, Cents>;
  taxByCategoryCents: TaxableByCategory;
  taxBySourceCents: Record<string, Cents>;
} {
  const breakdownSeam = input.computeTaxByCategoryCents;
  let taxCents: Cents = 0;
  // The breakdown seam is required (a zero-tax jurisdiction returns `{}`), so the household
  // breakdown is always accumulated — empty in a zero-tax month, reconciling otherwise.
  const taxByCategoryCents: TaxableByCategory = {};
  const taxBySourceCents: Record<string, Cents> = {};
  const takeHomeByPerson = new Map<string, Cents>();
  for (const pid of input.personIds) {
    const gross = grossByPerson.get(pid) ?? 0;
    const deferral = deferredByPerson.get(pid) ?? 0;
    const taxable = taxableByPerson.get(pid) ?? {};
    // Take-home is ALWAYS charged against the scalar total: the breakdown is purely a
    // reporting re-description whose Σ equals this same figure (the seam's contract).
    const tax = input.computeTaxCents(taxable);
    taxCents += tax;
    const perCategory = breakdownSeam(taxable);
    // Per-person invariant FIRST — before aggregating — so an offsetting pair of per-person
    // errors can't cancel in the household total and slip past the household check below.
    assertPersonTaxBreakdownReconciles(pid, tax, perCategory);
    for (const [category, cents] of Object.entries(perCategory)) {
      if (cents) addCategory(taxByCategoryCents, category as TaxCategory, cents);
    }
    attributeTaxToSources(perCategory, sourceTaxableByPerson.get(pid) ?? [], taxBySourceCents);
    takeHomeByPerson.set(pid, gross - deferral - tax);
  }
  return { taxCents, takeHomeByPerson, taxByCategoryCents, taxBySourceCents };
}

/**
 * Step 3 — split shared obligations across people by the scheme, then take each
 * person's share out of their take-home. Only positive take-home can contribute;
 * a share a person cannot cover becomes a household shortfall (§5.1), never
 * silently absorbed by the other partner. Returns each person's leftover, the
 * combined discretionary pool, and the shortfall.
 *
 * A NEGATIVE take-home is a real cash need, not nothing: it means this person's DEDUCTIONS
 * (`deferralCents + taxCents`) exceeded the cash that actually reached the allocation
 * waterfall (`waterfallInflowCents`). The usual cause today is tax on cash credited OUTSIDE
 * the waterfall — a savings-interest booking taxes $X while contributing $0 of
 * `waterfallInflowCents`, since the account was already credited — but the treatment is
 * deliberately cause-agnostic. It is the HOUSEHOLD's to pay, so it is first covered from the
 * combined discretionary pool (a partner's surplus pays it before any asset is touched); only
 * the part no household cash can cover falls to the §5.1 cascade (drain savings → credit →
 * insolvency), like an unmet obligation. Clamping it to 0 instead — the old behaviour —
 * silently dropped it: with no other cash reaching the waterfall the deduction was reported
 * but never drawn from the balance, so the ending balance overstated wealth by that amount
 * (and a genuinely unpayable bill never surfaced as insolvency).
 */
function splitSharedObligation(
  input: WaterfallInput,
  takeHomeByPerson: Map<string, Cents>,
): { leftoverByPerson: Map<string, Cents>; totalDiscretionary: Cents; shortfallCents: Cents } {
  const positiveTakeHome = new Map<string, Cents>();
  let totalPositive: Cents = 0;
  // Deductions (deferral + tax) that exceeded the cash reaching the waterfall this month — a
  // person's take-home gone negative — summed across the household. Cause-agnostic (today
  // usually tax on out-of-waterfall cash like savings interest); a real cash need the §5.1
  // cascade must fund, folded into the shortfall below.
  let unfundedDeductionsCents: Cents = 0;
  for (const pid of input.personIds) {
    const rawTakeHomeCents = takeHomeByPerson.get(pid) ?? 0;
    positiveTakeHome.set(pid, Math.max(0, rawTakeHomeCents));
    totalPositive += Math.max(0, rawTakeHomeCents);
    unfundedDeductionsCents += Math.max(0, -rawTakeHomeCents);
  }

  const shareByPerson = new Map<string, Cents>();
  if (input.sharedObligationCents <= 0) {
    for (const pid of input.personIds) shareByPerson.set(pid, 0);
  } else if (input.sharedScheme === "even") {
    const shares = splitEven(input.sharedObligationCents, Math.max(1, input.personIds.length));
    input.personIds.forEach((pid, i) => shareByPerson.set(pid, shares[i] ?? 0));
  } else if (totalPositive <= 0) {
    // Proportional with zero total income: short-circuit the 0/0. Nobody can
    // contribute; the whole obligation is a shortfall (§5.0 RESOLVED).
    for (const pid of input.personIds) shareByPerson.set(pid, 0);
  } else {
    // Proportional to take-home, distributed with cumulative rounding so the
    // shares sum to the obligation exactly.
    let prevCum = 0;
    let acc = 0;
    for (const pid of input.personIds) {
      acc += positiveTakeHome.get(pid) ?? 0;
      const cum = Math.round((input.sharedObligationCents * acc) / totalPositive);
      shareByPerson.set(pid, cum - prevCum);
      prevCum = cum;
    }
  }

  // ── Leftover per person after covering their share; unmet share → shortfall.
  let shortfallCents: Cents = 0;
  const leftoverByPerson = new Map<string, Cents>();
  let totalDiscretionary: Cents = 0;
  for (const pid of input.personIds) {
    const th = positiveTakeHome.get(pid) ?? 0;
    const share = shareByPerson.get(pid) ?? 0;
    const covered = Math.min(share, th);
    shortfallCents += share - covered;
    const leftover = th - covered;
    leftoverByPerson.set(pid, leftover);
    totalDiscretionary += leftover;
  }
  // Any obligation not assigned to a person is unmet — this covers the proportional
  // zero-income short-circuit, where every share is 0 and the whole obligation
  // becomes a shortfall. In every other branch the shares sum to the obligation,
  // so this term is 0 and the shortfall is purely the sum of uncovered shares.
  const assignedShare = [...shareByPerson.values()].reduce((s, v) => s + v, 0);
  shortfallCents += Math.max(0, input.sharedObligationCents - assignedShare);
  // Unfunded deductions (a person whose tax/deferral exceeded the cash that reached the
  // waterfall — see the note above) are the HOUSEHOLD's to pay. Cover them from the combined
  // discretionary pool FIRST — a partner's surplus pays the tax on cash credited outside the
  // waterfall — and only the part no household cash can cover falls to the §5.1 cascade. So
  // shared available cash covers the household's obligations before savings, credit, or
  // insolvency are touched; the balance is drawn only when the household genuinely can't pay.
  const coveredByDiscretionary = Math.min(unfundedDeductionsCents, totalDiscretionary);
  totalDiscretionary -= coveredByDiscretionary;
  shortfallCents += unfundedDeductionsCents - coveredByDiscretionary;

  return { leftoverByPerson, totalDiscretionary, shortfallCents };
}

/**
 * Steps 4–6 — the #26 deadline-paced (sinking-fund) goal loop, then the surplus.
 *
 * The old strict fill-order (each priority-0 goal soaking up every dollar until full)
 * is replaced by two jobs pulled apart (§14, #26): the **deadline sets the pace** and
 * **priority is scarcity triage**. In priority order, each *dated* goal is funded up
 * to its {@link requiredContributionCents} pace — no more — so when every pace fits,
 * all goals amortize concurrently to their own deadlines and the order is a no-op;
 * only when the paces exceed the month's cash does priority decide who falls behind.
 *
 * Standing account contributions (§12) fund between the two goal passes — after every
 * dated pace, before the `asap` fill. Unlike goals they are COMMITTED: the full amount
 * always lands in the account, and the part the discretionary pool cannot cover is
 * returned as a shortfall (borrowed via the §5.1 cascade), so an unaffordable contribution
 * breaks the plan rather than silently shrinking. `asap` goals then fund fill-order from
 * whatever remains, in priority order. The exact leftover after all of that lands in the
 * surplus destination — the balancing figure, so every discretionary cent is conserved.
 *
 * Returns the total contribution shortfall (0 when every contribution fit the pool) for
 * the caller to fold into the household shortfall.
 */
function fundGoalsAndContributions(
  input: WaterfallInput,
  leftoverByPerson: Map<string, Cents>,
  totalDiscretionary: Cents,
  deposits: Map<string, Cents>,
): Cents {
  const orderedGoals = [...input.goals].sort((a, b) => a.priority - b.priority);
  const nowMonth = input.nowMonth ?? 0;
  const rateOf = input.goalFundMonthlyRate ?? (() => 0);

  let sharedPoolRemaining = totalDiscretionary;
  const personalRemaining = new Map<string, Cents>(leftoverByPerson);
  let goalDepositsTotal: Cents = 0;

  // Fund `goal` up to `cap` this month (its wanted amount — pace, or full need for an
  // asap goal), drawing from its pool: the shared discretionary pool for a shared
  // goal, or the owner's own leftover (further capped by the shared pool) for a
  // personal one. Never overfunds past target-minus-balance.
  const fundGoalUpTo = (goal: SimGoal, cap: Cents): void => {
    if (cap <= 0) return;
    const current = input.accountBalanceCents(goal.fundAccountId);
    const need = Math.max(0, goal.targetCents - current);
    const want = Math.min(need, cap);
    if (want <= 0) return;

    const owner = goal.scope === "personal" ? goal.ownerId : undefined;
    if (goal.scope === "personal" && owner === undefined) return;
    const available =
      owner === undefined
        ? sharedPoolRemaining
        : Math.min(personalRemaining.get(owner) ?? 0, sharedPoolRemaining);
    const fund = Math.min(want, available);
    if (fund <= 0) return;

    addDeposit(deposits, goal.fundAccountId, fund);
    goalDepositsTotal += fund;
    sharedPoolRemaining -= fund;
    if (owner !== undefined) {
      personalRemaining.set(owner, (personalRemaining.get(owner) ?? 0) - fund);
    }
  };

  // Pass 1 — dated goals funded to their sinking-fund pace, in priority order.
  for (const goal of orderedGoals) {
    if (goal.targetDate === "asap") continue;
    const current = input.accountBalanceCents(goal.fundAccountId);
    const monthsRemaining = goal.targetDate - nowMonth;
    const pace = requiredContributionCents(
      goal.targetCents,
      current,
      monthsRemaining,
      rateOf(goal.fundAccountId),
    );
    fundGoalUpTo(goal, pace);
  }

  // Standing account contributions (§12/§15) are a COMMITTED monthly outflow, not a
  // sweep of whatever is left over: "put $X into this account" means the full $X lands
  // in the account (like a spending line's full amount is always spent), funded from the
  // discretionary pool as far as it reaches. The part the pool cannot cover is BORROWED
  // — returned as a shortfall that the §5.1 cascade drains savings then credit to meet,
  // so a contribution beyond your means makes the plan unfinanceable exactly as
  // unaffordable spending does (you do not silently save less than you asked to). Funding
  // draws in the priority order the caller supplied, and BEFORE the asap goals below so a
  // fill-order goal cannot starve a standing saving. Conserves: the borrowed part is both
  // deposited and subtracted back as the shortfall, so `deposits − shortfall` is unchanged.
  //
  // Disclosed simplification `contributionsNotAssetFunded` (see projection/assumptions.ts):
  // the shortfall goes to savings/credit only. Unlike unaffordable SPENDING — which
  // `simulate.ts` funds by selling investments (buildWithdrawalSources) before this runs —
  // a contribution is never funded by liquidating other holdings, so it can flip the plan
  // insolvent while investment balances remain (the model won't sell one holding to feed
  // another).
  let contributionShortfall: Cents = 0;
  for (const c of input.contributions ?? []) {
    const wanted = Math.max(0, c.monthlyCents);
    if (wanted <= 0) continue;
    addDeposit(deposits, c.accountId, wanted); // the whole contribution lands in the account
    const funded = Math.min(wanted, sharedPoolRemaining); // paid from discretionary cash…
    goalDepositsTotal += funded;
    sharedPoolRemaining -= funded;
    contributionShortfall += wanted - funded; // …the rest is borrowed (a shortfall)
  }

  // Pass 2 — asap goals (no deadline, no pace) fill-order from the remainder.
  for (const goal of orderedGoals) {
    if (goal.targetDate !== "asap") continue;
    fundGoalUpTo(goal, Infinity);
  }

  // ── Surplus destination: the exact leftover after every pace (conservation).
  const surplusCents = totalDiscretionary - goalDepositsTotal;
  if (surplusCents > 0) {
    const destId =
      input.surplusDestination.kind === "swept"
        ? input.surplusDestination.accountId
        : input.liquidAccountId;
    if (destId !== null) addDeposit(deposits, destId, surplusCents);
  }
  return contributionShortfall;
}

/**
 * Run the §5.0 waterfall for a single month, as the four sequential phases named
 * in the module doc. Pure at the boundary: the shared `deposits` map is the only
 * mutable state, threaded through the phases that add to it.
 */
export function runWaterfall(input: WaterfallInput): WaterfallResult {
  const deposits = new Map<string, Cents>();

  const { grossByPerson, taxableByPerson, sourceTaxableByPerson, deferralBySource, deferredByPerson } =
    applyDeferrals(input, deposits);
  const { taxCents, takeHomeByPerson, taxByCategoryCents, taxBySourceCents } = computeTakeHome(
    input,
    grossByPerson,
    taxableByPerson,
    sourceTaxableByPerson,
    deferredByPerson,
  );
  const { leftoverByPerson, totalDiscretionary, shortfallCents } = splitSharedObligation(
    input,
    takeHomeByPerson,
  );
  // A committed contribution the discretionary pool can't cover is borrowed — its
  // shortfall joins the obligation shortfall for the §5.1 cascade (drain savings → credit
  // → insolvency), so an unaffordable auto-invest breaks the plan like unaffordable spending.
  const contributionShortfall = fundGoalsAndContributions(
    input,
    leftoverByPerson,
    totalDiscretionary,
    deposits,
  );

  // Contract: tax charged must be fully attributed to sources (or the cash-flow chart
  // silently overstates take-home). Fail loudly on an incomplete jurisdiction, never fall back.
  assertTaxAttributionReconciles(taxCents, taxBySourceCents);

  return {
    taxCents,
    taxByCategoryCents,
    taxBySourceCents,
    deferralBySourceCents: Object.fromEntries(deferralBySource),
    deferredByPersonCents: deferredByPerson,
    accountDepositsCents: deposits,
    shortfallCents: shortfallCents + contributionShortfall,
  };
}
