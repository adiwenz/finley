# Issue #115 — Unify addEventForm sub-forms to the single-draft form-state standard

## Overview

The six `addEventForm` sub-forms each held their fields as several independent
`useState` hooks (3–5 apiece). Issue #72 established a cleaner form-state standard —
**one draft object per form**, **discriminated unions over booleans-that-gate-fields**,
**UI-only/derived state kept out of the draft** — via the `jobForm`, `budgetLineForm`,
and `payChangeEditor` exemplars. This change brings the whole `addEventForm` family up to
that standard in one self-contained pass.

It is a **pure refactor**: no event payload changes and no user-visible behaviour changes.
The parent `addEventForm.tsx` was already correct (a single `kind` selector delegating to
the sub-form that owns its own draft) and was left untouched.

## RGR Verification Details

The notable modeling decision is `loanForm`: its `kind` select gates the *term* field, so
the draft is now a **discriminated union on `kind`** mirroring the engine's `LoanEvent`
(the credit-card arm has no term; the amortizing arms do). Because a union *rebuilds the
arm* on a kind switch, the term must be **restored** across a credit-card toggle to
preserve the old flat-state behaviour — the same "remember my value" affordance
`jobForm`'s open-ended `endAge` has.

- **RED:** Added `subForms.test.tsx` with a test asserting that typing a term of `7`,
  switching to a credit card (term field disappears), then switching back to an auto loan
  restores `7` — not the default `5`. Implemented `loanForm` as a union whose `setKind`
  rebuilt the amortizing arm with `DEFAULT_TERM_YEARS`. Test failed exactly as expected:
  `AssertionError: expected 5 to be 7`.
- **GREEN:** Added a `lastTermYears` `useRef` (kept out of the draft — it is a UX memory,
  not domain state), updated on every term edit and read when re-entering an amortizing
  arm. Test passed. The restore now matches the pre-refactor flat-state behaviour exactly.
- **REFACTOR / REPEAT:** Consolidated the other five forms to a single `useState<Draft>`
  plus a small functional `patch` helper, moving derived values (`owners`/`selectedOwner`,
  the eligible-partner list, the DTI advisory) to render-time derivations rather than
  duplicated state. Re-ran the suite green after each.

## Key Decisions & Why

- **Single draft + functional `patch`.** Each form now holds one `useState<Draft>` and
  updates via `setDraft((d) => ({ ...d, ...fields }))`. Functional updates avoid stale
  closures and keep every field on one object (the #72 standard).
- **`loanForm` as a discriminated union on `kind`.** The kind already discriminates the
  submitted `LoanEvent`; modeling the *draft* the same way makes the illegal states
  unrepresentable (a credit card can never carry a term, an auto loan never a limit) and
  matches the `budgetLineForm` exemplar. This is the only form where a union genuinely
  applies — the others gate fields off *values already in the draft* (`owners.length > 1`,
  `alimony > 0`), which is derivation, not a separate boolean flag, so no union is needed.
- **`lastTermYears` ref kept out of the draft.** Restoring the term across a kind toggle
  is a UX affordance, not domain state; keeping it in a `useRef` (as `jobForm` does for
  `endAge`) leaves the active arm's `termYears` the single source of truth.
- **Derived, never duplicated.** `expenseForm`'s owner list, `separationForm`'s eligible
  partners and resolved selection, and `homePurchaseForm`'s DTI advisory are all computed
  during render from the draft — never stored — so they cannot drift out of sync with the
  month picker. `month` was folded into `homePurchaseForm`'s draft for family consistency.
- **No behaviour change.** Event payloads, gating, defaults, and derivations are byte-for-
  byte the same; only the *shape of the state* changed.

## Changes Made

- `packages/app/src/components/addEventForm/loanForm.tsx` — draft is now a discriminated
  union `LoanDraft` on `kind` (credit-card arm has no term); `lastTermYears` ref restores
  the term across a credit-card toggle; `setKind`/`patch`/`setTermYears` helpers.
- `packages/app/src/components/addEventForm/homePurchaseForm.tsx` — single
  `HomePurchaseDraft` ( `month`, `price`, `down`, `apr`, `termYears`) + `patch`; DTI
  advisory derived from the draft. (5 hooks → 1.)
- `packages/app/src/components/addEventForm/separationForm.tsx` — single `SeparationDraft`
  + `patch`; eligible partners and resolved selection derived. (4 hooks → 1.)
- `packages/app/src/components/addEventForm/childForm.tsx` — single `ChildDraft` + `patch`.
  (3 hooks → 1.)
- `packages/app/src/components/addEventForm/expenseForm.tsx` — single `ExpenseDraft` +
  `patch`; owner list/selection derived. (3 hooks → 1.)
- `packages/app/src/components/addEventForm/relationshipForm.tsx` — single
  `RelationshipDraft` + `patch`. (2 hooks → 1.)
- `packages/app/src/components/addEventForm/subForms.test.tsx` — **new** jsdom test file:
  the loan term-restore RGR guard, the loan credit-card-vs-amortizing submit shape, the
  separation alimony-gates-duration behaviour, and the child single-draft submit.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity check passed.
- `npm run test` — **695 passed | 45 todo (740)**, 59 test files. The pre-existing
  `homePurchaseForm.test.tsx` and `homePurchaseDti.test.ts` pass unchanged; the new
  `subForms.test.tsx` adds 4 targeted tests.
