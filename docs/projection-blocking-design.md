# Projection Blocking & Event Conflict Validation

**Status:** accepted, not yet built
**Parent epic:** #171 — Financial Obligations & Funding Engine
**Supersedes:** #177 (Slice #6), and the prior "full funding is an authoring-time guardrail"
decision (§13)

This is the single source of truth for the feature: the shape to build (§1–§11), the
alternatives that were rejected and why (§12), and the prior position it overturns (§13).
Vocabulary is defined in [CONTEXT.md](../CONTEXT.md) and used here without redefinition.

---

## 1. Problem

Events are individually valid when authored, but a later edit through a different door can make
a previously valid future event impossible to execute. Spending from a house fund leaves too
little for the purchase it was saving for; a raised budget line strands a car purchase in 2041;
deleting a goal removes the account an event names.

The engine has no unified way to detect this, explain it, distinguish a configuration mistake
from a genuine money problem, or hand the UI anything to repair with. Today it does something
worse than nothing: `resolveFundingDraws` computes a shortfall and the caller discards it, while
the home-purchase handler creates the property and mortgage unconditionally — minting net worth
out of the gap, silently, compounding forward.

The goal is to make projection feasibility a first-class concept **without** restricting
free-form planning.

## 2. The two validations

These are independent and must never be conflated.

**Structural validity** — is the change well-formed? Ids resolve, referenced accounts and
persons exist, percentages total 100%, event references are valid. This is the **only** grounds
on which a change may be refused.

**Projection feasibility** — can the authored plan actually be simulated? This never affects
structural validity and is **never** grounds for refusal. A structurally valid plan may be
impossible to fund, and authoring one is a supported, intended use of the product.

> Aspirational plans are the point. *"I want to buy a house in 2031 and can't afford it yet"* is
> the most valuable sentence a planning tool can let a user say. Today the app throws the form
> away.

## 3. Blocking semantics

An **explicitly-funded** obligation whose named sources cannot cover it **blocks** the
projection.

- Exactly one obligation blocks any projection: the first one reached.
- The **blocked month** runs to completion — full nine-step pipeline, income, tax, budget,
  cascade, compounding — with the blocking obligation, and the artifacts it would have created,
  omitted. Its net worth is a genuine end-of-month figure.
- The blocked month is the **last month emitted**. Nothing after it is simulated.
- The simulator never throws, never invents financing, never substitutes a funding source, and
  never guesses intent.

Within the blocked month, and only there, the engine does skip an obligation. This is a
deliberate bounded exception: it exists so the final data point is trustworthy, not to model a
hypothetical future.

**Blocked is not insolvent.** Insolvency has meaningful continuation — the shortfall cascade
models a real card at a real APR that a household can dig out of — so it keeps simulating with
net worth nulled. A block has no continuation. A block strictly precedes insolvency within a
month, structurally, because obligations are pre-flighted (§7) before the cascade runs.

## 4. Result types

> **Name collision.** `projectionRun.ts` already declares a `ProjectionResult`
> (`{ jurisdictionId, series, firstInsolventMonth }`). The blocking fields belong on
> **`ProjectionSeries`** — what `simulateHousehold` actually returns — and the existing
> `ProjectionResult` continues to wrap it unchanged.

```ts
interface ProjectionSeries {
  readonly opening: ProjectionMonth;
  readonly months: readonly ProjectionMonth[];

  /** A statement about the SIMULATION, not the plan. "ran-to-horizon" does not mean healthy —
   *  an insolvent-but-unblocked plan reports it. */
  readonly status: "ran-to-horizon" | "blocked";

  /** Equals `blockedAtMonth` when blocked: the blocked month is emitted. */
  readonly simulatedThroughMonth: number;

  readonly blockedAtMonth?: number;
  readonly blockingObligation?: BlockedObligation;

  readonly obligationOutcomes: Readonly<Record<ObligationId, ObligationOutcome>>;
}
```

```ts
type ObligationOutcome =
  | { readonly status: "executed" }
  | { readonly status: "blocked"; readonly month: number; readonly reason: FundingFailure }
  | { readonly status: "not-reached"; readonly blockedByObligationId: ObligationId };
```

