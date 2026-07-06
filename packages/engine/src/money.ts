/**
 * Money is integer cents, never floats (§0.1). Every monetary value in the
 * engine — balances, series values, transfers, projection points — is an
 * integer number of cents. Floating-point drift compounds over a 40-year
 * horizon, so a float must never leak into a monetary quantity.
 *
 * `Cents` is a documentation alias over `number`, not a nominal brand: it makes
 * the shared type contract read as money without forcing constructors through
 * the codebase. The invariant that these are whole integers is enforced by the
 * tests (see the "money integrity" section of the invariant suite).
 */
export type Cents = number;
