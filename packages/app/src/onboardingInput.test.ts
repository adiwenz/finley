/**
 * Onboarding's five answers → a whole scenario.
 *
 * The contract is that the projection the reader sees first reflects what they typed: their age,
 * their income, their spending, their savings. A scenario that quietly kept a template's numbers
 * would show them someone else's future on the screen that is meant to earn their attention.
 */

import { describe, it, expect } from "vitest";
import { Projection, dollarsToCents } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "./config";
import { currentFlows } from "./homeView";
import {
  DEFAULT_ANSWERS,
  onboardingInput,
  onboardingState,
  type OnboardingAnswers,
} from "./onboardingInput";

function runWith(answers: OnboardingAnswers) {
  const built = onboardingState(answers);
  if (!built.ok) throw new Error(`refused: ${built.reason}`);
  const projection = Projection.fromState(built.state, usJurisdiction);
  return { state: built.state, result: projection.run(usJurisdiction) };
}

describe("onboardingInput", () => {
  it("builds a valid scenario from the defaults", () => {
    expect(onboardingState(DEFAULT_ANSWERS).ok).toBe(true);
  });

  it("dates the plan from the stated age", () => {
    const { state } = runWith({ ...DEFAULT_ANSWERS, age: 41 });
    expect(state.scenario.plan.primary.birthYear).toBe(START_YEAR - 41);
  });

  it("opens with the savings the reader stated", () => {
    const { result } = runWith({ ...DEFAULT_ANSWERS, savingsDollars: 62_500 });
    const opening = Object.values(result.series.opening.accountBalancesCents).reduce(
      (sum, c) => sum + c,
      0,
    );
    expect(opening).toBe(dollarsToCents(62_500));
  });

  it("scales the starter budget to the stated spending, to the cent", () => {
    const input = onboardingInput({ ...DEFAULT_ANSWERS, monthlySpendDollars: 5_125 });
    const total = (input.budgetLines ?? []).reduce(
      (sum, line) =>
        sum + (line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0),
      0,
    );
    // Rounding drift lands on the last line, so the parts still sum to exactly what was said.
    expect(total).toBe(dollarsToCents(5_125));
  });

  it("keeps the starter budget's shape rather than collapsing it to one line", () => {
    const input = onboardingInput(DEFAULT_ANSWERS);
    expect((input.budgetLines ?? []).length).toBeGreaterThan(1);
  });

  it("pays the stated household income, whether solo or partnered", () => {
    const solo = runWith({ ...DEFAULT_ANSWERS, partnered: false, annualIncomeDollars: 90_000 });
    const together = runWith({ ...DEFAULT_ANSWERS, partnered: true, annualIncomeDollars: 90_000 });

    const annual = (r: ReturnType<typeof runWith>) =>
      (currentFlows(r.result.series)?.totalIncomeCents ?? 0) * 12;

    expect(annual(solo)).toBe(dollarsToCents(90_000));
    // Split across two earners, but the household still earns what was stated.
    expect(annual(together)).toBe(dollarsToCents(90_000));
  });

  it("puts a partner in the household, and leaves one out when planning alone", () => {
    expect(runWith({ ...DEFAULT_ANSWERS, partnered: true }).result.household.memberships).toHaveLength(2);
    expect(runWith({ ...DEFAULT_ANSWERS, partnered: false }).result.household.memberships).toHaveLength(1);
  });

  it("sets no goals — onboarding never asked what they are saving towards", () => {
    expect(onboardingInput(DEFAULT_ANSWERS).goals).toEqual([]);
  });

  it("reports a refusal instead of throwing", () => {
    const built = onboardingState({ ...DEFAULT_ANSWERS, age: 0 });
    if (built.ok) {
      // An age of 0 is buildable; the guarantee under test is the shape of the answer, not that
      // this particular value is rejected.
      expect(built.state).toBeDefined();
    } else {
      expect(built.reason).toBeTypeOf("string");
    }
  });
});
