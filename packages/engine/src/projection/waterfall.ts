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
 *      Non-wage income (SS/alimony/dividends) has no `planDescriptor`, so it enters
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
import type { Goal } from "../goal";

/** The 401(k)-style plan a job carries (§5.5) — presence makes it deferral-eligible. */
export interface PlanDescriptor {
  /** Fraction of THIS job's gross deferred pre-tax (0..1) — the exposed % lever. */
  readonly deferralFraction: number;
  /** Person-owned account the deferral (and any match) funds (§5.5). */
  readonly fundAccountId: string;
  /**
   * Employer match as a fraction of the amount actually deferred (e.g. 0.5 = a
   * 50% match). Employer money — it never comes out of take-home and does NOT
   * share the employee-deferral cap (§5.4).
   */
  readonly employerMatchFraction?: number;
}

/** One income source's contribution to a single month (resolved from a series). */
export interface IncomeSourceMonth {
  readonly ownerId: string;
  readonly grossCents: Cents;
  readonly taxCategory: TaxCategory;
  /** Present → eligible for pre-tax deferral (§5.0 step 1). Absent → post-deferral. */
  readonly planDescriptor?: PlanDescriptor;
}

/** Lever 2: how much each person contributes to shared obligations (§5.0 step 3). */
export type SharedContributionScheme = "proportional" | "even";

/** Lever 4: where leftover cash lands once every goal is funded (§5.0 RESOLVED). */
export type SurplusDestination =
  | { readonly kind: "idle" }
  | { readonly kind: "swept"; readonly accountId: string };

export interface WaterfallInput {
  readonly personIds: readonly string[];
  readonly incomeSources: readonly IncomeSourceMonth[];
  /** Shared obligations this month: expenses + scheduled liability payments. */
  readonly sharedObligationCents: Cents;
  readonly sharedScheme: SharedContributionScheme;
  readonly surplusDestination: SurplusDestination;
  readonly goals: readonly Goal[];
  /** Current (beginning-of-step) balance of any account — goal need is target − this. */
  readonly accountBalanceCents: (accountId: string) => Cents;
  /** The default liquid account — the `idle` surplus destination. Null if none. */
  readonly liquidAccountId: string | null;
  /**
   * §5.3 seam 1: per-{@link TaxCategory} taxable amounts in → tax owed out. Called
   * once per person with that person's full taxable-by-category map, so the
   * jurisdiction (not the waterfall) decides how each category is taxed.
   */
  readonly computeTaxCents: (taxableByCategory: Partial<Record<TaxCategory, Cents>>) => Cents;
  /**
   * §5.4 seam: a person's REMAINING annual deferral room this month (limit minus
   * what they have already deferred this year). `Infinity` = uncapped.
   */
  readonly remainingDeferralRoomCents: (personId: string) => number;
}

export interface WaterfallResult {
  readonly taxCents: Cents;
  /** Amount actually deferred per person — the caller updates its annual accumulator. */
  readonly deferredByPersonCents: ReadonlyMap<string, Cents>;
  /** Net deposit to add to each account this month (deferrals, match, goals, surplus). */
  readonly accountDepositsCents: ReadonlyMap<string, Cents>;
  /** Household cash shortfall to route through the §5.1 cascade (0 if none). */
  readonly shortfallCents: Cents;
}

/** Add `amount` to `map[key]` (creating the entry at 0 first). */
function addDeposit(map: Map<string, Cents>, accountId: string, amount: Cents): void {
  if (amount === 0) return;
  map.set(accountId, (map.get(accountId) ?? 0) + amount);
}

/** A per-person map of taxable amount by {@link TaxCategory}. */
type TaxableByCategory = Partial<Record<TaxCategory, Cents>>;

/** Add `amount` to `map[category]` (creating the entry at 0 first). */
function addCategory(map: TaxableByCategory, category: TaxCategory, amount: Cents): void {
  if (amount === 0) return;
  map[category] = (map[category] ?? 0) + amount;
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
  deferredByPerson: Map<string, Cents>;
} {
  const roomRemaining = new Map<string, number>();
  for (const pid of input.personIds) roomRemaining.set(pid, input.remainingDeferralRoomCents(pid));

  const grossByPerson = new Map<string, Cents>();
  const taxableByPerson = new Map<string, TaxableByCategory>();
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
    grossByPerson.set(src.ownerId, (grossByPerson.get(src.ownerId) ?? 0) + src.grossCents);

    let deferred = 0;
    if (src.planDescriptor && src.grossCents > 0) {
      const desired = Math.round(src.grossCents * src.planDescriptor.deferralFraction);
      const room = roomRemaining.get(src.ownerId) ?? Infinity;
      deferred = Math.max(0, Math.min(desired, room));
      if (deferred > 0) {
        roomRemaining.set(src.ownerId, room - deferred);
        deferredByPerson.set(src.ownerId, (deferredByPerson.get(src.ownerId) ?? 0) + deferred);
        const match = Math.round(deferred * (src.planDescriptor.employerMatchFraction ?? 0));
        addDeposit(deposits, src.planDescriptor.fundAccountId, deferred + match);
      }
    }

    // The taxable base for this source is its full gross booked under its own
    // provenance category, less any pre-tax deferral (which reduces taxable income
    // from that same source). The jurisdiction's tax seam applies each category's
    // inclusion % — the whole gross is still paid out as take-home below.
    addCategory(taxableFor(src.ownerId), src.taxCategory, Math.max(0, src.grossCents - deferred));
  }
  return { grossByPerson, taxableByPerson, deferredByPerson };
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
  deferredByPerson: Map<string, Cents>,
): { taxCents: Cents; takeHomeByPerson: Map<string, Cents> } {
  let taxCents: Cents = 0;
  const takeHomeByPerson = new Map<string, Cents>();
  for (const pid of input.personIds) {
    const gross = grossByPerson.get(pid) ?? 0;
    const deferral = deferredByPerson.get(pid) ?? 0;
    const tax = input.computeTaxCents(taxableByPerson.get(pid) ?? {});
    taxCents += tax;
    takeHomeByPerson.set(pid, gross - deferral - tax);
  }
  return { taxCents, takeHomeByPerson };
}