**Only obligations carry outcomes.** Structural events — `RelationshipEvent`, `ChildEvent`,
`SeparationEvent` — produce none and appear nowhere in `obligationOutcomes`. `interpretLedger`
folds the *entire* ledger into a `Household` before month 0, so a marriage in month 200 is
already in the household, the series, and the accounts. Marking it "not reached" would assert
ignorance about something the engine unconditionally computed.

**`not-reached` is positional**, meaning *authored after the blocked month*. Not dependency-
derived: once simulation stops, nothing later has been tested, and marking only dependents would
imply the rest were checked and found fine.

**Event-level rollup.** An event is blocked if **any** of its obligations is. That is currently
1:1 (one down-payment obligation per home purchase) and stays well-defined when it isn't —
since the sim halts, no sibling obligation after the block executes anyway.

## 5. Failure categories

```ts
type FundingFailure =
  | {
      readonly kind: "funding-configuration";
      readonly requiredCents: Cents;
      readonly selectedSourcesAvailableCents: Cents;   // net of tax
      readonly selectedSourcesTaxCents: Cents;
      readonly shortfallCents: Cents;
      readonly alternativeSources: readonly { accountId: string; availableCents: Cents }[];
    }
  | {
      readonly kind: "no-eligible-source-suffices";
      readonly requiredCents: Cents;
      readonly eligibleAvailableCents: Cents;          // net of tax
      readonly eligibleTaxCents: Cents;
      readonly shortfallCents: Cents;
    };
```

**`funding-configuration`** — the selected sources fall short, but eligible sources elsewhere
could cover it. An authoring mistake, not a money problem. The engine reports alternatives and
never picks one.

**`no-eligible-source-suffices`** — no eligible source could cover it. **This is not
insolvency** and the copy must not imply it is. With 401(k)/Roth/HSA excluded from `liquid`, a
household with $50k liquid and $2M in retirement hits this case while being obviously wealthy.
The message is *"no eligible account can cover this — retirement accounts aren't eligible for a
down payment"*, never *"you can't afford this."*

**Both shapes carry tax.** `resolveOrderedFundingDraw` grosses each draw up over the
capital-gains tax the sale induces, so available amounts are already net of tax and a $50k
brokerage delivers less than $50k. The current gate already surfaces this
(*"after the capital-gains tax on liquidating the selected investment sources"*); dropping it
would regress message quality.

## 6. Funding eligibility and sources

Eligibility is decided by the engine and exposed as `getEligibleFundingSources(...)`. The UI
never implements these rules.

**Keyed on treatment:**

| treatment | eligible sources |
|---|---|
| `expense` | liquid accounts + credit cards |
| `asset-acquisition` | liquid accounts only — no bank funds a down payment on a card |
| `debt-payment` | unchanged (automatic; always fully funded) |

Ship with **exactly these rules**. The PRD's other proposed axes — relationship settings,
account restrictions, minimum retained balances — have no representation in the engine and
should be listed as unbuilt rather than implied.

### Credit as an authored source

A credit card is selectable in the picker for an `expense`, ranked in the user's chosen order
alongside cash accounts, and **greyed out when its headroom cannot cover the draw** — exactly as
a $0 account is. The user can knowingly put a large purchase partly on a card. The engine still
never chooses one for them.

- The **synthetic shortfall card** (`SYNTHETIC_CARD_ID`) is never pickable — an internal
  artifact conjured only when no real cards exist.
- A card with **no entered limit** is listed but disabled. `creditLimitCents` is nullable and
  null means unbounded; such a card could never grey out and could never block, making the
  picker advisory.
- `sourcesAt` must report a card's **available headroom** (`limit − balance`) from
  `liabilityBalancesCents`, not a balance from `accountBalancesCents`.

### The two axes

| | governs |
|---|---|
| **treatment** | eligibility and reporting |
| **funding strategy** | shortfall behaviour — **explicit blocks, automatic cascades** |

This replaces #171 decision 9's treatment-keyed shortfall table and retires the
**funding-deficit liability** entirely: explicit obligations block before touching state,
automatic ones cascade as they always have. Nothing needs an accounting plug.

## 7. Simulator changes

**Pre-flight before mutation.** `resolveFundingDraws` currently sells assets *inside* its loop
(`fundingDrawStep.ts:219-250`) — draw 1 liquidates before draw 2 is priced, with no transaction
boundary. The month's obligations are resolved against a scratch copy first; the block decision,
its failure category, and its alternative sources all come out of that pass, before any balance
moves.

