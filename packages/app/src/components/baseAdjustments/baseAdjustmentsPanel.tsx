/**
 * The **Base + Adjustments** budget editor (§18–§20, "UI: Base + Adjustments" of
 * JOBS_HOUSEHOLD_REDESIGN, issue #71). Direct rendering of the mockup:
 *
 *   - **Base** — the standing line-item budget, prepopulated from a default template
 *     (or the %-quickstart) and edited in place (AC3).
 *   - **Adjustments** — one affordance with a one-time-vs-recurring toggle and a
 *     near-term-month vs long-horizon-age anchor, routed to the right primitive by
 *     {@link routeAdjustment} — one-time → ledger, recurring spend → line override,
 *     income → job/stream (AC4, AC5). There is no `Adjustment` entity underneath.
 *   - **Graph** — the per-line monthly budget, drawn from the engine's per-line
 *     *actually funded* map, visibly starving the lowest-priority line in a shortfall
 *     (AC2).
 *
 * The panel owns the line-item budget locally and runs its own {@link Projection}
 * (jurisdiction-injected at `run`) to graph it — additive alongside the app's scalar
 * pipeline, which the #72 hinge later rewires onto this model.
 */

import { useMemo, useState } from "react";
import {
  Projection,
  dollarsToCents,
  budgetLineAllocationId,
  type BudgetLine,
  type BudgetLineOverride,
  type Plan,
} from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { START_YEAR } from "../../config";
import { formatDollars } from "../../format";
import { NumInput } from "../numInput/numInput";
import { defaultBudgetTemplate, quickstartFromIncome } from "./budgetTemplate";
import {
  routeAdjustment,
  type Adjustment,
  type AdjustmentAnchor,
  type AdjustmentRoute,
} from "./adjustmentRouting";
import { buildPerLineBudgetData, type ChartLine } from "./perLineBudget";
import { PerLineBudgetChart } from "./perLineBudgetChart";
import styles from "./baseAdjustments.module.css";

/** Coerce a template input (id always set) into a full standing {@link BudgetLine}. */
function asLine(input: ReturnType<typeof defaultBudgetTemplate>[number]): BudgetLine {
  return { ...input, id: input.id ?? input.label } as BudgetLine;
}

const literalCents = (line: BudgetLine): number =>
  line.amountSource.kind === "literal" ? line.amountSource.monthlyCents : 0;

/** A short, human summary of a routed adjustment — surfaced so the routing is visible. */
function describeRoute(route: AdjustmentRoute): string {
  switch (route.kind) {
    case "ledgerTransaction":
      return `→ one-time ledger transaction at month ${route.month} (${formatDollars(route.amountCents)})`;
    case "lineOverride":
      return `→ dated override on "${route.lineId}" from month ${route.override.month} (${formatDollars(route.override.monthlyCents)})`;
    case "incomeOverride":
      return `→ job/stream income override at month ${route.month} (${formatDollars(route.amountCents)})`;
  }
}

