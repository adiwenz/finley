/**
 * Budget/Accounts panel (§4.2, §10.2) — person-partitioned ongoing numbers plus a
 * Shared section, all edited directly (no timeline event, §10.3). Advanced knobs
 * (account return, pre-tax deferral %) are progressively disclosed behind the
 * plain number (§10.4). The Shared section carries two of the four waterfall
 * levers (split scheme, surplus destination); the deferral % is the third and
 * goal priority (the fourth) lives in the Goals panel.
 *
 * Spending is NOT edited here. The line-item budget (Base + Adjustments) is the single
 * source of truth for expenses — a non-empty `Plan.budgetLines` replaces the scalar
 * `expenseCents` series outright (`projectionBase.ts`), so a second scalar control
 * would have been an editable field with no effect. Earned income is likewise NOT edited
 * here: the Jobs panel is the single authoring surface for jobs (salary, span, 401(k)),
 * so income, the age a career began, and the pre-tax deferral all live per-job there.
 */

import type { Dispatch, SetStateAction } from "react";
import { dollarsToCents, type SharedContributionScheme } from "@finley/engine";
import type { Plan } from "@finley/engine";
import { NumInput } from "../numInput/numInput";

interface BudgetEditorProps {
  budget: Plan;
  setBudget: Dispatch<SetStateAction<Plan>>;
}

export function BudgetEditor({ budget, setBudget }: BudgetEditorProps) {
  function updateBudget(patch: Partial<Plan>) {
    setBudget((current) => ({ ...current, ...patch }));
  }

  return (
    <>
      <h2>Budget &amp; accounts</h2>
      <p className="hint">Edit ongoing numbers directly — this doesn’t add a timeline event.</p>

      {/* One section per household member. This slice has a single member; the
          shape is partitioned so partners drop in as their own sections (§4.2). */}
      <section className="budget-member" aria-label={`${budget.name || "You"}’s budget`}>
        <label className="field name-field">
          <span className="field-label">Name</span>
          <input
            type="text"
            value={budget.name}
            onChange={(e) => updateBudget({ name: e.target.value })}
          />
        </label>

        <NumInput
          label="Monthly health care (before 65)"
          value={budget.healthMonthlyCents / 100}
          onChange={(v) => updateBudget({ healthMonthlyCents: dollarsToCents(v) })}
          prefix="$"
          step={50}
        />
        <label className="field">
          <span className="field-label">Medicare at 65</span>
          <select
            value={budget.enrollsInPublicHealthCoverage ? "enroll" : "self-fund"}
            onChange={(e) => updateBudget({ enrollsInPublicHealthCoverage: e.target.value === "enroll" })}
          >
            <option value="enroll">Enroll at 65 (health steps down)</option>
            <option value="self-fund">Self-fund for life (no step)</option>
          </select>
        </label>
        {budget.enrollsInPublicHealthCoverage && (
          <NumInput
            label="Monthly health care (from 65)"
            value={budget.postCoverageHealthMonthlyCents / 100}
            onChange={(v) => updateBudget({ postCoverageHealthMonthlyCents: dollarsToCents(v) })}
            prefix="$"
            step={50}
          />
        )}
        <NumInput
          label="Health cost increase"
          value={budget.healthInflationPct}
          onChange={(healthInflationPct) => updateBudget({ healthInflationPct })}
          suffix="%/yr"
          min={0}
          max={20}
          step={0.5}
        />
        <p className="hint">
          A separate line from your other expenses, growing at its own rate — medical
          costs often rise faster than general inflation. Both figures are in today’s
          dollars. Estimate, not advice.
        </p>

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

        {/* §7: the life-stage ages the retirement solver counts from and reports
            against — current age is "now", retirement age is the pinned target the
            panel scores on-track %, life expectancy is how long the money must last.
            The bounds chain them so the plan stays ordered (current ≤ retirement ≤
            life expectancy); the fields clamp to these on blur. */}
        <NumInput
          label="Current age"
          value={budget.currentAge}
          onChange={(currentAge) => updateBudget({ currentAge })}
          min={18}
          max={Math.min(100, budget.retirementAge)}
          step={1}
        />
        <NumInput
          label="Retirement age"
          value={budget.retirementAge}
          onChange={(retirementAge) => updateBudget({ retirementAge })}
          min={Math.max(40, budget.currentAge)}
          max={Math.min(80, budget.lifeExpectancy)}
          step={1}
        />
        <NumInput
          label="Life expectancy"
          value={budget.lifeExpectancy}
          onChange={(lifeExpectancy) => updateBudget({ lifeExpectancy })}
          min={Math.max(60, budget.retirementAge)}
          max={120}
          step={1}
        />

        {/* §5.4: the pinned Social Security claiming age (62–70). The retirement
            solver reads it — benefits begin at this age, so delaying raises the
            monthly benefit but pushes it later. An estimate, not advice. */}
        <NumInput
          label="Social Security claiming age"
          value={budget.benefitClaimingAge}
          onChange={(benefitClaimingAge) => updateBudget({ benefitClaimingAge })}
          min={62}
          max={70}
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

        {/* §10.4: the plain numbers are above; the rate and deferral lever are
            disclosed on demand rather than shown by default. */}
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
      </section>
    </>
  );
}
