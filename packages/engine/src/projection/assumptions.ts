/**
 * Model simplifications visible in the numbers, surfaced so the app can disclose them.
 * Each entry is co-located by `id` with the code embodying it (`simulate.ts`,
 * `waterfall.ts`).
 *
 * NEUTRAL simplifications only — a jurisdiction's own caveats ride its
 * {@link import("../jurisdiction/jurisdiction").Jurisdiction.modelAssumptions} and the report
 * concatenates the two, so no US fact leaks into the neutral engine. Not exhaustive:
 * year-boundary timing and RMD forward-projection stay as code comments.
 */
export interface ModelAssumption {
  /** Stable — consumers key, dedupe and style on it. */
  readonly id: string;
  /** Safe to render verbatim to an end user. */
  readonly text: string;
}

export const MODEL_ASSUMPTIONS: readonly ModelAssumption[] = [
  {
    id: "postTaxOpeningBasis",
    text:
      "Money already in a post-tax account at the start is treated as all principal " +
      "(cost basis equals the opening balance, no built-in gain). Withdrawals are " +
      "taxed only on growth from today forward, so tax is understated for an account " +
      "that already holds unrealized gains.",
  },
  {
    id: "contributionsNotAssetFunded",
    text:
      "A recurring contribution into an account (for example auto-investing into a " +
      "brokerage) is a committed monthly outflow: the whole amount always lands in the " +
      "account, and whatever your income and cash can't cover is treated as borrowed. " +
      "Unlike ordinary spending — which the plan funds by selling investments when income " +
      "runs short — a contribution is never funded by liquidating other investments (the " +
      "model won't sell one holding to feed another). So a contribution larger than you " +
      "can afford is covered only from income, cash savings, and credit, and can make the " +
      "plan unfinanceable even while investment balances remain.",
  },
  {
    id: "incomeTaxPaidAsEvenEstimates",
    text:
      "Federal income tax is worked out on your whole year's income, but paid in twelve " +
      "equal monthly instalments sized on the income the plan already knows is coming — " +
      "your pay, pensions, benefits and required withdrawals. Money the plan could not have " +
      "predicted, such as selling investments to fund a house or a one-off cost, is not " +
      "part of those instalments: the tax on it is settled in December, so that month can " +
      "show a larger payment (or a refund, if the instalments overshot). The year always " +
      "costs the same in total; only the timing within it is an approximation.",
  },
  {
    id: "retirementAgeExtendsContinuationJob",
    text:
      "Every job is authored with its own end date, and your plan's projection uses exactly " +
      "the dates you entered — no job is shortened or extended to match a retirement age. " +
      "When the plan instead ANSWERS \u201cwhen could you retire?\u201d, or previews stopping at a " +
      "particular age, it has to imagine a working life different from the one you wrote " +
      "down, and it does that the same way at every age it tries. Every job is cut off at the " +
      "age being tested, and a job due to start after it never begins. The one exception is " +
      "the job each person picked under \u201cIf your plan required working longer than " +
      "expected, which job would you continue?\u201d \u2014 once the age being tested is past that " +
      "job's own end date, it is modelled as if it never ended: it keeps its original start " +
      "date and simply runs on to that age. It is not stopped and started again, which is why " +
      "a job that has already finished can be picked \u2014 choosing it asks what would have " +
      "happened if it had carried on instead of ending. " +
      "The job you picked starts carrying on as soon as the tested age passes ITS OWN end " +
      "date, not once every job in your plan has finished. So if you planned a career to 65 " +
      "and consulting from 65 to 70, asking about 67 continues the career to 67 rather than " +
      "leaving it stopped at 65 \u2014 which means the answer changes smoothly as the age goes up, " +
      "instead of jumping the moment it clears the last job you wrote down. " +
      "Every other job keeps its planned dates, so the continued job may run alongside work " +
      "that was meant to follow it, and both are paid for those years. That overlap is " +
      "deliberate, and whenever an answer relies on it the plan says which jobs overlapped and " +
      "for which years. " +
      "Because of this, the plan you actually wrote down is never one of the ages the search " +
      "tries, so it is checked separately: \u201cCurrent plan\u201d on the Retirement panel says " +
      "whether your own dates fund you to life expectancy, and the age below it answers the " +
      "different question of how early you could stop everything. " +
      "Which job continues comes only from your answer, never from the dates: a job ending " +
      "later is not evidence it could have run longer, and a fixed-term role taken at the end " +
      "of a career is exactly the one that could not. Someone who answered \u201cdo not assume " +
      "I would work longer\u201d is never given extra work, so the plan reports that the later age " +
      "does not work rather than inventing employment nobody claimed. " +
      "Until you pick, the plan continues the job you are working now \u2014 or, if none is " +
      "running yet, the next one due to start. Adding, removing or reordering jobs never " +
      "changes a choice you have made.",
  },
];