**Suppress the blocked obligation's artifacts.** `homePurchase.apply`
(`eventHandlers.ts:254-278`) registers the property and mortgage at the purchase month
unconditionally. Because the blocked month now runs to completion, `advanceProperties` and
`advanceLiabilities` **will originate both** — a $400k house and a $320k mortgage with no cash
ever leaving. That is #177's bug re-entering through a new door. Origination must be skipped by
`sourceEventId`.

**Widen `resolveOrderedFundingDraw` to a discriminated source.** An `account` source sells and
grosses up over tax; a `credit` source borrows against headroom with no sale, no basis, no tax.
Both walk the **same ordered list in one pass**. A second pass would silently reorder
`[visa, checking]` into assets-then-credit — the substitution this design exists to prevent —
and would force the affordability gate to replicate the two-pass logic, which is exactly where
gate and simulator drift.

> This is the riskiest change in the epic. `resolveOrderedFundingDraw` is the one primitive
> shared by gate and simulator, and that sharing is what makes them agree. Its `perSource`
> result gains a `kind`; every caller assuming `grossCents`/`principalCents`/`taxCents` needs
> auditing.

## 8. Retirement solve

**`planSurvives` is a live bug the moment truncation ships.** `retirementSolver.ts:49` is
`series.months.every(monthSurvives)`, and `Array.every` over a truncated series returns `true`.
A blocked plan would report as **surviving** — the panel promising retirement at 62 beside a
graph that stops at 40, in a module whose header promises panel and graph can never disagree.
This fails in the "everything is fine" direction and is the first thing to write a test for.

**Blocked is a third state**, distinct from `null`. `null` already means "no age works, even
working to life expectancy." The two demand opposite remedies — `null` says *retire later*,
blocked says *fund the purchase differently* — so collapsing them destroys the only information
that helps. `RetirementSolution` and `RetirementEvaluation` both gain the state; every consumer
of `partialRetirementAge: number | null` learns a third case.

The panel reports *"can't compute a retirement age — your projection is blocked at age 40 by
Home purchase."*

## 9. Authoring pipeline

Both mutation planes unify onto `Projection` as the single authoring root — see §12 for the
cheaper alternatives that were rejected.

