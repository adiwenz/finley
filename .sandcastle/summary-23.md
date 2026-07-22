# Issue #23 — Surface the §4.5 soft DTI warning in the home-purchase UI

## Overview

Slice 4 (§4.5) requires the home-purchase flow to show a **soft** debt-to-income
warning (28% front-end / 36% back-end) that flags an affordability problem
without blocking the event. The engine arithmetic already existed and was correct
(`assessDti`, `mortgagePaymentForPurchaseCents` in
`packages/engine/src/affordability.ts`) but had **zero call sites** — nothing
computed the assessment for a real purchase and nothing rendered it.

This change wires that arithmetic into the authoring form: it derives the three
inputs the assessment needs from the live household at the purchase month (gross
monthly income, the mortgage the purchase would imply, and the debt already being
serviced), and renders a non-blocking amber advisory that names the ratio **and**
its projected downstream consequence. The event still records regardless — the
only hard block (down-payment coverage) is untouched and stays in the engine.

## RGR Verification Details

- **RED** — Added `homePurchaseForm.test.tsx` asserting the default purchase
  ($300k / $60k down / 6.5% / 30yr on the default $5,000/mo gross ≈ 30% front-end)
  renders a `soft-warning`, names the downstream consequence, keeps the Add-event
  button enabled, and stays silent for a comfortably-affordable purchase. Initial
  run: **3 failed / 1 passed** — no warning markup existed, only the "silent" case
  passed vacuously.
- **GREEN** — Added `homePurchaseDti.ts` (the pure app-side glue) and a
  `DtiWarning` sub-component in `homePurchaseForm.tsx`; threaded the projection
  `series` through `AddEventForm` → `HomePurchaseForm`. Test file went **4/4
  green**.
- **Refactor / hardening** — Added `homePurchaseDti.test.ts` covering the
  derivation directly: exceeds-guideline, stays-quiet, and the zero-gross-income
  case (no divide-by-zero warning). **7/7 green** across the two new files.

## Key Decisions & Why

- **The engine arithmetic was reused verbatim, not reimplemented.** The issue's
  whole point is the functions exist but are never called, so the fix is wiring.
  `assessHomePurchaseDti` composes `mortgagePaymentForPurchaseCents` + `assessDti`.
- **Derivation lives in the app, not the engine.** Turning a `Household` +
  `ProjectionSeries` into "gross income and existing debt at month M" is
  app-facing glue over engine outputs, so it belongs in the app (keeps engine
  purity intact — `check:purity` passes). Gross income is the sum of active income
  series from `buildSnapshot`; existing debt is the projected month's
  `flows.liabilityPaymentsCents` (0 at month 0 / empty ledger, as designed).
- **Housing = the new mortgage; total debt = existing debt + new mortgage.** This
  matches the front-end (housing ÷ gross) / back-end (total debt ÷ gross)
  definitions in `affordability.ts`. Property-tax/insurance/HOA are a deferred
  engine seam, so they are correctly omitted here too.
- **Advisory, never blocking.** The warning renders after the Add-event button,
  which is never disabled; `submit` is unchanged. Styled `alert-amber` (existing
  token) to read distinctly from the red hard-block `alert-red` conflict banner.
- **The copy names the consequence, not just the ratio (§4.5).** It states the
  added monthly payment, the ratio vs. its guideline, and the downstream effect:
  "less income is left to cover everything else — the plan leans harder on credit
  and can run out of money sooner."
- **`initialPrice`/`initialDown` props** are lightweight test seams so a static
  server render can start above or below the guideline (the form's `useState`
  otherwise only renders its default state).

## Changes Made

- **`packages/app/src/components/addEventForm/homePurchaseDti.ts`** (new) —
  `assessHomePurchaseDti(household, series, input)` derives gross income + existing
  debt at the purchase month and returns the `DtiAssessment`, the implied monthly
  mortgage, gross income, and an `exceeded` convenience flag.
- **`packages/app/src/components/addEventForm/homePurchaseForm.tsx`** — computes
  the assessment each render and renders the new `DtiWarning` advisory when a
  guideline is exceeded; now accepts `household`, `series`, and the two test-seam
  props.
- **`packages/app/src/components/addEventForm/addEventForm.tsx`** — threads the
  projection `series` prop through to `HomePurchaseForm`.
- **`packages/app/src/main.tsx`** — passes the live `series` into `AddEventForm`.
- **`homePurchaseForm.test.tsx`, `homePurchaseDti.test.ts`** (new) — render + unit
  coverage for all four acceptance criteria.

## Verification & Testing

- `npm run check:purity` — ✓ engine purity intact (no app imports in engine).
- `npm run typecheck` — ✓ clean.
- `npm run test` — **616 passed | 45 todo (661)** across 54 files, including the 7
  new tests.

### Acceptance criteria

- [x] Purchasing above 28% front-end and/or 36% back-end shows a soft warning.
- [x] The warning does **not** block the event from being recorded.
- [x] The warning names the downstream consequence, not just the ratio.
- [x] Zero gross income does not trip a divide-by-zero warning.
