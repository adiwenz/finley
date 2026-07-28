# Issue #168 — Split starting conditions out of the month array

## Overview

`ProjectionSeries.months[0]` used to be a flow-free *opening snapshot* masquerading as a
month: it sat in the year-0 bucket, accepted events, and processed no flows. That single wart
produced two live defects — events authored at month 0 (the app's "Year 0") silently vanished,
and calendar year 0 accrued only **11** flow-months, the dominant term in the SS panel-vs-graph
discrepancy.

This change splits the opening state into its own field and makes **every** entry in
`months` a real, processed month:

- `ProjectionSeries` now carries an explicit **`opening`** — the household as it stands now,
  before any flow runs. It is what the net-worth chart draws as "today".
- `months[0..N-1]` are all processed; `months[i].month === i`; `months[0..11]` all belong to
  calendar year 0, so **year 0 now accrues a full 12 flow-months**. Every value in `months` is
  end-of-month.
- `months.length` is now exactly `horizonMonths` (was `horizonMonths + 1`): the opening
  snapshot moved out of the array rather than adding a slot, so the same span yields the same
  total number of reported points (`opening` + `horizonMonths` months).

Because the projection now models month 0, the month-0 workaround comment/gate is gone and a
Home Purchase authored at Year 0 takes its down payment instead of granting free equity.

## RGR Verification Details

- **RED (engine contract):** added `simulate.test.ts` → *"opening is the pre-flow snapshot;
  months[0] is a processed month that compounds"*. It first failed with
  `Cannot read properties of undefined (reading 'netWorthNominalCents')` — `series.opening`
  did not exist and `months[0]` was still the flow-free snapshot.
- **GREEN:** added `opening` to `ProjectionSeries`, captured it before the loop, dropped the
  `if (month > 0)` gate, and iterated `month < horizonMonths`. The test went green: `opening`
  holds the untouched $10k, `months[0]` shows one month of 7% compounding.
- **RED (acceptance regression):** added `events.homePurchase.test.ts` → *"takes the down
  payment for a purchase authored at month 0 (no free equity)"*. It failed because the
  opening snapshot still carried the purchased property (`opening.propertyValuesCents.house1`
  was $30M, not 0). Seeding only genuinely pre-existing holdings (`startMonth < 0`) into
  `opening`, and letting month-0 origination create the rest during processing, turned it
  green: `opening` is pristine and `months[0]` conserves net worth with the down payment taken.
- **Characterization:** the repo's ~260 `months[n]` assertions across 27 files ARE the
  characterization net. Each failure was classified as either a mechanical reindex
  (`months[k]` → `months[k-1]`, value unchanged) or a genuine year-boundary re-derivation, and
  the boundary set (SS covered earnings, RMD onset, tax years, CPI escalation, goal
  accumulation) was re-derived from first principles rather than renumbered.

## Key Decisions & Why

- **`months.length` = `horizonMonths` (not `+1`).** `opening` is the separate first point, so
  the total reported points are unchanged; `new months[i]` corresponds to `old months[i+1]` for
  accumulation-driven values (both apply `i+1` flow-months). This is why non-boundary
  assertions shift by exactly one index while boundary ones change value.
- **`opening` seeds only pre-existing holdings (`startMonth < 0`).** A Year-0 event is a *flow
  during month 0*, not part of "now". Properties/mortgages from a month-0 Home Purchase
  therefore open at 0 and originate during month-0 processing, keeping `opening` pristine and
  the ongoing months net-worth-conserving. This removes the free-equity bug from `opening`
  itself, not just from the later months.
- **A Year-0 `LoanEvent` originates *before* now (`startMonth = -1`).** A loan authored at
  Year 0 is a debt already carried, so it belongs in `opening` and services (and, for a card,
  absorbs shortfalls) from month 0 — a debt you have now shows up in your net worth now. A
  future-dated loan still originates at its own month. The event's own `month` is untouched;
  only the liability's origination moves, which is what the amortization schedule and
  month-0 processing key off.
- **The synthetic shortfall card is pre-existing (`startMonth = -1`).** Month 0 is a real
  processed month now; a `startMonth` of 0 would make the cascade skip the card and
  `advanceLiabilities` re-originate it that month, leaving a month-0 shortfall uncovered and
  the plan falsely insolvent at the start.
- **`fundingLookup`'s `monthAt(0)` reads `opening`.** A Year-0 purchase draws against the funds
  on hand right now; later months read that processed month's end-of-month balances, exactly
  as before. This is the faithful port of the old `months[0]`-was-opening behavior and keeps
  the affordability gate matching the simulator.
- **RMD trigger simplifies to `month % 12 === 0`.** The year's single forced distribution
  lands on the first processed month of each calendar year — now month 0 for the start year,
  not the old month-1 convention.
- **Real net worth stays indexed on the `month` field** (`toRealCents(month)`), one meaning for
  one axis; only the nominal balances and flows carry the accumulation shift.

## Changes Made

Engine (production):
- `projection/simulate.types.ts` — `ProjectionSeries` gains `opening: ProjectionMonth`;
  refreshed the `flows`/`liabilityPaymentRecords` doc comments.
- `projection/simulate.ts` — capture `opening` before the loop; drop the `if (month > 0)` gate;
  iterate `month < horizonMonths`; return `{ opening, months }`.
- `projection/runState.ts` — seed liability/property opening balances only for `startMonth < 0`;
  the synthetic shortfall card originates at `startMonth = -1`.
- `projection/rmd.ts` — `isRmdTriggerMonth` is now `month % 12 === 0`.
- `projection/snapshot.ts` — `snapshotAt` derives `horizonMonths` from `months.length` (no `-1`).
- `ledger/eventHandlers.ts` — a Year-0 `LoanEvent` produces a liability originated at `-1`.
- `ledger/addEvent.ts` — `fundingLookup`'s `monthAt(0)` returns `opening`.

App (production):
- `components/netWorthChart/netWorthChart.tsx` — the first data point is `series.opening`
  (today) at x=0; processed months plot at `month + 1`; the tooltip distinguishes "Today ·
  net worth now" from "End of month k".
- `components/baseAdjustments/baseAdjustmentsPanel.tsx` — removed the `Math.max(1, selectedMonth)`
  opening-snapshot clamp; the income readout and pay-change editor use `selectedMonth` directly.
- `components/baseAdjustments/{incomeByCategory,perLineBudget,taxesByMonth}.ts` and
  `addEventForm/homePurchaseDti.ts` — the flow-guard is now defensive, not a month-0 skip;
  comments updated (every `months` row is processed).

Tests: reindexed / re-derived ~260 assertions across 27 files; added the two RGR anchor tests
above. Value changes were reindexes where possible and first-principles re-derivations at year
boundaries (documented inline).

## Verification & Testing

```
npm run check   → check:purity ✓  typecheck ✓  vitest
Test Files  82 passed (82)
Tests  974 passed | 45 todo (1019)
```

Notable behavioral confirmations:
- `governmentBenefit.test.ts` — year 0 accrues its full 12 covered-earnings months ($60k, not
  $55k); the benefit is paid from a month-0 claim; closes the panel-vs-graph gap #34 flagged.
- `events.homePurchase.test.ts` — a Year-0 Home Purchase drains its source in `months[0]`
  (net worth conserved), with `opening` untouched.
- `rmd.test.ts` — the forced distribution fires at month 0 of the start year, once per year.

## Notes for the next iteration

- A **mid-year start is still unmodelled** (#34's remaining term): today is mid-2026, so a plan
  started now has ~5 months left in 2026, but this records 12. It makes the graph agree with the
  panel's already-optimistic full-first-year assumption — "the two SS numbers now match" is not
  "SS is now right." Do the `startMonth` (0–11) offset and calendar-anchored CPI on top of this.
- **One-Time Spend (#154) does not exist as an event type yet** — `FundingReason` has only
  `homeDownPayment`. The month-0 regression coverage here is via Home Purchase; add the
  One-Time-Spend-at-Year-0 case when that event lands.
- A **pre-existing home** can only be modelled via a Home Purchase (which takes a down payment),
  so it isn't carried in `opening`. Out of scope here; noted for whoever adds standing-property
  authoring.