`ProjectionState` holds `plan` and `ledger` in a single `scenario` field (*"so a timeline
cannot be silently dropped"*), routes every write through one `commit()`, and serializes. Both
planes are already unified on it: React holds one `ProjectionState`, and every authored edit —
plan scalar, goal, budget line, or a job on either plane — is a `Projection` method call inside
a single `useProjection.transact`. The app builds no plan and mints no id.

That is the base this section builds on rather than a gap it has to close. What `Projection`
does not yet have is the *preview* half: every method below either commits or throws, so a
caller cannot ask what a change would cost before making it.

```
previewPlanChange(plan, change)   → structural validation + PlanChangeImpact.  Persists nothing.
applyPlanChange(expectedPlanVersion, change)
                                  → validate structure · apply · simulate · diff · persist
```

Apply revalidates from scratch and never trusts an earlier preview.

**Preview returns no projection.** The graph and retirement panel always render the **applied**
plan; nothing on screen moves until save. Preview runs a candidate projection internally, reads
the impact off it, and **discards the months**.

```ts
interface PlanChangeImpact {
  readonly blockingEvent?: EventId;
  readonly invalidatedEvents: readonly EventId[];   // blocking event first, then not-reached, timeline order
  readonly introducedWarnings: readonly Warning[];
  readonly resolvedWarnings: readonly Warning[];
}
```

Impact is `diff(currentProjection, candidateProjection)`. The current projection is already
memoized (`main.tsx`, keyed on the state the facade last committed), so an impact costs **one**
extra projection.

**Measured budget** (sample plan, 540 months):

| | cost | in preview? |
|---|---|---|
| one projection | **7.8 ms** | yes — comfortably inside a 16.7 ms frame, so the blocking warning updates every keystroke, undebounced |
| one `solveRetirement` | **171 ms** (~22 projections) | **no** — the panel reflects the applied plan, so a draft never triggers it |

**While a form is open, the retirement panel keeps rendering the last applied number.** The user
hasn't committed. The solve becomes unanswerable when the change is *applied*, not while it's
being typed.

**`expectedPlanVersion` is stale-preview detection, not concurrency control** — one in-memory
writer, no persistence to race against. A counter incremented in `commit()`.

**Affordability stops being a refusal.** `AddResult`'s conflict narrows to structural failures.
An unaffordable purchase is accepted, persisted, and reported as blocked. **Goal deletion stays
a hard refusal** — deleting a goal deletes its fund account, so an event funding from it would
hold a dangling reference. That's structural.

## 10. UI

**Graph.** Solid through the blocked month, hatched from the month *after* it. The blocking
event is displayed at the blocked month.

**Timeline.** Always shows every authored event. Executed normal; blocking event gets a blocked
indicator; later events get a not-reached indicator.

**Warnings are soft warnings** — persistent, non-dismissible, blocking nothing, rendered while
their condition holds. This is the pattern the app already ships (`homePurchaseForm.tsx:98`,
`affordability.ts` — the DTI warning). They clear only when the plan changes such that the
condition no longer holds.

A soft warning is **not** a `Nudge`. A nudge proposes a value change and is advice; a soft
warning proposes nothing, and dismissing it would not make it less true. #171's decision 10
describes blocking warnings as "advisory, dismissible" — that is aspirational text for machinery
that was never built, and it is amended by this design.

**Repair is always user-driven.** The engine never changes funding, liquidates assets, borrows,
or creates debt on the user's behalf. It recommends via `alternativeSources`; it never chooses.

## 11. Non-goals

Automatically reassigning funding sources · automatically creating loans, synthetic liabilities,
or accounting plugs · continuing simulation on hypothetical assumptions · preventing users from
authoring aspirational plans.

**Future work, explicitly out of scope:** automatic funding policies, scenario branches,
"finance shortfall" what-if projections, alternative continuation simulations, the remaining
eligibility axes (relationship settings, account restrictions, minimum retained balances).

## 12. Considered and rejected

Recorded so they aren't re-proposed in six months. Each was a genuine option, not a straw man.

### On what happens when an obligation can't be funded

**Continue past the gap on a zero-interest funding-deficit liability.** The prior decision, and
issue #177. Its diagnosis was right — a stale event must not blank the chart the user needs in
order to diagnose it — and this design keeps that: the curve up to the block renders in full and
the blocking obligation is named. What it got wrong was the remedy. Absorbing the gap into a
plug liability meant every month after it described a household that had borrowed money from
nobody. That is not an absence of fabrication; it is a quieter one. **Truncating an honest curve
beats extending a dishonest one.**

**Skip the obligation and simulate the rest of time without it.** Tempting, and arguably the
most realistic single continuation — a household that cannot afford a house simply keeps the
money. Rejected because it is still a guess about intent: the user authored a purchase, and
silently modelling decades of a life in which it never happens presents one hypothetical as *the*
projection. It also makes downstream events look affordable when their affordability was never
really tested.

**Halt at the month *before* the block**, emitting nothing for the blocked month. Rejected: that
month's other obligations, income, and growth are all real and already computed, and discarding
them costs the user a data point for nothing.

**Throw when the simulator meets an unfundable obligation.** The originating design doc's
position. Rejected: one stale event would kill the entire projection — no chart, no curve — in a
tool whose whole purpose is that curve, and which you would need in order to diagnose the
problem. It also lets an innocent, legitimate plan edit blank the whole app.

### On credit

**Spill an explicitly-funded shortfall to the credit cascade** (#171 decision 9, which routed by
treatment: `expense` → cascade). Rejected: the user named specific accounts, and charging a card
they never selected is the engine rewriting an authored funding decision — the exact thing this
feature exists to prevent.

**Block, with credit ineligible everywhere.** Rejected for the asymmetry it creates: a $500
one-time spend from an empty account would halt the projection while a $500/month budget overrun
quietly rode a card. Same money, same month, wildly different consequence.

**Resolve credit in a second pass** after assets, rather than widening
`resolveOrderedFundingDraw`. Rejected twice over. It silently reorders `[visa, checking]` into
assets-then-credit, discarding the user's stated order — substitution again. And it forces the
affordability gate to replicate the two-pass logic independently, which is precisely where gate
and simulator drift apart; `fundingDrawStep.ts` states the invariant that keeps them honest —
*"shared with the §4.5 affordability gate, so the gate blocks exactly when the sim would fall
short."*

### On the authoring pipeline

**Unify the report, not the mutation** — leave the two planes in place and derive the block
warning from the projection, which is already a pure function of `[ledger, base]`. This delivers
uniform *validation* for free and was materially cheaper. Rejected because it leaves cross-plane
atomicity unsolved and unowned, and because there is then no seam for an undo stack or any
future persistence to attach to.

**Reify changes for ledger events only**, leaving plan edits as direct state writes. Rejected as
the same gap in smaller form: the Jobs panel spans both planes, so the one case that genuinely
needs a transaction is the one this wouldn't cover.

**Revalidate every affected event on every mutation, across both planes.** Rejected for build
cost and for hostility — *"you can't raise your grocery budget because it strands a car purchase
in 2041."*

### On the retirement solve

**Fold blocked into `monthSurvives`, so a blocked plan is simply infeasible at that age.**
Cheap and consistent. Rejected: a house that can't be funded at 40 blocks at *every* candidate
retirement age, so both binary searches return `null` and the panel says **"no retirement age
works"** — false, alarming, and pointing at the wrong remedy. The block is at 40; retirement
isn't the problem.

**Let the solver skip the blocking event to answer its own question.** Rejected on sight:
"alternative continuation simulations" are explicitly out of scope, and it reintroduces the
panel/graph disagreement `retirementSolver.ts` is built to prevent.

## 13. The superseded position: full funding as an authoring-time guardrail

The prior accepted decision held that an explicitly-funded event's coverage check was *a
guardrail applied to the event being authored* — not an invariant the ledger maintains — and
that when a later edit stranded an accepted event, the simulator should record the shortfall,
flag the event **underfunded**, and keep running.

**Its central observation survives and is load-bearing here.** Full funding cannot be a ledger
invariant, because affordability depends on state edited through a completely different door:

- Plan edits are a separate mutation plane with no gate — the projection base is rebuilt on every
  budget edit and the ledger is never revalidated against it.
- Event updates are projection-free by design.
- Deleting a goal deletes its fund account, so a named funding source can vanish entirely.

**Two things about it are overturned.**

*The remedy.* The funding-deficit liability is retired (§12). An unfundable explicit obligation
now blocks rather than being plugged.

*The refusal.* That decision also kept a hard authoring-time block, and rejected dropping it on
the grounds that it is cheap and kind to stop a user authoring something broken at the moment
they author it, while they still have context and remedies. **That value is preserved in full**
by the preview warning — same moment, same information, same remedies. Only the refusal is
dropped, because refusing is what stops a planning tool from modelling the plan.

The vocabulary it introduced — **underfunded**, **funding-deficit liability** — is removed from
`CONTEXT.md`. Neither describes anything the engine will do.

## 14. Corrections to the originating PRD

Recorded so they aren't re-litigated:

1. **`simulatedThroughMonth = 59, blockedAtMonth = 60` → both are 60.** The blocked month is
   emitted; hatching starts at 61.
2. **"Only one event blocks"** → one *obligation* blocks; events are the rollup.
3. **"Not reached = occurs after the blocking event"** → after the blocked *month*, obligations
   only. Structural events carry no outcome.
4. **`insufficient-liquidity`** → `no-eligible-source-suffices`. The original name calls a
   household with $2M in retirement "insufficient."
5. **"Preview returns a projection preview"** → it doesn't. Validation + impact only.
6. **`getEligibleFundingSources`'s six axes** → two exist. The rest are unbuilt.
7. **"Credit is never a source"** → no longer true. Asserted today in `fundingLookup`'s header,
   the home-purchase gate's failure message, and #171 decision 5 (*"never emit `income` or
   `credit`"* → *"never emit `income`"*). `FundingSourceKind` already carries `"credit"`.

## 15. Epic amendments

- **#177** — superseded, not rewritten. Only *thread the shortfall out of draw resolution* and
  *never fabricate net worth* survive, and both change mechanism (pre-flight and artifact
  suppression, not a plug liability).
- **#171 decision 5** — *"never emit `income` or `credit`"* → *"never emit `income`."*
- **#171 decision 9** — the treatment-keyed shortfall table is replaced by the funding-strategy
  rule (§6). The funding-deficit liability is retired.
- **#171 decision 10** — strike "dismissible."
