/**
 * @finley/engine — the public, pure financial-simulation engine.
 *
 * The whole public surface is the {@link Projection} facade in `./projectionRoot`: the class,
 * the input/result/authored-model types a consumer names, and the open-core seam (the
 * `Jurisdiction` interface, its context types, and `nullJurisdiction`) the `rules` package
 * implements against. Everything else — the simulator, the ledger, the waterfall, the
 * snapshot/report pipeline, the authoring transforms — is internal and reached by relative path
 * from inside this package only. `index.guard.test.ts` holds this file to exactly one re-export
 * so the barrel cannot silently re-widen.
 *
 * Depends on nothing app- or rules-specific: it defines the jurisdiction interface and runs
 * standalone with the null jurisdiction. Purity enforced by `scripts/check-engine-purity.mjs`.
 */
export * from "./projectionRoot";
