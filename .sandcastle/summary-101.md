# Issue #101 — Goals choose their account type (no more hard-coded capital-gains)

## Overview

Every goal fund was hard-coded to a capital-gains investment account in
`buildPlanAccounts` (`taxProfile: CAPITAL_GAINS_TAX_PROFILE`, `liquid: false`). The user
picked the goal's *return rate* but never *what kind of account holds it* — backwards,
since the account type is the thing a person actually knows ("my emergency fund is in
savings") and the plausible return follows from it. The mismatch was visible in the
default plan: the emergency fund — the canonical cash goal — was modelled as a
capital-gains investment, so drawing it down in decumulation read as investment
withdrawals the user never chose, and a capital-gains draw counts toward provisional
income and pulls the government benefit into tax (#100).

This change makes a goal **declare its account type** (`cash` / `brokerage` / `taxExempt`
/ `preTax`); the fund account's `taxProfile` **and** liquidity now derive from it. The
default emergency fund is a cash/savings account, and drawing a cash goal down reports
tax-free (by the goal's name), never as capital-gains investment income.

## RGR Verification Details

- **RED** — Added a `createProjectionBase — a goal declares its account type (issue #101)`
  block to `projectionBase.test.ts` asserting: a `cash` goal → `CASH_INTEREST_TAX_PROFILE`
  + `liquid: true`; `brokerage` → capital-gains + `liquid: true`; `taxExempt`/`preTax` →
  their respective profiles, illiquid; an unauthored type falls back to the `brokerage`
  shape (liquid capital-gains); and a drawn-down cash goal
  never surfaces a `capitalGains` source, only a tax-free draw by name. Ran the file → **4
  failing** (`buildPlanAccounts` ignored the new field and still stamped capital-gains).
- **GREEN** — Added the `accountType` field and a `GOAL_ACCOUNT_SHAPES` resolver, wired it
  into `buildPlanAccounts`. Re-ran → **21/21 green** in the file.
- **REFACTOR** — Exposed the choice in the authoring form, set the default plan's emergency
  fund to cash, and re-pinned the retirement-age fixtures whose numbers legitimately moved
  when the default emergency fund stopped earning a 7% equity return. Full suite green.

## Key Decisions & Why

- **`accountType` is optional, defaulting to `"brokerage"` (capital-gains, liquid).** This
  keeps the pre-#101 capital-gains tax treatment for every goal that never opts in, so no
  `GoalPlan` literal needs editing; the fund is now liquid (a taxable brokerage is sellable
  on demand), which leaves the shipped default plan and all fixtures unchanged (its emergency
  fund is `cash` and its down payment converts to home equity).
- **One seam: `goalAccountShape` / `GOAL_ACCOUNT_SHAPES`.** The user authors the *kind* of
  account; the projection derives `{ taxProfile, liquid }` from it in a single mapping
  rather than scattering per-type branching. Reuses the four existing neutral tax profiles
  in `simAccount.ts` — no new tax semantics invented.
- **Liquidity tracks reachability: `cash` and `brokerage` are liquid, the retirement
  vehicles are not.** A cash reserve's whole purpose is to be reachable (the issue's
  explicit point about emergency funds), and a taxable brokerage is genuinely sellable on
  demand — so both are liquid. `taxExempt` and `preTax` stay illiquid, locked up by
  age/penalty rules and funded through the goal mechanism rather than reachable as a buffer.
  `simulate.ts` picks the *first* liquid account as the primary buffer, and goal funds are
  appended after `savings`, so the savings buffer remains the primary liquid account — a
  liquid goal fund is an additional reachable balance, not a new sweep target.
- **The default emergency fund's return follows the account type (7% → 1% cash).** A cash
  account earning an equity-market 7% was the same incoherence the codebase already fixed
  for `savingsReturnPct`. The home down-payment goal is explicitly `brokerage` (a near-term
  taxable investment), leaving its 7% untouched. Return rate remains independently authored
  everywhere else.
- **Re-pinned retirement fixtures, not the behaviour.** The default plan's feasible floor
  moved (62→64 partial, 73→75 full) because a ~$15k emergency fund no longer compounds at
  7% for decades. Those tests pin fixture-derived constants; their *coupling* assertions
  (a new expense pushes retirement later; disposition governs nest-egg inclusion) are
  unchanged and still pass.

## Changes Made

- `packages/engine/src/plan.ts` — new exported `GoalAccountType` union; optional
  `accountType` field on `GoalPlanBase`.
- `packages/engine/src/projectionBase.ts` — `GOAL_ACCOUNT_SHAPES` map,
  `DEFAULT_GOAL_ACCOUNT_TYPE`, and `goalAccountShape(goal)`; `buildPlanAccounts` now derives
  each goal fund's `taxProfile` + `liquid` from its account type instead of hard-coding
  capital-gains-and-illiquid.
- `packages/app/src/planDefaults.ts` — emergency fund → `accountType: "cash"`, return 1%;
  home down payment → `accountType: "brokerage"`.
- `packages/app/src/goalsView.ts` — `accountType` on `GoalDraft`; new `GOAL_ACCOUNT_TYPES`
  labelled list for the authoring form.
- `packages/app/src/components/goalsPanel/goalForm.tsx` — "Where is this money held?"
  select, seeded from the edited goal, defaulting a fresh goal to cash.
- `packages/engine/src/projectionBase.test.ts` — new RED→GREEN coverage (6 cases).
- `packages/app/src/retirementView.test.ts`,
  `packages/app/src/components/retirementPanel/retirementPanel.test.tsx` — re-pinned the
  moved default-plan ages, comments updated to explain why.

## Verification & Testing

- `npm run typecheck` — clean.
- `npm run check:purity` — engine purity OK (no I/O, no app/rules imports).
- `npm run test` — **731 passed | 45 todo (776), 60 files** — all green.
