# Issue 257 — Edit an authored timeline event

## Overview

The app could add and remove timeline events but never **edit** one: correcting a partner's
birth year, a loan's rate, a child's cost, or a home's price meant deleting the event and
re-authoring it — losing anything else attached (a partner's jobs, pay adjustments). The engine
already supported in-place revision (`Projection.reviseTransaction` → `reviseProjectionTransaction`
→ `updateEvent`), tested at the engine layer and used in production only by the Jobs panel's
partner-job edit. This issue closes the UI gap: every form-backed event type now round-trips
through `reviseTransaction`.

Each timeline marker gains an **Edit** control beside Remove. It reopens the same authoring form,
pre-filled from the event, and commits the change as a revision — keeping the event's id, its place
in the ledger, its type, and everything it created (a partner's jobs, a home's mortgage).

## Key decisions & why

- **One `edit` seam per form** (`addEventForm/formControls.tsx` → `EditProps<E>`): an optional
  prop carrying the event to seed from and an `onRevise` sink. Present flips a form from authoring
  (its `marry`/`haveChild`/… verb) to revising `event.id` in place. This kept each form a single
  component with two modes rather than duplicating five forms, and made Part 2 mechanical.
- **A revision carries neither identity nor nested entities** (engine's `TransactionRevision`).
  Three consequences shaped the forms:
  - `RelationshipForm` **hides its jobs sub-section** in edit mode — a `marry` revision cannot
    rewrite the partner's job list, so authoring there would silently do nothing; jobs stay edited
    in the Jobs panel.
  - `SeparationForm` shows the partner **read-only** — `partnerPersonId` is identity, not revisable.
  - `HomePurchaseForm` edits only the property's own fields; the financing mortgage's rate and term
    are a separate `LoanEvent`, **revised through that mortgage's own timeline marker**, so the
    home form drops its APR/Term inputs (and the DTI advisory, which reads the mortgage payment) in
    edit mode.
- **`LoanForm`'s draft widened to all non-card `LiabilityKind`s** for editing: the add picker still
  offers only `studentLoan`/`creditCard`, but a mortgage or auto loan minted by a home purchase is
  a `LoanEvent`, so its marker is editable too. Kind is fixed on a revision, so the edit form shows
  it read-only. The add path names the two originable kind literals directly (never off the widened
  draft) so `takeLoan`'s originable-only input stays type-safe.
- **`editEventForm.tsx` owns `EDITABLE_EVENT_TYPES` and dispatches on event type.** The timeline
  reads that set to gate the Edit control, so a type with no form (`DebtPayoffEvent`, authored
  outside `AddEventForm`) shows Remove alone rather than a dead button. The set and the dispatch
  switch are kept in step.
- **`main.tsx` holds `editingId` (by id, resolved live** against the ledger). `reviseEvent` closes
  the edit surface only on success — a refused revision leaves it open with the conflict shown, so
  in-flight edits survive. Loading a preset abandons any open edit.

## RGR verification details

Test-first throughout, red → green per slice:

- **RelationshipForm edit** (`relationshipForm.test.tsx`): asserted the pre-fill (age read against
  the join year), the `marry` revision submitted through a `reviseTransaction` spy, birth-year
  re-derivation on an age change, and the absence of the jobs section. RED: form ignored `edit`.
- **App edit flow** (`mainState.test.tsx`): added a partner / a loan, clicked the marker's Edit,
  changed a field, saved, and asserted the marker updated in place (still one marker — revised, not
  re-added) and the surface closed; plus a Cancel-abandons path. RED: no Edit control existed.
- **Sub-form edits** (`subForms.test.tsx`): Child, Loan (amortizing + a mortgage kind the picker
  never offers), Separation, and HomePurchase each asserted pre-fill and the exact `(id, revision)`
  submitted. RED: forms ignored `edit`.

## Changes made

- `addEventForm/formControls.tsx` — new `EditProps<E>` and `EventOf<T>` helpers (the edit seam).
- `addEventForm/editEventForm.tsx` — **new**: `EditEventForm` dispatcher + `EDITABLE_EVENT_TYPES`.
- `addEventForm/addEventForm.tsx` — `editing?` prop; renders the pre-filled type-locked edit
  surface (no type picker) instead of the add menu.
- `addEventForm/relationshipForm.tsx`, `childForm.tsx`, `loanForm.tsx`, `separationForm.tsx`,
  `homePurchaseForm.tsx` — each gained an `edit` mode: seed from the event, "Save changes", and a
  revision submit, with the per-type constraints above.
- `timeline/timeline.tsx` — `onEdit` + `editableTypes`; an Edit button per editable marker.
- `main.tsx` — `editingId` state, live `editingEvent` lookup, `reviseEvent`, and wiring to Timeline
  and AddEventForm.

## Verification & testing

- `npm run typecheck` — clean across the workspace.
- `npm run check:purity` — clean (no engine boundary touched).
- App test suite — **572 tests green** (49 files), 12 new across the three test files above.
- Engine unchanged — this was a UI-only gap; no engine or rules code was modified.
