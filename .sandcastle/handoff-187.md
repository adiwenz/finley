# Handoff — issue 187

Whole-issue mode (issue declares one all-in-one task). Self-split into 4 parts:

**Done so far:**
1. ✅ `getEligibleFundingSources` engine eligibility seam — `packages/engine/src/projection/fundingEligibility.ts`.
2. ✅ `FundingFailure` classification threaded onto `ProjectionSeries.blockingObligation.fundingFailure` — `packages/engine/src/projection/fundingFailure.ts`, wired in `fundingDrawStep.ts`, mapped in `simulate.ts`, typed in `simulate.types.ts`, exported from `index.ts`.

**Remaining:**
3. ⬜ App UI: branch the blocked warning on `fundingFailure.kind`. For `funding-configuration`, name the `alternativeSources` accounts + their available balances; for `no-eligible-source-suffices`, explain no eligible account can cover it WITHOUT insolvency language. Extend `blockedWarning` in `packages/app/src/ledgerView.ts` (`BlockedWarningView`) and `packages/app/src/components/blockedWarning/blockedWarning.tsx`. Add the end-to-end test (AC7): two scenarios → visibly different warnings, configuration case names alternatives. `packages/app/src/scenarios.blockedPurchase.test.ts` already reaches a block via STRANDING (author affordable, then `updatePlan` drains the account) — reuse that path; a funding-configuration scenario just needs a second liquid account left untouched. Invoke `/vercel-react-best-practices` for the TSX. Alternative-account labels: the engine exposes account labels only via `fundingLookup.sourcesAt(month)` (id→label) — join `alternativeSources[].accountId` to a human label there, or fall back to the id.
4. ⬜ Demote the authoring affordability gate (issue task text; design §9, §13). `eventHandlers.ts:303-328` (`homePurchase.check`, the "§4.5 down-payment hard block") must stop refusing on shortfall — an unaffordable purchase is ACCEPTED and reported as blocked. `fundingLookup.availabilityAt` stays as a reporter (do not delete). Blast radius: `packages/engine/src/ledger/events.homePurchase.test.ts` has `describe("HomePurchaseEvent — down-payment hard block")` and `describe("… §4.5 gate counts selected liquid goal funds")` (~lines 243-390) asserting `result.ok === false` on shortfall — these invert. Also audit `homePurchaseForm.tsx` (app) for reliance on the gate to block submit. Do this LAST — it is the riskiest change and no AC strictly requires it (all reachable via stranding), so parts 1-3 stay green if part 4 is cut off.

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