/**
 * Step 3 — split shared obligations across people by the scheme, then take each
 * person's share out of their take-home. Only positive take-home can contribute;
 * a share a person cannot cover becomes a household shortfall (§5.1), never
 * silently absorbed by the other partner. Returns each person's leftover, the
 * combined discretionary pool, and the shortfall.
 */
function splitSharedObligation(
  input: WaterfallInput,
  takeHomeByPerson: Map<string, Cents>,
): { leftoverByPerson: Map<string, Cents>; totalDiscretionary: Cents; shortfallCents: Cents } {
  const positiveTakeHome = new Map<string, Cents>();
  let totalPositive: Cents = 0;
  for (const pid of input.personIds) {
    const th = Math.max(0, takeHomeByPerson.get(pid) ?? 0);
    positiveTakeHome.set(pid, th);
    totalPositive += th;
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

  return { leftoverByPerson, totalDiscretionary, shortfallCents };
}

/**
 * Steps 4–6 — fund shared goals from the combined discretionary pool in priority
 * order, then each person's personal goals from their own leftover, then send the
 * exact remainder to the surplus destination. All of these are written into
 * `deposits`. The surplus is the balancing figure, so every discretionary cent is
 * conserved regardless of rounding.
 */
function fundGoals(
  input: WaterfallInput,
  leftoverByPerson: Map<string, Cents>,
  totalDiscretionary: Cents,
  deposits: Map<string, Cents>,
): void {
  const orderedGoals = [...input.goals].sort((a, b) => a.priority - b.priority);

  let sharedPoolRemaining = totalDiscretionary;
  const personalRemaining = new Map<string, Cents>(leftoverByPerson);
  let goalDepositsTotal: Cents = 0;

  const fundGoal = (goal: Goal, available: Cents): Cents => {
    if (available <= 0) return 0;
    const current = input.accountBalanceCents(goal.fundAccountId);
    const need = Math.max(0, goal.targetCents - current);
    const fund = Math.min(need, available);
    if (fund <= 0) return 0;
    addDeposit(deposits, goal.fundAccountId, fund);
    goalDepositsTotal += fund;
    return fund;
  };

  for (const goal of orderedGoals) {
    if (goal.scope === "shared") {
      const funded = fundGoal(goal, sharedPoolRemaining);
      sharedPoolRemaining -= funded;
    } else {
      const owner = goal.ownerId;
      if (owner === undefined) continue;
      const avail = Math.min(personalRemaining.get(owner) ?? 0, sharedPoolRemaining);
      const funded = fundGoal(goal, avail);
      personalRemaining.set(owner, (personalRemaining.get(owner) ?? 0) - funded);
      sharedPoolRemaining -= funded;
    }
  }

  // ── Surplus destination: the exact leftover after every goal (conservation).
  const surplusCents = totalDiscretionary - goalDepositsTotal;
  if (surplusCents > 0) {
    const destId =
      input.surplusDestination.kind === "swept"
        ? input.surplusDestination.accountId
        : input.liquidAccountId;
    if (destId !== null) addDeposit(deposits, destId, surplusCents);
  }
}

/**
 * Run the §5.0 waterfall for a single month, as the four sequential phases named
 * in the module doc. Pure at the boundary: the shared `deposits` map is the only
 * mutable state, threaded through the phases that add to it.
 */
export function runWaterfall(input: WaterfallInput): WaterfallResult {
  const deposits = new Map<string, Cents>();

  const { grossByPerson, taxableByPerson, deferredByPerson } = applyDeferrals(input, deposits);
  const { taxCents, takeHomeByPerson } = computeTakeHome(
    input,
    grossByPerson,
    taxableByPerson,
    deferredByPerson,
  );
  const { leftoverByPerson, totalDiscretionary, shortfallCents } = splitSharedObligation(
    input,
    takeHomeByPerson,
  );
  fundGoals(input, leftoverByPerson, totalDiscretionary, deposits);

  return {
    taxCents,
    deferredByPersonCents: deferredByPerson,
    accountDepositsCents: deposits,
    shortfallCents,
  };
}
