# Handoff — issue 186

**Done so far:**
- Task 1 (engine outcome map) — **DONE** (this commit).
- Task 2 (graph: solid to block, hatched after) — remaining.
- Task 3 (timeline: blocked / not-reached indicators) — remaining.
- Task 4 (soft warning + end-to-end) — remaining. Owns the summary + handoff deletion.

## Live constraints (what tasks 2–4 consume)
- `ProjectionSeries.obligationOutcomes` is **always present** (`{}` on a plain run), a
  `Record<ObligationId, ObligationOutcome>`. Three-state union in `simulate.types.ts:309`.
  Only **explicit** draws appear — automatic obligations (budget lines, liability payments) and
  structural events (marriage/child/separation) are deliberately absent. Do not add them; the map's
  keys ARE "the authored purchases".
- Outcome keys are the obligation's `id`, which for down-payment draws is `draw:${authoredId}`
  (see `financialObligation.ts:287`). The timeline (task 3) keys events via
  `BlockedObligation.sourceEventId` / `ObligationOutcome`, not by the raw draw id — join on the
  authoring event, not the `draw:`-prefixed id.
- `not-reached` is **positional** (authored strictly after `blockedAtMonth`), never
  dependency-derived. A same-month sibling of the blocker is `executed`. Tasks 2/3 must not
  re-derive "reached" from dependencies — read the map.
- Hatching (task 2) starts at `blockedAtMonth + 1`, **never** at the blocked month itself — that
  month ran its full pipeline and its net worth is real. See AC and `BlockedObligation.month`
  (`simulate.types.ts:327`, equals `ProjectionSeries.blockedAtMonth`).
- Shortfall is a **bare** figure already net of capital-gains tax (`shortfallCents`). Classifying it
  or offering alternatives is #187 — out of scope for every task here.
- Fixtures that build a `ProjectionSeries` literal must now include `obligationOutcomes` (it is
  required). Several test fixtures across `packages/app/.../netWorthChart` and
  `packages/engine/{goal,retirement}` were updated for this — mirror that when adding new ones.

## Dead ends
- (none recorded)

## Deferred
- Shortfall classification / alternatives → #187, not this issue.
