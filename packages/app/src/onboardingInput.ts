/**
 * Turns the five onboarding answers into a whole scenario.
 *
 * The output is a declarative {@link ScenarioInput} run through `Projection.fromInput`, exactly
 * as the starter presets are — so onboarding replays through the engine's own authoring and can
 * never smuggle in a plan the ordinary surfaces would reject, or hand-write an id.
 *
 * Where an answer does not reach, the plan takes the same defaults a fresh plan does. Onboarding
 * asks five questions because five is what it takes to draw a first projection worth reacting
 * to; everything else is a default the reader can find and change later, not a question they
 * were made to answer before seeing anything.
 */

import { dollarsToCents, Projection, type ProjectionState, type ScenarioInput } from "@finley/engine";
import type { BudgetLineEntry } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "./config";
import { defaultBudgetTemplate } from "./components/baseAdjustments/budgetTemplate";

/** What the single onboarding page collects. Every field is a plain number or a two-way choice. */
export interface OnboardingAnswers {
  readonly age: number;
  readonly partnered: boolean;
  /** Household, yearly, before tax. */
  readonly annualIncomeDollars: number;
  /** Household, monthly, everything included. */
  readonly monthlySpendDollars: number;
  /** Cash, savings and investments together. Debt and property come later. */
  readonly savingsDollars: number;
}

export const DEFAULT_ANSWERS: OnboardingAnswers = {
  age: 32,
  partnered: false,
  annualIncomeDollars: 85_000,
  monthlySpendDollars: 3_800,
  savingsDollars: 40_000,
};

/** The age a fresh plan proposes stopping work at. The reader's to move, per job, afterwards. */
const CONVENTIONAL_STOP_AGE = 65;
const WORK_START_AGE = 18;
const DEFAULT_LIFE_EXPECTANCY = 90;
const BENEFIT_CLAIMING_AGE = 67;

/**
 * How a partnered household's income is split when we have only one figure for both.
 *
 * A 60/40 split rather than 50/50: an even split is the one shape that is almost never true, and
 * it makes the two earners interchangeable on every chart that separates them. Skewed slightly,
 * the reader immediately sees which line is whose and corrects it — which is the point of showing
 * a first projection at all.
 */
const PRIMARY_INCOME_SHARE = 0.6;

/**
 * The starter budget, rescaled so its total matches what the reader said they spend.
 *
 * Scaling the template beats replacing it with one "Everything" line: the reader arrives at a
 * budget with the right shape AND the right total, and editing a category is then a small
 * correction rather than authoring six lines from nothing. Rounding drift lands on the last
 * line so the parts still sum to the stated total.
 */
function scaledBudget(monthlySpendDollars: number): readonly BudgetLineEntry[] {
  const template = defaultBudgetTemplate();
  const templateTotal = template.reduce(
    (sum, line) =>
      sum + (line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0),
    0,
  );
  const target = dollarsToCents(monthlySpendDollars);
  if (templateTotal <= 0) return template as readonly BudgetLineEntry[];

  let assigned = 0;
  return template.map((line, index) => {
    const base = line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;
    const last = index === template.length - 1;
    const cents = last ? target - assigned : Math.round((base / templateTotal) * target);
    assigned += cents;
    return {
      ...line,
      target: { kind: "expense" as const },
      amountSource: { kind: "literal" as const, monthlyCents: cents },
    };
  });
}

export function onboardingInput(answers: OnboardingAnswers): ScenarioInput {
  const birthYear = START_YEAR - answers.age;
  const careerStart = birthYear + WORK_START_AGE;
  const careerEnd = birthYear + CONVENTIONAL_STOP_AGE;
  const annualCents = dollarsToCents(answers.annualIncomeDollars);
  const primaryCents = answers.partnered
    ? Math.round(annualCents * PRIMARY_INCOME_SHARE)
    : annualCents;

  // Salary is held flat in real terms: the reader stated what they earn, not a trend. Someone
  // who worked their way up says so with dated pay changes — a visible act, never a default.
  const salary = (cents: number) => ({
    startingSalaryCents: cents,
    currentSalaryCents: cents,
    realGrowthPct: 0,
  });

  return {
    name: "You",
    startYear: START_YEAR,
    birthYear,
    lifeExpectancy: DEFAULT_LIFE_EXPECTANCY,
    benefitClaimingAge: BENEFIT_CLAIMING_AGE,
    jobs: [{ startYear: careerStart, endYear: careerEnd, salary: salary(primaryCents) }],
    budgetLines: scaledBudget(answers.monthlySpendDollars),
    openingBalanceCents: dollarsToCents(answers.savingsDollars),
    savingsReturnPct: 1,
    retirementReturnPct: 7,
    brokerageReturnPct: 7,
    sharedScheme: "proportional",
    inflationPct: 3,
    // No goals: onboarding never asked what the reader is saving towards, and inventing two
    // would put targets they did not set in front of them on the first screen.
    goals: [],
    events: answers.partnered
      ? [
          {
            type: "startPartnered",
            // Already together as of now — onboarding asked whether, not since when, so the
            // anchor sits one month back: the shortest past that makes it a standing fact.
            partneredForMonths: 1,
            name: "Partner",
            birthYear,
            lifeExpectancy: DEFAULT_LIFE_EXPECTANCY,
            benefitClaimingAge: BENEFIT_CLAIMING_AGE,
            jobs: [
              {
                startYear: careerStart,
                endYear: careerEnd,
                salary: salary(annualCents - primaryCents),
              },
            ],
          },
        ]
      : [],
  };
}

/**
 * Build the answers into projection state, or say why they were refused.
 *
 * Returns a reason rather than throwing: onboarding is the one surface where a bad number is the
 * reader's ordinary mistake (an age of 0, spending far past income), and it should be shown to
 * them on the page they are standing on.
 */
export function onboardingState(
  answers: OnboardingAnswers,
): { readonly ok: true; readonly state: ProjectionState } | { readonly ok: false; readonly reason: string } {
  const built = Projection.fromInput(onboardingInput(answers), usJurisdiction);
  if (!built.ok) return { ok: false, reason: built.error.reason };
  return { ok: true, state: built.projection.toState() };
}
