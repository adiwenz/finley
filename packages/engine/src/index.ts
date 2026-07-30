/**
 * @finley/engine — the public, pure financial-simulation engine.
 *
 * The whole public surface is the {@link Projection} facade in `./projectionRoot`: the handle
 * every write and read routes through, its input/result types, the authored model types, and
 * the jurisdiction interface the `rules` package implements against. Nothing else is exported —
 * the simulator, the ledger, the waterfall, the authoring transforms and every other internal
 * stay internal, reached by relative path within this package and by nothing outside it. To let
 * a consumer name something new, add it to `./projectionRoot` and justify it there, beside the
 * surface. `./index.guard.test.ts` holds this barrel to exactly the facade;
 * `packages/app/src/planWrites.guard.test.ts` holds the app to the same surface.
 *
 * Depends on nothing app- or rules-specific: it defines the jurisdiction interface and runs
 * standalone with `nullJurisdiction`. Purity enforced by `scripts/check-engine-purity.mjs`.
 */
export * from "./projectionRoot";
