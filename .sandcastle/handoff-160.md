# Handoff — issue 160

**Done so far (this agent's own split — the issue declares no tasks):**
- **Part A — partner account lifecycle + per-person net worth reporting: DONE**, committed.
- **Part B — household funding waterfall policy: NOT STARTED.**

## Part A summary (for Part B to build on)

- `RelationshipEvent.accounts?: PartnerStandingAccounts` (`packages/engine/src/ledger/eventTypes.ts`) — a partner's three standing accounts (savings/retirement/brokerage), fully resolved (never optional sub-fields). Absent ⇒ `ZERO_PARTNER_ACCOUNTS`.
- `MarryInput`/`StartPartneredInput.accounts?: PartnerAccountsInput` (`authoring/relationships.ts`) — all fields optional; `applyMarriage` resolves balance→0 and returnPct→the primary's own plan rate.
- `eventHandlers.ts`'s `relationship` handler mints the 3 `PlanAccount`s (`compile/projectionBase.ts: buildPartnerAccounts`/`partnerAccountId`) into `InterpretState.accountsById`. A forward-dated join (`month ≥ 0`) opens each account at 0 and lands the authored balance as a one-time `AccountTransfer` AT the join month (not income/cashflow — same mechanism `debtPayoff` already used). A past-anchored `startPartnered` (`month < 0`, unreachable by the sim) opens directly at the authored balance, like a pre-existing home/loan holding.
- `separation` handler drains every INDIVIDUALLY-owned account of the departing partner to 0 via `AccountTransfer{ proportionalFraction: -1 }` at the separation month — joint accounts are untouched (division is #142, still a non-goal). This is why **no month-by-month "is this account active" gate exists anywhere** (net worth, withdrawal cascade, RMDs, estate settlement, tax-year projection): a partner's account balance is genuinely 0 outside their membership window, so every existing consumer of `state.accounts`/`assetBalances` already reads the right number for free. Do not add a parallel active-window check — the balance IS the gate.
- `Household.eventAccounts: readonly PlanAccount[]` — event-minted accounts (partner's), separate from `Household.accounts: readonly Account[]` (authoring view, now base+event merged). `buildHouseholdInput.ts` merges `base.initialAccounts` + `household.eventAccounts` into the one list the simulator runs.
- `ProjectionMonth.netWorthByPersonCents: Record<string, Cents> | null` (`projection/monthSnapshot.ts`) — accounts+properties−liabilities grouped by `ownerId`, `null` exactly when `netWorthNominalCents` is `null` (insolvency).
- Tests: `packages/engine/src/ledger/events.partnerAccounts.test.ts`.

## Live constraints

- `SimAccount.ownerId` is single-valued (joint ownership is unrepresentable in the compiled shape — `plan/planAccount.ts` header). Any per-person funding logic in Part B that groups `state.accounts` by owner will naturally see joint accounts under whichever single owner `planAccount()` picked; that's pre-existing, not something to fix here.
- `state.liquidAccount` (`projection/runState.ts:319`, `input.accounts.find(a => a.liquid) ?? null`) is still the single global liquid buffer picked once at init — this is exactly the "global waterfall first-account" anti-pattern issue #160's "Household funding" section calls out. Fixing it (or replacing it with a per-person notion) is Part B's job.

## Deferred (out of scope for #160, noted so nobody re-discovers it as a bug)

- `InterpretContext.accountIds` (`ledger/interpret.ts: contextFrom`) is built once from `base.initialAccounts` BEFORE the event loop runs, so a partner's account ids are not yet known when a later event's `check()` validates an explicit funding-source id. A down payment / one-time spend / debt payoff authored against a partner's own account id would be refused as "account not found" even though the account exists post-marriage. Not required by #160's acceptance criteria; would need `contextFrom` to grow incrementally as events apply.

## Part B — what's actually left (the issue's "Household funding" section)

`projection/waterfall.ts`'s `splitSharedObligation` ALREADY does proportional-to-take-home splitting (`totalPositive`/`positiveTakeHome`), correctly. Missing pieces:

1. **Asset-proportional fallback** — today, when `totalPositive <= 0`, the whole shared obligation becomes shortfall (`splitSharedObligation`, the `totalPositive <= 0` branch). Needs: split by each person's eligible available assets instead (mirror `projection/fundingEligibility.ts`'s `getEligibleFundingSources`, scoped per-owner).
2. **Person-specific (non-shared) obligations** — `projection/financialObligation.ts`'s `FinancialObligation` has no scope/owner distinction; `compile/projectionBase.ts:261-264`'s own comment already flags the ownerId tag as inert ("starts doing work once a line can be personal"). `goal/goal.ts`'s `SimGoal.scope: "personal" | "shared"` is the existing analogous pattern to mirror.
3. **Fund each person's share from accounts available to that person** — `projection/withdrawal.ts`'s `buildWithdrawalSources`/`orderedLiquidationAccounts` drains `state.accounts` as ONE undifferentiated pool in tax-treatment order, ignoring `ownerId`. Needs per-person liquidation ordering (that person's own accounts first).
4. **Cross-partner shortfall coverage** — when one person's own accounts can't cover their calculated share, the other partner's should be tapped for the remainder (only after their own share is met).
5. **Never negative an account to preserve the split** — largely already true mechanically (`Math.min(balance, need)` throughout withdrawal/transfer code); needs a test once (3)/(4) exist to prove it holds under the new per-person cascade too.
