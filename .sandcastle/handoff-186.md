# Handoff — issue 186

**Done so far:**
- Task 1 (engine outcome map) — **DONE**.
- Task 2 (graph: solid to block, hatched after) — **DONE** (this commit).
- Task 3 (timeline: blocked / not-reached indicators) — remaining.
- Task 4 (soft warning + end-to-end) — remaining. Owns the summary + handoff deletion.

## Live constraints (what tasks 3–4 consume)
- `ProjectionSeries.obligationOutcomes` is **always present** (`{}` on a plain run), a
  `Record<ObligationId, ObligationOutcome>`. Three-state union in `simulate.types.ts`.
  Only **explicit** draws appear — automatic obligations (budget lines, liability payments) and
  structural events (marriage/child/separation) are deliberately absent. Do not add them; the map's
  keys ARE "the authored purchases".
- Outcome keys are the obligation's `id`, which for down-payment draws is `draw:${authoredId}`
  (see `financialObligation.ts`). The timeline (task 3) keys events via
  `BlockedObligation.sourceEventId` / `ObligationOutcome`, not by the raw draw id — join on the
  authoring event, not the `draw:`-prefixed id.
- `not-reached` is **positional** (authored strictly after `blockedAtMonth`), never
  dependency-derived. A same-month sibling of the blocker is `executed`. Tasks 3/4 must not
  re-derive "reached" from dependencies — read the map.
- Shortfall is a **bare** figure already net of capital-gains tax (`shortfallCents`). Classifying it
  or offering alternatives is #187 — out of scope for every task here.
- Fixtures that build a `ProjectionSeries` literal must include `obligationOutcomes` (required).

## Graph, now settled (task 2)
- The never-simulated tail is `stoppedSpan` (`chartSpan.ts`), whose `fromX` is now
  `toAxisX(blockedAtMonth + 1)` — the hatch begins the month AFTER the block. The blocked month ran
  its full pipeline and stays on the solid curve; do not re-anchor it on the blocked month.
  Asserted by `blockedMarker.test.ts` and `netWorthBreakdown.test.ts` ("hatches from the month
  after the block…").
- Both charts (`netWorthChart.tsx`, `netWorthBreakdownChart.tsx`) render that band as an SVG
  `<pattern>` diagonal hatch (id via `useId`, matching the `payChart.tsx` idiom), labelled
  "not simulated" on the total chart. The blocked marker + tooltip already name the event/gap.
- Recharts renders nothing in jsdom, so the hatch/marker visuals are NOT asserted off the SVG — the
  seam is the pure `buildNetWorthChartData` / `buildNetWorthBreakdown` data. Task 3's timeline
  should follow the same seam discipline (assert the data, or a hidden `<output>` mirror as
  `payChart.tsx` does, not the rendered SVG).

## Dead ends
- (none recorded)

## Deferred
- Shortfall classification / alternatives → #187, not this issue.
