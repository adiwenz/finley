/**
 * Model simplifications the engine deliberately makes — in post-tax accounting and in the
 * allocation waterfall — surfaced so the app can disclose them: no behaviour should be
 * visible in the numbers but unexplained. Each entry is co-located by `id` with the code
 * embodying it (referencing comments in `simulate.ts` and `waterfall.ts`).
 *
 * NEUTRAL simplifications only. A jurisdiction's own caveats (e.g. US tax-threshold
 * forward indexing) ride its
 * {@link import("../jurisdiction").Jurisdiction.modelAssumptions}, and the report
 * concatenates the two, so a US fact never leaks into the neutral engine.
 *
 * Not a catalog of every documented simplification — year-boundary timing and RMD
 * forward-projection live as code comments. Add here as more NEUTRAL behavior warrants
 * user-facing disclosure.
 */
export interface ModelAssumption {
  /** Stable identifier for the assumption — lets a consumer key/dedupe/style it. */
  readonly id: string;
  /** Plain-language disclosure, safe to render verbatim to an end user. */
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
