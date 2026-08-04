/**
 * Model simplifications visible in the numbers, surfaced so the app can disclose them.
 * Each entry is co-located by `id` with the code embodying it (`simulate.ts`,
 * `waterfall.ts`).
 *
 * NEUTRAL simplifications only — a jurisdiction's own caveats ride its
 * {@link import("../jurisdiction").Jurisdiction.modelAssumptions} and the report
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
    id: "retirementAgeExtendsContinuationJob",
    text:
      "Every job is authored with its own end date, and your plan's projection uses exactly " +
      "the dates you entered — no job is shortened or extended to match a retirement age. " +
      "When the plan instead ANSWERS “when could you retire?”, or previews stopping at a " +
      "particular age, it has to imagine a working life different from the one you wrote " +
      "down, and it does that in one of two ways. Asking about an age at or before you had " +
      "planned to stop simply cuts every job off there. Asking about a LATER age means your " +
      "plan runs out of authored work before it, so one job has to carry the extra years — " +
      "the single job each person picked under “If you needed to work longer, which job " +
      "would continue?”, carried on to the age asked about. Every other job keeps its own " +
      "end date. " +
      "Which job that is comes only from that answer, never from the dates: a job ending " +
      "later is not evidence it could have run longer, and a fixed-term role taken at the " +
      "end of a career is exactly the one that could not. Someone who answered “None” is " +
      "never given extra work, so the plan reports that the later age does not work rather " +
      "than inventing employment nobody claimed. " +
      "Until you pick, the plan assumes the job you are working now — or, if none is running " +
      "yet, the next one due to start. Adding, removing or reordering jobs never changes a " +
      "choice you have made. " +
      "Whenever an answer did rely on working past what you wrote down, the plan says which " +
      "job it continued.",
  },
];
