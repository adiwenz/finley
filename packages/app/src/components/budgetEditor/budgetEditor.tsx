/**
 * Budget/Accounts panel — person-partitioned ongoing numbers plus a Shared section, all
 * edited directly (no timeline event). Advanced knobs (account return, pre-tax deferral %)
 * are disclosed behind the plain number. Shared carries two of the four waterfall levers
 * (split scheme, surplus destination); deferral % is the third and goal priority the
 * fourth, in the Goals panel.
 *
 * Spending is NOT edited here: the line-item budget (Base + Adjustments) is the single
 * source of truth, since `Plan.budgetLines` is the sole expense authoring surface
 * (`projectionBase.ts`) — a second spending control would edit nothing. Earned income
 * likewise: the Jobs panel is the single authoring surface, so salary, span, career start
 * and 401(k) deferral all live per-job there.
 */

import {
  AGE_LIMITS,
  MAX_AGE,
  MAX_LIVED_AGE,
  dollarsToCents,
  type SharedContributionScheme,
  type SurplusCashDestination,
} from "@finley/engine";
import type { Plan, PlanPatch } from "@finley/engine";
import type { Transact } from "../../hooks/useProjection";
import { NumInput } from "../numInput/numInput";
import { START_YEAR } from "../../config";

interface BudgetEditorProps {
  budget: Plan;
  transact: Transact;
}

export function BudgetEditor({ budget, transact }: BudgetEditorProps) {
  /**
   * Every control here writes a standing scalar, which is exactly what `updatePlan` takes —
   * {@link PlanPatch} cannot reach the collections, so no knob on this panel can touch a goal,
   * job or budget line by accident.
   */
  function updateBudget(patch: PlanPatch) {
    transact((p) => p.updatePlan(patch));
  }

  return (
    <>
      <p className="hint">Edit ongoing numbers directly — this doesn’t add a timeline event.</p>

      {/* One section per household member — a single member today, but partitioned so
          partners drop in as their own sections. */}
      <section className="budget-member" aria-label={`${budget.primary.name || "You"}’s budget`}>
        <label className="field name-field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={budget.primary.name}
            onChange={(e) => updateBudget({ name: e.target.value })}
          />
        </label>

        {/* Health has no section here. It is an ordinary `healthcare`-category budget line
            now, authored and edited in Base + Adjustments like every other recurring expense,
            so a second surface for it would be a second source of truth. */}

        <NumInput
          label="General inflation (CPI)"
          value={budget.inflationPct}
          onChange={(inflationPct) => updateBudget({ inflationPct })}
          suffix="%/yr"
          min={0}
          max={20}
          step={0.5}
        />
        <p className="hint">
          Income and general expenses grow at this rate each year; it’s also the rate
          used to show today’s-dollars (real) figures. Estimate, not advice.
        </p>

        {/* The two life-stage ages the retirement solver counts between: current age is "now",
            life expectancy how long the money must last. No retirement age sits between them any
            more — each job states its own end, and when the household COULD stop working is
            solved and reported in the Retirement panel rather than authored here. A field that
            also ended jobs could only ever contradict one of them.

            The engine stores a fixed `birthYear` (like a partner's), not a floating "current
            age" — re-projecting the same plan against a later "now" no longer ages the primary
            forward on its own. This field is the ergonomic exception: it still asks for an age
            and converts it to a birth year against the app's own frozen `START_YEAR`, once, on
            each edit — the same "now" every other surface in this app already treats as fixed.

            Every age names the engine's ceiling for that field rather than restating a number: a
            form that disagreed with `AGE_LIMITS` by a digit would author a plan the engine then
            refuses. Life expectancy reaches the ceiling itself (120); current age stops one short
            of it (`MAX_LIVED_AGE`, 119), since a person who is already 120 has no plan left to
            project; the claiming age stops at 70, the top of the legal window. The bounds chain
            directly now, across the one pair that is left; fields clamp on blur. */}
        <NumInput
          label="Current age"
          value={START_YEAR - budget.primary.birthYear}
          onChange={(currentAge) => updateBudget({ birthYear: START_YEAR - currentAge })}
          min={18}
          max={Math.min(MAX_LIVED_AGE, budget.primary.lifeExpectancy)}
          step={1}
        />
        <NumInput
          label="Life expectancy"
          value={budget.primary.lifeExpectancy}
          onChange={(lifeExpectancy) => updateBudget({ lifeExpectancy })}
          min={Math.max(60, START_YEAR - budget.primary.birthYear)}
          max={MAX_AGE}
          step={1}
        />

        {/* The pinned Social Security claiming age (62–70), read by the retirement solver:
            delaying raises the monthly benefit but pushes it later. Estimate, not advice. */}
        <NumInput
          label="Social Security claiming age"
          value={budget.primary.benefitClaimingAge}
          onChange={(benefitClaimingAge) => updateBudget({ benefitClaimingAge })}
          min={62}
          max={AGE_LIMITS.benefitClaimingAge}
          step={1}
        />
        <p className="hint">
          Benefits begin at this age (claim earlier for a smaller monthly check, later
          for a larger one). Social Security figures are an estimate, not advice.
        </p>

        <NumInput
          label="Opening balance"
          value={budget.openingBalanceCents / 100}
          onChange={(v) => updateBudget({ openingBalanceCents: dollarsToCents(v) })}
          prefix="$"
          step={1000}
        />

        {/* Plain numbers above; the rate and deferral levers disclose on demand. */}
        <details className="advanced">
          <summary>Advanced</summary>
          <NumInput
            label="Savings return"
            value={budget.savingsReturnPct}
            onChange={(savingsReturnPct) => updateBudget({ savingsReturnPct })}
            suffix="%"
            min={0}
            step={0.5}
          />
          <NumInput
            label="Retirement return"
            value={budget.retirementReturnPct}
            onChange={(retirementReturnPct) => updateBudget({ retirementReturnPct })}
            suffix="%"
            min={0}
            step={0.5}
          />
          <NumInput
            label="Brokerage return"
            value={budget.brokerageReturnPct}
            onChange={(brokerageReturnPct) => updateBudget({ brokerageReturnPct })}
            suffix="%"
            min={0}
            step={0.5}
          />
        </details>
      </section>

      <hr className="divider" />

      <section className="budget-shared" aria-label="Shared">
        <h3>Shared</h3>

        <label className="field">
          <span className="field-label">Shared expenses split</span>
          <select
            value={budget.sharedScheme}
            onChange={(e) =>
              updateBudget({ sharedScheme: e.target.value as SharedContributionScheme })
            }
          >
            <option value="proportional">Proportional to income</option>
            <option value="even">Split evenly</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">Surplus cash goes to</span>
          <select
            value={budget.surplusCashTo ?? "savings"}
            onChange={(e) =>
              updateBudget({ surplusCashTo: e.target.value as SurplusCashDestination })
            }
          >
            <option value="savings">Cash savings (idle)</option>
            <option value="brokerage">Brokerage (invested)</option>
          </select>
        </label>
        <p className="hint">
          Where each month’s leftover cash lands after your goals and contributions are
          funded. “Cash savings” earns your savings return; “Brokerage” invests it at the
          brokerage return instead.
        </p>
      </section>
    </>
  );
}
