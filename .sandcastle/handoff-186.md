# Handoff — issue 186

**Done so far:**
- Task 1 (engine outcome map) — **DONE**.
- Task 2 (graph: solid to block, hatched after) — **DONE**.
- Task 3 (timeline: blocked / not-reached indicators) — **DONE** (this commit).
- Task 4 (soft warning + end-to-end) — remaining. Owns the summary + handoff deletion.

## Live constraints (what task 4 consumes)
- `ProjectionSeries.obligationOutcomes` is **always present** (`{}` on a plain run), a
  `Record<ObligationId, ObligationOutcome>`. Three-state union in `simulate.types.ts`.
  Only **explicit** draws appear — automatic obligations (budget lines, liability payments) and
  structural events (marriage/child/separation) are deliberately absent. The map's keys ARE
  "the authored purchases".
- Outcome keys are the obligation's `id` = `draw:downpayment:${authoredEventId}`
  (`eventHandlers.ts:384` + `assetAcquisitionObligation`). **Join on the authoring event, not by
  hard-coding that spelling.** Task 3's timeline recovers the `draw:downpayment:` prefix by stripping
  `blockingObligation.sourceEventId` off `blockingObligation.obligationId`, then strips it back off
  each outcome key — see `eventOutcomes` in `ledgerView.ts`. Reuse that seam if task 4 needs the
  event→outcome join; don't re-derive positionally.
- `not-reached` is **positional** (authored strictly after `blockedAtMonth`), never
  dependency-derived. A same-month sibling of the blocker is `executed`. Read the map.
- Shortfall is a **bare** figure already net of capital-gains tax (`shortfallCents`). Classifying it
  or offering alternatives is #187 — out of scope for every task here.
- Fixtures that build a `ProjectionSeries` literal must include `obligationOutcomes` (required).

## Timeline, now settled (task 3)
- `timelineMarkers(ledger, series?)` now annotates each marker with `outcome: MarkerOutcome`
  (`"executed" | "blocked" | "not-reached"`, exported from `ledgerView.ts`). Omitting `series` (the
  snapshot panel's `splitMarkers` path) leaves every marker `executed` — indicators show only once
  something stopped. `main.tsx` feeds the **authored** `series`, never the retirement preview, so an
  indicator reflects the plan as written.
- `Timeline` (`components/timeline/timeline.tsx`) renders a per-row badge ("Blocked" / "Not reached")
  and a track-dot modifier for the two non-executed outcomes; executed events render exactly as
  before. Asserted at both seams: the pure join in `ledgerView.test.ts`, the rendered rows in
  `components/timeline/timeline.test.tsx` (jsdom — plain DOM, no Recharts, so the rows ARE asserted).
- The end-to-end blocked scenario used by task 3's join test mirrors `scenarios.blockedPurchase.ts`:
  author two affordable purchases at 400k opening, `updatePlan` down to 60k to strand them. Task 4's
  end-to-end AC can reuse that shape.

## Warning pattern for task 4
- The soft-warning precedent the issue names: `homePurchaseForm.tsx:98` + `affordability.ts` (the
  debt-to-income warning). Persistent, non-dismissible, **not** a `Nudge`. It names the event, the
  month, and the shortfall net of tax — all on `series.blockingObligation` (`label`, `month`,
  `shortfallCents`). `main.tsx` already destructures `series` and renders the insolvency alert near
  line 204 — the blocked-warning likely sits alongside it.

## Dead ends
- (none recorded)

## Deferred
- Shortfall classification / alternatives → #187, not this issue.
