# Issue 200 — `MarryInput.jobs` should take `JobInput[]` so the engine mints partner job ids

## Overview

`Projection.marry` accepted fully-formed `Job`s for the incoming partner, forcing the **caller**
to mint each partner job id. That broke the engine's invariant that it is the sole id authority:
`marry` only floored the counter *past* those caller-supplied ids (via the nested-id walk), it
never minted them. It was the one authoring path where "no caller writes an id" was unachievable,
and — since a partner's owner is the person `marry` itself creates — a caller could not correctly
name `ownerId` either.

This change switches `MarryInput.jobs` to the existing `JobInput[]` (which omits both `id` and
`ownerId`) and has `marry` mint each job's id and stamp `ownerId` to the person it just created.

## RGR Verification Details

- **RED:** Added `marry() mints an id and owner for each of the partner's jobs` passing two
  id-less/owner-less jobs. Under the old code the jobs landed on the event with no `id`, so the
  set of `[partnerId, job.id, job.id]` collapsed to size 2 — the test failed with
  `expected 2 to be 3`.
- **GREEN:** Changed `MarryInput.jobs` to `readonly JobInput[]` and rewrote `marry` to thread the
  single monotonic counter person → jobs, minting each job and setting its `ownerId` to the
  minted person id. The test went green (3 distinct ids, all owned by the partner, and a later
  `addJob` collides with none).
- **Second slice:** Added `marry() preserves a partner job's explicit id override and steps the
  counter past it` — an explicit `id: "job-5"` is returned verbatim and the next `addJob` mints
  `job-6`, confirming AC #3 (override behaviour unchanged).

## Key Decisions & Why

- **Reused `JobInput`, no new type.** `JobInput = Omit<Job, "id" | "ownerId"> & { id?: string }`
  is exactly right: it drops the two fields only the engine may set, and for `marry` the owner is
  the partner being created. `addJob` already speaks it.
- **Threaded one counter, person → jobs.** `mint` reads `state.nextSeq`, so each job mints against
  a synthetic state carrying the running `nextSeq`. Person and jobs therefore draw distinct ids
  from the same monotonic run, and the final `nextSeq` is committed once through `commitEvent`.
  This preserves the existing single-shared-counter guarantee across all minted kinds.
- **Override handling is delegated to `mint`.** No special-casing: `mint` already returns a
  caller `id?` verbatim while advancing the counter past it when it is one of our own id shapes.
- **`commit`'s re-floor is a safety net, not the mechanism.** Because the minted ids are now real
  (not caller guesses), the post-write `seqFloor` walk is a no-op over the partner's jobs rather
  than the thing that keeps the counter honest.

## Changes Made

- `packages/engine/src/projectionRoot.ts`
  - `MarryInput.jobs`: `readonly Job[]` → `readonly JobInput[]`; doc comment explains why inputs
    arrive id-/owner-free.
  - `Projection.marry`: mints an id per job and sets `ownerId` to the newly minted person,
    threading the shared counter through each mint before committing the event.
- `packages/engine/src/projectionRoot.test.ts`
  - Added `partnerEvent(p)` helper (partner jobs live on the `RelationshipEvent`, not the plan).
  - Added the mint-per-job regression test (AC #4) and the id-override test (AC #3).

## Acceptance Criteria

- [x] `MarryInput.jobs` is `readonly JobInput[]`.
- [x] `marry` mints an id for each job and sets `ownerId` to the newly created person.
- [x] Counter behaviour unchanged for an explicit `id?` override (preserved, counter advances past it).
- [x] Regression test: a `marry` with two jobs mints three distinct ids and a later `addJob` collides with none.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity passed (no I/O, no app/rules imports).
- `npm run test` — **1074 passed | 45 todo (1119)**, 85 test files.
- No production caller of `Projection.marry` exists (`relationshipForm.tsx` builds the
  `RelationshipEvent` directly), so this breaking `@finley/engine` export change is contained to
  the type and its tests; the later app migration becomes a pure-deletion diff.
