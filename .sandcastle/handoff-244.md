# Handoff — issue 244

Whole-issue mode, split into two independent deletions (both called for by PRD #242's Out of
Scope). No declared tasks.

**Done so far:**
- **Part A — Remove estimate-my-history.** DONE (this commit). The engine
  `estimateHistoryPayChanges`, the `JobPayChange.estimated` marker, the app's "Estimate missing
  pay history" button + explain-panel + `estimated` row styling, and their tests are all gone.
- **Part B — Remove job reassignment.** REMAINING. Next up.

## Part B — what remains

Remove the reassignment operation from the facade and the authoring layer (AC: "removed from the
facade and the authoring layer"). Surface, all traced:
- `packages/engine/src/authoring/jobs.ts` — `reassignProjectionJob` (the function, its long
  doc-comment, and the `Crossing` bullet + `reassignProjectionJob` references in the module
  header and in `JobInput` / `addProjectionJob` / `addProjectionPartnerJob` doc-comments).
- `packages/engine/src/projectionFacade.ts` — `Projection.reassignJob` method, the
  `reassignProjectionJob` import (line ~108), and the two doc-comment references to `reassignJob`
  (the class header near line ~39, and the `write` primitive comment near line ~220).
- `packages/engine/src/authoring/jobs.test.ts` — the `describe("job authoring — reassignment
  crosses the planes atomically")` block + the `reassignProjectionJob` import.
- `packages/engine/src/authoringInputs.guard.test.ts` — the `@ts-expect-error` +
  `p.reassignJob("job-1", P1, …)` line (~68) and its comment (~67). Its sibling comment on
  line ~57 also names `reassignJob` as prose — reword.
- `packages/engine/src/index.guard.test.ts` — drop `"reassignProjectionJob"` from
  `MUST_STAY_INTERNAL` (~line 90).
- `packages/app/src/planWrites.guard.test.ts` — drop `"reassignProjectionJob"` from
  `WRITES_THAT_MUST_STAY_INTERNAL` (~line 196).
- `packages/app/src/jobOwnership.guard.test.ts` — KEEP the guard (it bans reassignment ever
  re-entering the app), but fix its header doc-comment: it currently says "The engine keeps
  `reassignProjectionJob`, tested on its own" — no longer true. Do NOT weaken the four `it(...)`
  scans; they still pass and still matter.

## Live constraints
- `JobPatch` in `job.ts` still documents `ownerId` as "patchable — an edit can reassign a job to
  another household member." `ownerId` stays in `JobPatch` (it is a real field), but that prose
  describes the capability being removed. Reword so it no longer advertises reassignment.
  `replaceProjectionJob`/`updateProjectionJob` already preserve `ownerId`; keep that.
- `authoringInputs.guard.test.ts` bodies are type-checked, never run — every `@ts-expect-error`
  must stay *used* or the build fails. Removing the `reassignJob` line is correct (the method is
  gone); don't leave a dangling directive.
- The engine's `restoreState`/`fromState` path and delete-and-re-add remain the supported way to
  move a job between members — don't remove any add/remove job authoring functions.

## Dead ends
- (none yet)

## Deferred
- (none — Part B is the finishing commit; it deletes this handoff and writes
  `.sandcastle/summary-244.md`.)
