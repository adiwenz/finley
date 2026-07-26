import type { SimState } from "./runState";

/**
 * Fire each goal's disposition at its maturity (§5.2, #28). Runs at the END of the
 * target month — AFTER that month's snapshot has already recorded the fund AT its
 * target (so a goals surface reads the goal as achieved on its date) — and takes
 * effect from the next month forward:
 *  - `spend` — the accumulated fund is consumed by the event and LEAVES net worth
 *    (the balance is zeroed with no offsetting asset; a vacation / wedding).
 *  - `convertToEquity` — the fund is transferred out of the liquid accounts and
 *    reappears as an illiquid home-equity holding (a property opening at the fund's
 *    matured value, appreciating at that fund's own rate). Net worth is unchanged at
 *    the swap (§4.5), and the equity drops out of the drawable retirement nest egg
 *    for free — it is no longer a `SimAccount`, so the decumulation liquidation loop
 *    never sees it (a fuller property+mortgage model needs purchase/mortgage terms a
 *    GoalPlan does not carry — future work).
 *  - `retain` / `drawDown` — nothing fires; the money stays where it is.
 *
 * A fired goal is removed from `state.goals`, so its fund is never re-funded by the
 * waterfall, re-earmarked, or drawn again. "asap" goals have no fixed maturity month
 * and so never fire here (they are measured at the horizon end elsewhere).
 */
export function fireGoalDispositions(state: SimState, month: number): void {
  const fired = new Set<string>();
  for (const goal of state.goals) {
    if (goal.targetDate !== month) continue; // fires once, at the numeric target month
    if (goal.disposition !== "spend" && goal.disposition !== "convertToEquity") continue;
    const maturedCents = Math.max(0, state.assetBalances.get(goal.fundAccountId) ?? 0);
    state.assetBalances.set(goal.fundAccountId, 0);
    // The fund is fully drained — spent, or swapped to illiquid equity (which the
    // decumulation loop never sees, so it needs no carried basis). Zero its basis to
    // match, so a re-used account id could not resurrect stale basis (§#94). The
    // dropped basis on a convertToEquity swap is disclosed to the app as
    // MODEL_ASSUMPTIONS["convertedEquityNoBasis"] (assumptions.ts).
    state.basisByAccount.set(goal.fundAccountId, 0);
    if (goal.disposition === "convertToEquity" && maturedCents > 0) {
      const fundAccount = state.accounts.find((a) => a.id === goal.fundAccountId);
      state.properties.push({
        id: `goal-equity-${goal.id}`,
        ownerId: fundAccount?.ownerId ?? goal.ownerId ?? "household",
        startMonth: month + 1, // opens next month at its matured value (see advanceProperties)
        endMonth: null,
        openingValueCents: maturedCents,
        appreciationAnnualRate: fundAccount ? fundAccount.getRateAt(month) : 0,
      });
      state.propertyValues.set(`goal-equity-${goal.id}`, maturedCents);
    }
    fired.add(goal.id);
  }
  if (fired.size > 0) state.goals = state.goals.filter((g) => !fired.has(g.id));
}
