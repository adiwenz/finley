/**
 * Model simplifications the engine deliberately makes around post-tax accounting
 * (§#94), surfaced so a consumer (the app) can disclose them — there should be no
 * tax effect a user can see in the numbers but not find explained. Each entry is
 * co-located by `id` with the code that embodies it (see the referencing comments
 * in `simulate.ts`); this is the single machine-readable list the report carries.
 *
 * Scope: the two basis-related simplifications from #94. It is intentionally NOT a
 * catalog of every documented simplification in the engine (year-boundary timing,
 * RMD forward-projection, SS indexing live as code comments); add to this list as
 * more model behavior warrants user-facing disclosure.
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
];
