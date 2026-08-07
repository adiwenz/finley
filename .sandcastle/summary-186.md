# Issue 186 — The app says where and why the projection stopped

## Overview

Slice #6b makes a blocked projection **legible**. #185 made the net-worth curve honest but silent —
it just ended. This issue names **which** obligation blocked, in **which** month, and what that means
for everything authored after it, across the engine's outcome map and the three UI surfaces that read
from it.

The work landed in four commits, one per declared task:

1. **Per-obligation outcomes and the event rollup** (engine). `ProjectionSeries` gained
   `blockingObligation` and `obligationOutcomes` (a three-state `executed | blocked | not-reached`
   union). Only explicitly-funded obligations appear; structural events (marriage, child, separation)
   are folded into the household before month 0 and so carry no outcome. `not-reached` is positional
   — authored strictly after the blocked month — never dependency-derived.
2. **Graph** — solid through the blocked month, hatched from `blockedAtMonth + 1`, the blocking event
   labelled at the block.
3. **Timeline** — every authored event still shown; the blocking event gets a blocked indicator, later
   events a not-reached indicator, each joined to the right event.
4. **The soft warning, and the end-to-end case** (this commit).

## This task (4 of 4)

A **soft warning** for a stopped projection: persistent, non-dismissible, blocking nothing, rendered
only while the plan blocks and clearing on its own the moment it no longer does. It names the event in
the household's own words, the month, and the shortfall net of tax. It is **not a `Nudge`** — it
proposes no value change; dismissing it would not make it less true, since the graph is visibly hatched
either way. Modelled on the app's existing debt-to-income soft warning (`soft-warning` marker class,
`role="status"`, no dismiss control).

## Key Decisions & Why

- **Named from the authoring event, not the obligation.** `blockingObligation.label` is an
  engine-internal band namespace (`"downpayment"`), not something a household would recognise. The
  warning recovers the plain-language name ("Bought a home") from the authoring event via
  `sourceEventId` — the same event→outcome join the timeline's indicators already use — falling back to
  the obligation label only if the event cannot be found.
- **Derivation split from presentation.** `blockedWarning(ledger, series)` is a pure function in
  `ledgerView.ts` (where the timeline's join already lives), returning `BlockedWarningView | null`. The
  `BlockedWarning` component is a pure statement of that view. This let both be tested at their own
  seam — the join in Node against a real `Projection`, the markup via `renderToStaticMarkup` — without
  standing up the whole `App` (which mounts on `document` and pulls in Recharts).
- **Read off the authored series, never the retirement preview.** Like the timeline markers, the
  warning names the plan as written; the preview is a hypothesis, not the household's plan.
- **Red, not amber.** The DTI soft warning is amber because it is advice. A blocked projection is a
  stop that already happened — the plan ran out of money the purchase needed, comparable to the red
  insolvency alert — so the warning is red while keeping the `soft-warning` behavioural pattern.
- **Shortfall passed through untouched.** The warning shows `blockingObligation.shortfallCents`
  verbatim — the engine's bare figure, already net of capital-gains tax. Classifying it or offering
  alternatives is #187, out of scope here.

## RGR Verification Details

- **RED:** `ledgerView.test.ts` referenced `blockedWarning` before it existed —
  `TypeError: blockedWarning is not a function`. **GREEN** after adding the pure join.
- **RED:** `blockedWarning.test.tsx` rendered a `BlockedWarning` that did not exist — no tests
  collected. **GREEN** after adding the component.
- The end-to-end case in `scenarios.blockedPurchase.test.ts` first stranded a second purchase at
  month 240, which the authoring §4.5 gate rejected (savings drained by then); corrected to month 60
  (still affordable when authored, stranded by the later opening-balance edit) — mirroring the fixture
  the existing blocked-purchase and timeline tests use.

## Changes Made

- `packages/app/src/ledgerView.ts` — `blockedWarning(ledger, series)` and the `BlockedWarningView`
  type. Reuses `summarizeEvent` for the plain-language name; imports the `Cents` type.
- `packages/app/src/components/blockedWarning/blockedWarning.tsx` — the `BlockedWarning` component:
  `alert alert-red soft-warning`, `role="status"`, no dismiss control.
- `packages/app/src/main.tsx` — memoises `blockedWarning(ledger, series)` off the authored run and
  renders `<BlockedWarning>` beside the insolvency alert while the block holds.
- `packages/app/src/ledgerView.test.ts` — the join: names the event/month/shortfall, `null` with no
  series and on a run to the horizon.
- `packages/app/src/components/blockedWarning/blockedWarning.test.tsx` — the markup: names event,
  month, shortfall; carries the `soft-warning` marker and no dismiss button.
- `packages/app/src/scenarios.blockedPurchase.test.ts` — the end-to-end acceptance case: stranding a
  purchase produces a warning naming that event and month, and marks every later event not-reached.

## Verification & Testing

- `npm run check` green — purity, typecheck, and the full test suite.
