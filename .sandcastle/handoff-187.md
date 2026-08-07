# Handoff — issue 187

Whole-issue mode (issue declares one all-in-one task). Self-split into 4 parts:

**Done so far:**
1. ✅ `getEligibleFundingSources` engine eligibility seam — `packages/engine/src/projection/fundingEligibility.ts`.
2. ✅ `FundingFailure` classification threaded onto `ProjectionSeries.blockingObligation.fundingFailure` — `packages/engine/src/projection/fundingFailure.ts`, wired in `fundingDrawStep.ts`, mapped in `simulate.ts`, typed in `simulate.types.ts`, exported from `index.ts`.
3. ✅ App UI: `blockedWarning`/`BlockedWarningView` in `ledgerView.ts` branch on `fundingFailure.kind`; `blockedWarning.tsx` renders distinct copy (names alternatives / no-insolvency language). `main.tsx` passes `funding` for label resolution. End-to-end AC7 in `scenarios.blockedPurchase.test.ts`. **All 8 acceptance criteria are met by this point.**

**Remaining:**
4. ⬜ Demote the authoring affordability gate (issue task text; design §9, §13). `eventHandlers.ts:303-328` (`homePurchase.check`, the "§4.5 down-payment hard block") must stop refusing on shortfall — an unaffordable purchase is ACCEPTED and reported as blocked. `fundingLookup.availabilityAt` stays as a reporter (do not delete). Blast radius: `packages/engine/src/ledger/events.homePurchase.test.ts` has `describe("HomePurchaseEvent — down-payment hard block")` and `describe("… §4.5 gate counts selected liquid goal funds")` (~lines 243-390) asserting `result.ok === false` on shortfall — these invert. Also audit `homePurchaseForm.tsx` (app) for reliance on the gate to block submit. NO AC strictly requires it (all reachable via stranding), so parts 1-3 stay green if part 4 is cut off. If you finish part 4, this is the LAST task: write `.sandcastle/summary-187.md` and delete this handoff.

## Live constraints
- `FundingFailure.availableCents`/`eligibleAvailableCents` are NET OF TAX, priced through `resolveOrderedFundingDraw` (the one primitive shared by gate + sim). Never recompute tax elsewhere.
- Engine RECOMMENDS, never chooses (AC6): `alternativeSources` is advisory; the actual draw runs in its named order untouched. Do not reorder/substitute.
- `BlockedObligation.fundingFailure` is a REQUIRED field — any literal constructing a `BlockedObligation` (e.g. `blockedMarker.test.ts`) must supply it. That is already fixed.
- Eligibility is engine-owned: the app must call `getEligibleFundingSources`, never re-filter by `liquid` itself.
- Today both treatments filter to liquid-only; the `expense`/`asset-acquisition` distinction (credit cards) is a later slice (#191). Do not add credit rules.

## Dead ends / traps
- `fundingFailure.ts` ↔ `fundingDrawStep.ts` is a deliberate lazy import cycle (classifier uses `resolveOrderedFundingDraw`; `resolveFundingDraws` calls the classifier at runtime, not module-eval). It works under vitest/vite. Don't try to "fix" it by inlining.
- The repo has NO prettier/eslint gate — `npm run check` = purity + typecheck + test only. Existing files fail `prettier --check` defaults. Match surrounding ~100-col style by hand; don't run prettier --write across files.

## Verification
Engine: 1170 tests green. `npm run check:purity`, `npm run typecheck` clean.
