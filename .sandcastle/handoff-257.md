# Handoff — issue 257

**My own breakdown (whole-issue mode, no declared tasks):**

- **Part 1 — DONE (this commit):** Timeline "Edit" affordance + the whole edit architecture +
  `RelationshipEvent` editing (the `marry` revision, the primary user-facing case).
- **Part 2 — REMAINING:** Extend the same edit seam to the other four form-backed event types —
  `ChildEvent` (`haveChild`), `LoanEvent` (`takeLoan`), `HomePurchaseEvent` (`buyHome`),
  `SeparationEvent` (`separate`). Mechanical: each already has its add form and a revision verb.

## Live constraints — the seam Part 1 built (match it exactly for Part 2)

- **The `edit` prop.** Each form takes an optional `edit?: EditProps<TheEvent>` from
  `addEventForm/formControls.tsx` — `{ event, onRevise }`. Present = edit mode: seed the draft
  from `event`, submit through `edit.onRevise((p) => p.reviseTransaction(event.id, revision))`,
  and label the primary button "Save changes" (else "Add event"). Copy `relationshipForm.tsx`.
- **Register the type in two places, together:** add a `case` in
  `addEventForm/editEventForm.tsx`'s `form()` switch AND add the type to `EDITABLE_EVENT_TYPES`
  in the same file. The timeline reads that set to decide which markers show Edit, so a type in
  the switch but not the set never opens (and vice-versa opens a `null` form). Keep them in sync.
- **A revision carries no id and no nested entity** (see `engine/src/authoring/revise.ts`
  `TransactionRevision`). So the `buyHome` revision cannot change `downPaymentSourceIds`' *entity*
  but CAN pass the array of existing account ids; the mortgage's apr/term are a SEPARATE
  `takeLoan` revision on the `<propertyId>-mortgage` id, NOT part of `buyHome` — the home form
  currently authors both in one `buyHome` add call, so its edit path needs care (see below).
- **`SeparationEvent` has no revision field for `partnerPersonId`** — you cannot change who the
  separation is from via a revision (only month/alimony/childSupport). Seed the partner picker
  read-only, or hide it, in edit mode.
- **Success/refusal:** `onRevise` never returns a result. `main.tsx`'s `reviseEvent` closes the
  edit surface only on success (sentinel-`true` through `transact`); a refusal keeps it open with
  the conflict shown. Forms must not inspect the outcome.

## Traps

- **Jobs are not revisable.** `RelationshipForm` hides its jobs sub-section in edit mode because
  the `marry` revision cannot touch the job list (edited in the Jobs panel). No other form has an
  embedded entity list, so this is relationship-specific — don't copy the hiding logic blindly.
- **`MonthSelect` only lists year-start months** (0, 12, 24…). Events authored through it are fine;
  a preset-seeded event on a non-year-start month would show a blank picker but keep its month on
  submit (draft retains it until touched). Acceptable, but know it.
- **`HomePurchaseForm` edit is the one with real friction:** its add path calls `p.buyHome(...)`
  which composes property + mortgage + down-payment drains. A `buyHome` revision only revises the
  property fields; APR/term ride the mortgage `LoanEvent`. Simplest honest Part-2 scope: revise the
  `buyHome` fields (month, price, down, sources, appreciation) and either (a) also issue a paired
  `takeLoan` revision on `${event.propertyId}-mortgage` for apr/term, or (b) drop apr/term from the
  home edit form and note they're edited via the mortgage's own marker. Decide and document.

## Deferred

- **`DebtPayoffEvent`** is authored outside `AddEventForm` (no form under `addEventForm/`), so its
  markers show Remove only. Out of scope unless you add a form; the issue starts with Relationship
  and lists the five form-backed types. Leave it out of `EDITABLE_EVENT_TYPES`.
- The final commit (last part) writes `.sandcastle/summary-257.md` and deletes this handoff.
