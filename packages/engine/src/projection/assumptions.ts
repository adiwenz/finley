/**
 * Model simplifications the engine deliberately makes — in post-tax accounting
 * and in the allocation waterfall — surfaced so a consumer (the app) can
 * disclose them: there should be no behaviour a user can see in the numbers but not find
 * explained. Each entry is co-located by `id` with the code that embodies it (see the
 * referencing comments in `simulate.ts` and `waterfall.ts`).
 *
 * This list holds only the engine's own NEUTRAL simplifications — nothing
 * jurisdiction-specific. A jurisdiction's own caveats (e.g. US tax-threshold forward
 * indexing) ride its {@link import("../jurisdiction").Jurisdiction.modelAssumptions}
 * and the report concatenates the two, so a US fact never leaks into the neutral
 * engine. Together they are the machine-readable disclosure the report carries.
 *
 * Scope: the post-tax opening-basis simplification, plus how a committed account
 * contribution is funded. It is intentionally NOT a catalog of every documented
 * engine simplification (year-boundary timing, RMD forward-projection live as code
 * comments); add to this list as more NEUTRAL model behavior warrants user-facing disclosure.
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
  {
    id: "downPaymentAffordabilityTaxEstimate",
    text:
      "When a home purchase is funded by selling an investment, the affordability check " +
      "that decides whether you can cover the down payment estimates the capital-gains tax " +
      "on that sale on its own, without folding in your other income that month. That " +
      "estimate is exact when capital gains are taxed at a single flat rate and a close " +
      "guide under a bracketed or income-tested regime; the projection itself always taxes " +
      "the sale precisely against your whole return, so the numbers you see remain accurate " +
      "— only the accept/block affordability threshold uses the simpler estimate.",
  },
];
