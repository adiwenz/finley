# Issue 195 — Projection authoring validates against a real jurisdiction

## Overview

`Projection`'s authoring methods routed every ledger write through `commitEvent`, which
validated against **`nullJurisdiction`** — a tax-free rule set. The app, meanwhile, validates
the same events against `usJurisdiction`. Any jurisdiction-dependent authoring gate therefore
never fired through the facade, and the clearest casualty was the §4.5 down-payment
affordability gate on `HomePurchaseEvent`: it nets a chosen set of funding accounts *after*
capital-gains tax, and under `nullJurisdiction` there is no tax, so funds look larger and a
purchase that should be refused is accepted (a **false accept**).

Per the issue's decided **option 2**, `Projection` now holds a **validation jurisdiction**
supplied at construction — required, with no default — independent of the jurisdiction `run()`
takes per call. Authoring asks "is this write permitted?"; `run()` asks "what does this
scenario look like under these rules?" — two different questions, and only the second is meant
to vary freely.

## RGR Verification Details

- **RED** — Added a `describe` block to `packages/engine/src/projectionRoot.test.ts`. A
  single high-growth brokerage goal accrues surplus into one liquid capital-gains account
  (~$96.8k by month 24, mostly embedded gain). A `$90k` down payment sourced from it is
  affordable pre-tax and short once the gain is taxed. The key failing test constructs a
  `Projection` against a `flatCapitalGains(0.5)` jurisdiction and asserts `buyHome` throws.
  Before the fix the facade ignored the construction jurisdiction and used `nullJurisdiction`,
  so the purchase was accepted — the test failed with `expected [Function] to throw an error`.
  The scenario numbers were derived empirically by probing `fundingLookup` availability under
  both jurisdictions, not by recomputing the code's own arithmetic.
- **GREEN** — Threaded a construction-time `validationJurisdiction` through `Projection`;
  `baseConfig()` and `commitEvent()`'s `addEvent` call now use it. The refusal test passes, the
  two companion tests (null accepts, `run()` stays independent) stay green.
- **Full suite** — 1075 passed / 45 todo across all packages; engine purity and typecheck clean.

## Key Decisions & Why

- **Jurisdiction as behaviour, not state.** It is a field on the `Projection` instance, passed
  beside the state at construction and **never serialised** into `ProjectionState`. A
  jurisdiction's `computeTaxCents`/`taxableWithdrawalCents` are methods, not data — mirroring
  why `ProjectionResult` already records a `jurisdictionId` string rather than the jurisdiction.
- **Required, with no default.** The issue's option 2 said "defaulting to `nullJurisdiction`, so
  the engine still runs standalone with no rules package" — but that rationale does not hold:
  `nullJurisdiction` ships *in* the engine and is barrel-exported, so `create(init,
  nullJurisdiction)` is equally standalone. The default bought nothing on the axis it was
  justified by, while leaving a silent-downgrade path: a caller who meant `usJurisdiction` and
  forgot the argument gets the tax-free answer, reintroducing by omission the exact false-accept
  this change closes. Making it required costs 23 call sites (18 in the engine's own test file)
  and makes the choice legible at every one.
- **`run()` left untouched.** It still takes its own jurisdiction per call and never consults the
  authoring one, so one scenario re-runs under any rule set — authoring under one jurisdiction
  and projecting under another stays legal, which is the point of keeping them separate.
- **Used the validation jurisdiction in `baseConfig()` too, not just `addEvent`.** The app builds
  its base with `createProjectionBase(..., { jurisdiction: usJurisdiction })` and passes
  `usJurisdiction` to `addEvent`; matching both is what makes the facade's answer identical to
  the app's.

## Changes Made

- `packages/engine/src/projectionRoot.ts`
  - New `private readonly validationJurisdiction: Jurisdiction` field; private constructor now
    takes `(state, jurisdiction)`.
  - `static create(init, jurisdiction)` and `static fromJSON(state, jurisdiction)` take it as a
    REQUIRED second argument and thread it.
  - The `nullJurisdiction` import dropped to type-only `Jurisdiction`: with no default, the module
    no longer names a fallback.
  - `baseConfig()` compiles the base under `this.validationJurisdiction`.
  - `commitEvent()` passes `this.validationJurisdiction` to `addEvent` (was `nullJurisdiction`).
  - Rewrote the class-level JSDoc to document why one object carries a jurisdiction twice, and
    updated the `baseConfig`/`commitEvent` comments.
- `packages/engine/src/projectionRoot.test.ts`
  - New describe block "authoring validates against the construction-time jurisdiction" with a
    local `flatCapitalGains` mock jurisdiction and three tests covering refusal, null-accept,
    and `run()` independence. (No default-behaviour test — there is no default.)
  - The 18 existing `create`/`fromJSON` call sites now pass `nullJurisdiction` explicitly.
- `packages/app/src/**` (2 test call sites) — pass `usJurisdiction`, matching what the app
  validates against everywhere else in those files.
- `playground.ts`, `repl.ts` — pass `nullJurisdiction` explicitly; playground's "jurisdiction NOT
  yet involved" comment on `create` was stale and is corrected.

## Verification & Testing

- `npm run check:purity` → engine purity passed (no rules import leaked into the engine).
- `npm run typecheck` → clean.
- `npx vitest run packages/engine` → **606 passed | 45 todo**.
- `npm run test` (whole workspace) → **1075 passed | 45 todo**, 85 files.
- `npx tsx playground.ts` → runs clean, confirming the non-test callers still work.