export function BaseAdjustmentsPanel({ plan }: { plan: Plan }) {
  const [lines, setLines] = useState<BudgetLine[]>(() => defaultBudgetTemplate().map(asLine));

  // Adjustment form state.
  const [target, setTarget] = useState<Adjustment["target"]>("spend");
  const [timing, setTiming] = useState<Adjustment["timing"]>("recurring");
  const [anchorKind, setAnchorKind] = useState<AdjustmentAnchor["kind"]>("month");
  const [anchorValue, setAnchorValue] = useState(12);
  const [amount, setAmount] = useState(500);
  const [lineId, setLineId] = useState<string>(() => defaultBudgetTemplate()[0]?.id ?? "");
  const [lastRoute, setLastRoute] = useState<AdjustmentRoute | null>(null);

  function setLineAmount(id: string, dollars: number): void {
    setLines((prev) =>
      prev.map((l) =>
        l.id === id
          ? { ...l, amountSource: { kind: "literal", monthlyCents: dollarsToCents(dollars) } }
          : l,
      ),
    );
  }

  function applyQuickstart(): void {
    setLines(quickstartFromIncome(plan.incomeCents).map(asLine));
  }

  function applyOverride(id: string, override: BudgetLineOverride): void {
    setLines((prev) =>
      prev.map((l) =>
        l.id === id ? { ...l, overrides: [...(l.overrides ?? []), override] } : l,
      ),
    );
  }

  function applyAdjustment(): void {
    const anchor: AdjustmentAnchor =
      anchorKind === "month"
        ? { kind: "month", month: anchorValue }
        : { kind: "age", age: anchorValue };
    const adjustment: Adjustment = {
      target,
      timing,
      anchor,
      amountCents: dollarsToCents(amount),
      ...(target === "spend" ? { lineId } : {}),
    };
    const route = routeAdjustment(adjustment, { currentAge: plan.currentAge });
    setLastRoute(route);
    // A recurring spend change actually lands on the standing line (the other two
    // primitives route to the ledger / a job — the app's scalar pipeline owns those,
    // rewired onto this model in #72).
    if (route.kind === "lineOverride") applyOverride(route.lineId, route.override);
  }

  // Run this budget's own projection and derive the per-line funded chart data.
  const chartData = useMemo(() => {
    const projection = Projection.create({
      plan: { ...plan, budgetLines: lines },
      startYear: START_YEAR,
    });
    const result = projection.run(usJurisdiction);
    const chartLines: ChartLine[] = lines.map((l) => ({
      id: budgetLineAllocationId(l.id),
      label: l.label,
      intendedCents: literalCents(l),
    }));
    return buildPerLineBudgetData(result.series, chartLines);
  }, [plan, lines]);

  return (
    <section className="card">
      <h2>Base + Adjustments</h2>

      {/* ── Base: the standing budget, prepopulated and editable (AC3) ── */}
      <div>
        <div className="row-between">
          <h3>Base budget</h3>
          <button className="btn" onClick={applyQuickstart} type="button">
            Quickstart from income (50/30/20)
          </button>
        </div>
        {lines.map((line) => (
          <div key={line.id} className={styles.lineRow}>
            <span className={styles.lineLabel}>
              {line.label} <span className={styles.tier}>{line.category}</span>
            </span>
            <NumInput
              label={line.label}
              value={Math.round(literalCents(line) / 100)}
              onChange={(v) => setLineAmount(line.id, v)}
              prefix="$"
              step={50}
            />
          </div>
        ))}
      </div>

      {/* ── Adjustments: one affordance, routed per §20 (AC4, AC5) ── */}
      <div>
        <h3>Add an adjustment</h3>
        <div className={styles.adjustGrid}>
          <label className="field">
            <span className="field-label">What changes</span>
            <select
              aria-label="What changes"
              value={target}
              onChange={(e) => setTarget(e.target.value as Adjustment["target"])}
            >
              <option value="spend">Spending / contribution</option>
              <option value="income">Income (raise / stream)</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">How often</span>
            <select
              aria-label="How often"
              value={timing}
              onChange={(e) => setTiming(e.target.value as Adjustment["timing"])}
            >
              <option value="recurring">Recurring</option>
              <option value="oneTime">One-time</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">When (anchor)</span>
            <select
              aria-label="When anchor"
              value={anchorKind}
              onChange={(e) => setAnchorKind(e.target.value as AdjustmentAnchor["kind"])}
            >
              <option value="month">Near-term month</option>
              <option value="age">At age (milestone)</option>
            </select>
          </label>

          <NumInput
            label={anchorKind === "month" ? "Month" : "Age"}
            value={anchorValue}
            onChange={setAnchorValue}
          />

          <NumInput label="Amount" value={amount} onChange={setAmount} prefix="$" step={50} />

          {target === "spend" && (
            <label className="field">
              <span className="field-label">Which line</span>
              <select
                aria-label="Which line"
                value={lineId}
                onChange={(e) => setLineId(e.target.value)}
              >
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <button className="btn primary" onClick={applyAdjustment} type="button">
          Apply adjustment
        </button>
        {lastRoute && (
          <p className={styles.routeEcho} data-testid="adjustment-route">
            {describeRoute(lastRoute)}
          </p>
        )}
      </div>

      {/* ── Graph: per-line funded budget; starved line shows in a shortfall (AC2) ── */}
      <div>
        <h3>Monthly budget by line</h3>
        <PerLineBudgetChart data={chartData} />
      </div>
    </section>
  );
}
