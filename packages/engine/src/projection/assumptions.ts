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
];
