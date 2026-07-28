---
status: accepted
---

# Full funding is an authoring-time guardrail, not a ledger invariant

An explicitly-funded event (a home down payment, a one-time spend) names the accounts that pay
for it, and the authoring API blocks it if those accounts cannot cover it at its month. That
check is a **guardrail applied to the event being authored** — not an invariant the ledger
maintains. A later plan edit may strand an already-accepted event, and when that happens the
simulator records the shortfall and flags the event **underfunded** rather than throwing.

## Why the invariant is impossible

The obvious reading — "the ledger never contains an underfunded event" — cannot be enforced,
because the affordability of an event depends on state that is edited through a completely
different door:

- **Plan edits are a separate mutation plane with no gate.** The projection base is rebuilt on
  every budget edit and the ledger is never revalidated against it. Raising a grocery line,
  lowering a return rate, or moving a retirement age can strand a purchase years away.
- **Event updates are projection-free by design.** The update path validates by replaying
  preconditions, deliberately avoiding a projection.
- **Deleting a goal deletes its fund account**, so a named funding source can vanish entirely.

Enforcing the invariant would mean gating the whole plan-editing surface on downstream ledger
events — a large build, and hostile to use: *"you can't raise your grocery budget because it
strands a car purchase in 2041."*

## Considered options

**Throw when the simulator meets an underfunded obligation.** This is what the originating
design doc specified. Rejected: one stale event would kill the entire projection — no chart, no
net-worth curve — in a tool whose entire purpose is that curve, and which you would need in
order to diagnose the problem. It also makes an innocent, legitimate plan edit capable of
blanking the whole app.

**Revalidate every affected event on every mutation, across both planes.** Rejected for the
build cost and the hostile UX above.

**Drop the authoring check entirely and let everything surface as a flag.** Rejected: it is
cheap to stop a user from authoring something broken *at the moment they author it*, when they
still have the context to fix it and the remedies (pick another account, change the amount,
move the month) are obviously available.

## Consequences

- **The simulator never throws on an underfunded obligation.** It preserves the shortfall,
  reports it in that obligation's resolved funding, and marks the event underfunded. This
  matches how insolvency already behaves — a modelled outcome that flags, not an error.
- **Net worth must never be fabricated.** Because the asset and liability an event creates are
  written unconditionally, an underfunded acquisition previously invented net worth out of the
  gap. The gap is now carried as a zero-interest funding-deficit liability instead.
- **The gate covers only the event being authored or edited.** It is *not* "no event may be
  underfunded" — that version would block every subsequent edit as soon as one event went
  stale, which is the outcome this decision exists to avoid.
- **The update path now needs a projection it does not have today.** Unlike appends, a revision
  can sit in the middle of the ledger, so the check must run against a projection of the ledger
  *with the revision applied*, then read the revised event's own month.
- **Whole-plan consequences are advisory.** An event can be affordable and still make the plan
  insolvent later. That is surfaced as a nudge, never a block.
