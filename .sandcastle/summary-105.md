# Issue #105 — Goal funds & the §4.5 down-payment gate: the liquid reserve now counts, and the block says so

## Overview

Issue #105 reported that every goal-fund account was created `liquid: false`, so the
default plan's cash **Emergency fund** — documented as *"a liquid reserve"* — could not
help cover a home-purchase down payment, and the §4.5 gate rejected purchases while the
balance sheet plainly showed enough cash, *"with no explanation of which buckets were
counted."*

Since the issue was filed, the enabling half of the fix already landed via the
`GoalAccountType` seam (issue #101): a goal now authors the **kind** of account it is held
in (`cash` / `brokerage` / `taxExempt` / `preTax`), and `goalAccountShape` derives both the
tax profile **and** liquidity from it. The default Emergency fund is `accountType: "cash"`,
which resolves to `liquid: true` — so the reserve **is** already a counted source, and the
`planDefaults.ts` comment now agrees with the model.

What remained wrong was the **other** place the issue's "comment and code disagree" defect
lived: the §4.5 down-payment **conflict message**. It still told the user, verbatim, that
*"goal funds, retirement and brokerage balances do not [count]"* — a claim the model
contradicts the moment a liquid cash goal fund exists. This change makes the gate's
user-facing explanation agree with what it actually counts, and delivers the missing
"which buckets were counted" breakdown.

## RGR Verification Details

- **RED:** Added `HomePurchaseEvent — §4.5 gate counts liquid goal funds` to
  `events.homePurchase.test.ts`. The driving case builds a base with **$30k savings +
  $20k liquid (cash) Emergency fund = $50k** against a **$60k** down payment. The gate
  correctly blocks — but the assertion `conflict` *names* the counted `Emergency fund`
  bucket failed, because the static message omitted it and still claimed goal funds never
  count. (A fixture bug surfaced first — a goal-fund `SimAccount` built without the required
  `initialAnnualRate` accrued to `NaN`, silently defeating the gate; corrected to
  `initialAnnualRate: 0`, which is what exposed the real, message-level RED.)
- **GREEN:** Threaded a per-account liquid breakdown into the authoring context and had the
  block enumerate the buckets it counted. `13/13` in the file, then `906/906` workspace-wide.

## Key Decisions & Why

- **Fix the message, not the model.** The behavioural half (emergency fund liquid) already
  ships via `accountType: "cash"` → `liquid: true`. The residual §4.5 defect was purely that
  the conflict text disagreed with the model. Correcting the text is the minimal, in-scope
  change that resolves "the comment and the code disagree."
- **Enumerate, don't assert.** Rather than hard-coding a corrected sentence, the message now
  lists the actual liquid buckets (`label (dollars)`, largest first) the gate summed —
  directly answering the issue's "no explanation of which buckets were counted." A cash goal
  fund shows up by name (`Emergency fund ($20,000)`); illiquid categories (retirement,
  tax-exempt/pre-tax goal funds) and credit are named as the reason net worth can exceed the
  down payment while the gate still fails.
- **One projection, two reads.** `liquidBalanceLookup` became `liquidLookups`, returning
  `balanceAt` (unchanged total semantics — sums *all* liquid accounts) and `bucketsAt`
  (positive balances only, for display) from a **single** `buildProjection`. Keeping the
  total independent of the display list preserves the exact prior gate arithmetic.
- **Additive context capability.** `InterpretContext` gained an optional `liquidBucketsAt`
  paired with the existing `liquidBalanceAt`; both are populated only on the authoring path,
  so ordinary replay/undo still skip the projection-dependent check unchanged.

## Changes Made

- `packages/engine/src/ledger/interpretState.ts` — new exported `LiquidBucket`
  (`{ label, balanceCents }`); added `InterpretContext.liquidBucketsAt?: (month) => readonly LiquidBucket[]`.
- `packages/engine/src/ledger/addEvent.ts` — `liquidBalanceLookup` → `liquidLookups`,
  exposing `balanceAt` + `bucketsAt` off one shared projection; `addEventContext` now wires
  both capabilities.
- `packages/engine/src/ledger/eventHandlers.ts` — `homePurchase.check` builds a "Counted
  toward the down payment: …" list from `liquidBucketsAt` and drops the false blanket
  "goal funds … do not count" claim.
- `packages/engine/src/events.homePurchase.test.ts` — new describe block: a liquid emergency
  reserve covers the gap savings alone cannot; the block names the liquid goal buckets it
  counted; an illiquid goal fund is still excluded.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity guard passed (no I/O, no app/rules imports).
- `npx vitest run` — **906 passed | 45 todo (951)**, 76 files green (0 regressions).
- Touched engine only (no React/TSX), so `/vercel-react-best-practices` did not apply.

## Notes for the next iteration

- Epic #129's locked design ("a goal bucket becomes *eligible* but the engine never
  *auto-includes* it") depends on the separate §4.5 **gate rework** (validate the user's
  *selected* sources at the event month) — a distinct checklist item, out of scope here. Until
  that lands, the current gate sums the global liquid pool, so liquid goal funds *are*
  auto-included; that is the expected intermediate state for #105, and the message now
  reports it truthfully.
