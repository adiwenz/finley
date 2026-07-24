/**
 * Model simplifications the engine deliberately makes — in post-tax accounting (§#94)
 * and in the allocation waterfall (§5.0/§12) — surfaced so a consumer (the app) can
 * disclose them: there should be no behaviour a user can see in the numbers but not find
 * explained. Each entry is co-located by `id` with the code that embodies it (see the
 * referencing comments in `simulate.ts` and `waterfall.ts`).
 *
 * This list holds only the engine's own NEUTRAL simplifications (§5.0) — nothing
 * jurisdiction-specific. A jurisdiction's own caveats (e.g. US tax-threshold forward
 * indexing) ride its {@link import("../jurisdiction").Jurisdiction.modelAssumptions}
 * and the report concatenates the two, so a US fact never leaks into the neutral
 * engine. Together they are the machine-readable disclosure the report carries.
 *
 * Scope: the two basis-related simplifications from #94, plus how a committed account
 * contribution is funded (§12). It is intentionally NOT a catalog of every documented
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
    id: "convertedEquityNoBasis",
    text:
      "When a goal fund is converted to home equity it becomes an illiquid holding " +
      "the projection never sells, so it carries no cost basis — a later sale of that " +
      "equity is not modeled and its gain is not taxed.",
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
