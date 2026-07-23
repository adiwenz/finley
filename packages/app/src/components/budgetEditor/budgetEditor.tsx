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
 * would have been an editable field with no effect. Income stays here until #72 moves
 * it onto jobs.
 */

import type { Dispatch, SetStateAction } from "react";
import { dollarsToCents, type SharedContributionScheme } from "@finley/engine";
import type { Plan } from "@finley/engine";
import { firstDeferralLimitCrossing } from "../../deferralLimit";
import {
  careerDeferralFraction,
  careerStartAge,
  monthlyIncomeCents,
  setCareerDeferralFraction,
  setCareerStartAge,
  setMonthlyIncome,
} from "../../planPeople";
import { formatDollars } from "../../format";
import { NumInput } from "../numInput/numInput";

interface BudgetEditorProps {
  budget: Plan;
  setBudget: Dispatch<SetStateAction<Plan>>;
}

export function BudgetEditor({ budget, setBudget }: BudgetEditorProps) {
  function updateBudget(patch: Partial<Plan>) {
    setBudget((current) => ({ ...current, ...patch }));
  }

  // §5.4 disclosure: a deferral rate whose yearly total tops the IRS elective limit
  // is not an error — contributions just stop at the cap and the overflow is paid as
  // taxable income (see the waterfall's applyDeferrals). Surface the first year that
  // happens over the whole career, not just today: income and the limit grow at
  // different rates, so a plan under the cap now can cross it later.
  const deferralCrossing = firstDeferralLimitCrossing(budget);

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
          label="Monthly income"
          value={monthlyIncomeCents(budget) / 100}
          onChange={(v) => setBudget((p) => setMonthlyIncome(p, dollarsToCents(v)))}
          prefix="$"
          step={100}
        />

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

        {/* §4.6/§5.4: the age the person's SS-covered career began. Seeds the
            pre-"now" earnings record, so it fills the AIME's fixed 35-year window —
            starting later leaves fewer covered years and lowers the priced benefit.
            Clamped at ≤ current age (no future working years to seed). */}
        <NumInput
          label="Career start age"
          value={careerStartAge(budget)}
          onChange={(age) => setBudget((p) => setCareerStartAge(p, age))}
          min={14}
          max={budget.currentAge}
          step={1}
        />
        <p className="hint">
          The age you began working. Earlier means more Social-Security-covered years,
          which raises the estimated benefit. Social Security figures are an estimate,
          not advice.
        </p>

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
          <NumInput
            label="401(k) contribution"
            value={Math.round(careerDeferralFraction(budget) * 100)}
            onChange={(pct) => setBudget((p) => setCareerDeferralFraction(p, pct / 100))}
            suffix="%"
            min={0}
            step={1}
          />
          {deferralCrossing && (
            <p className="hint">
              At this rate your yearly 401(k) contribution tops the elective limit
              ({formatDollars(deferralCrossing.limitCents)} in {deferralCrossing.year}).
              Past the limit, contributions stop and the rest is paid as taxable income.
              Estimate, not advice.
            </p>
          )}
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
