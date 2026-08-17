import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Projection, planHorizonMonths } from "@finley/engine";
import { usJurisdiction } from "@finley/rules";
import { AppShell } from "./components/appShell/appShell";
import { Home } from "./components/home/home";
import { WorkspacePage } from "./components/workspace/workspacePage";
import { Drawer, Button, Section, Select, Tabs } from "./components/ds";
import { SummaryBody } from "./components/drawers/summaryBody";
import { ChangeChooser } from "./components/drawers/changeChooser";
import { ImpactPanel } from "./components/drawers/impactPanel";
import { impactView } from "./impactView";
import { homeView, abbreviateDollars, currentFlows } from "./homeView";
import { incomeSummary, spendingSummary, netWorthSummary } from "./summaryView";
import { accountsView } from "./accountsView";
import { jobsGanttView } from "./jobsGanttView";
import { onboardingState, type OnboardingAnswers } from "./onboardingInput";
import { spendingView } from "./spendingView";
import { SpendingPhases } from "./components/spendingPhases/spendingPhases";
import { SnapshotPanel } from "./components/snapshotPanel/snapshotPanel";
import { Timeline } from "./components/timeline/timeline";
import { timelineMarkers } from "./ledgerView";
import { DEFAULT_SCRUB_MONTH } from "./planDefaults";
import { Onboarding } from "./components/onboarding/onboarding";
import { JobsGantt } from "./components/jobsGantt/jobsGantt";
import { AccountsList } from "./components/accountsList/accountsList";
import { retirementView } from "./retirementView";
import { useProjection, type Transact } from "./hooks/useProjection";
import { useNarrow } from "./useNarrow";
import { START_YEAR } from "./config";
import { PRESETS, presetById, presetState, type Preset } from "./presets";
import { AddEventForm, type EventKind } from "./components/addEventForm/addEventForm";
import { EDITABLE_EVENT_TYPES } from "./components/addEventForm/editEventForm";
import { JobsPanel } from "./components/jobsPanel/jobsPanel";
import { BudgetEditor } from "./components/budgetEditor/budgetEditor";
import { BaseAdjustmentsPanel } from "./components/baseAdjustments/baseAdjustmentsPanel";
import { StartingPositionPanel } from "./components/startingPositionPanel/startingPositionPanel";
import { GoalsPanel } from "./components/goalsPanel/goalsPanel";
import { BlockedWarning } from "./components/blockedWarning/blockedWarning";
import { blockedWarning } from "./ledgerView";
import { NetWorthBreakdownChart } from "./components/netWorthChart/netWorthBreakdownChart";
import { buildNetWorthBreakdown } from "./components/netWorthChart/netWorthBreakdown";
import { DebugPanel } from "./components/debugPanel/debugPanel";
import { liabilityKindLabel, SYNTHETIC_CARD_ID } from "@finley/engine";
import { RetirementPanel } from "./components/retirementPanel/retirementPanel";
import "./assets/styles/tailwind.css";

/**
 * The state a fresh session opens on — the first preset's plan with no timeline. Built once at
 * module load, so every render starts from the same immutable `ProjectionState`.
 */
const INITIAL_STATE = presetState(PRESETS[0]);

/**
 * Which screen is showing. The app is a home screen plus four workspaces, and every editor opens
 * in a drawer OVER whichever of them is current — so this is a single flat value, not a stack.
 */
type View = "home" | "jobs" | "spending" | "accounts" | "settings";

/**
 * What the drawer is showing.
 *
 * The three summary drawers are read-only reads off the rail cards. `add` carries the chosen
 * event kind — `null` while the chooser is still asking — so picking a kind replaces the grid
 * with that kind's form inside the same drawer, without a second surface opening.
 */
type DrawerState =
  | { readonly kind: "summary"; readonly of: "income" | "spending" | "networth" }
  | { readonly kind: "add"; readonly chosen: EventKind | null }
  | { readonly kind: "event"; readonly eventId: string }
  | null;

export function App() {
  const narrow = useNarrow();
  const [view, setView] = useState<View>("home");
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [saved, setSaved] = useState(true);
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  // Whether the chart shows the "if everyone stopped working at the solved age" hypothesis rather
  // than the authored plan. A pure view flag — it never touches the state the app authors.
  const [previewRetirement, setPreviewRetirement] = useState(false);
  // Whether the jobs gantt labels its axis with calendar years or the owner's ages. A reader
  // planning a career thinks in ages; one reconciling against a payslip thinks in years.
  const [ganttLabels, setGanttLabels] = useState<"dates" | "ages">("dates");
  // Onboarding sits OVER the app rather than replacing it: the reader can cancel back to the
  // plan they already had. `null` when closed; a string is the last refusal to show on the page.
  const [onboarding, setOnboarding] = useState<{ readonly error?: string } | null>(null);
  // Which tab the Spending workspace is on: the budget as it stands, or how it moves over time.
  const [spendTab, setSpendTab] = useState<"budget" | "time">("budget");
  // The month the point-in-time section is showing. A pure view cursor — it touches no state, so
  // scrubbing re-renders without re-projecting.
  const [scrubMonth, setScrubMonth] = useState(DEFAULT_SCRUB_MONTH);
  const { state, conflict, transact, loadState } = useProjection(INITIAL_STATE);

  const plan = state.scenario.plan;
  const ledger = state.scenario.ledger;

  // One handle over the current state answers every read, so no two surfaces can disagree about
  // the same number. Keyed on `state`: navigating between views recomputes nothing.
  const projection = useMemo(() => Projection.fromState(state, usJurisdiction), [state]);
  const result = useMemo(() => projection.run(usJurisdiction), [projection]);
  const retirement = useMemo(() => retirementView(projection, usJurisdiction), [projection]);
  const home = useMemo(
    () => homeView(plan, ledger, result, retirement),
    [plan, ledger, result, retirement],
  );

  // The "what if everyone stopped working at the solved age" run — the same non-mutating boundary
  // the solver searched with, surfaced instead of discarded. Computed only when the toggle is
  // actually on AND a feasible age exists: an ordinary plan edit re-runs this memo on every
  // committed keystroke, and the toggle is off far more often than on, so gating keeps an unused
  // extra projection off the edit path. Turning it ON is what should pay for the simulation.
  const previewResult = useMemo(
    () =>
      previewRetirement && retirement.headlineAge !== null
        ? projection.runAtStopWorkingAge(usJurisdiction, retirement.headlineAge)
        : null,
    [projection, previewRetirement, retirement.headlineAge],
  );

  // The add/edit form's own funding pool excludes the draw of whatever is being edited —
  // otherwise a spend being revised would see its own prior amount as already spent,
  // understating what is available to fund the very edit in progress.
  const editingId = drawer?.kind === "event" ? drawer.eventId : undefined;
  const funding = useMemo(() => projection.funding(editingId), [projection, editingId]);

  const horizonMonths = planHorizonMonths(plan, START_YEAR);
  const currentAge = START_YEAR - plan.primary.birthYear;

  const goHome = useCallback(() => {
    setView("home");
    setDrawer(null);
  }, []);

  // Load a starter scenario wholesale: plan AND seed timeline together, floored on the way in by
  // the facade. Any open drawer is abandoned, since whatever it was editing belongs to the
  // timeline being replaced.
  const loadPreset = useCallback(
    (preset: Preset) => {
      setPresetId(preset.id);
      loadState(presetState(preset));
      setDrawer(null);
      setSaved(false);
    },
    [loadState],
  );

  // Build the five answers into a whole scenario, replacing the current plan. A refusal keeps
  // onboarding open with the engine's own reason — the reader is standing on the fields that
  // caused it, so that is where it belongs.
  const finishOnboarding = useCallback(
    (answers: OnboardingAnswers) => {
      const built = onboardingState(answers);
      if (!built.ok) {
        setOnboarding({ error: built.reason });
        return;
      }
      loadState(built.state);
      setOnboarding(null);
      setView("home");
      setDrawer(null);
      setSaved(false);
    },
    [loadState],
  );

  const goTo = useCallback((next: View) => {
    setView(next);
    setDrawer(null);
  }, []);

  // Any write leaves the plan unsaved. Threaded through one wrapper rather than set at each call
  // site so a new authoring surface cannot forget to mark the plan dirty.
  const write = useCallback<Transact>(
    (fn) => {
      const outcome = transact(fn);
      setSaved(false);
      return outcome;
    },
    [transact],
  );

  const editingEvent = useMemo(
    () =>
      drawer?.kind === "event"
        ? (ledger.events.find((e) => e.id === drawer.eventId) ?? null)
        : null,
    [drawer, ledger],
  );

  // A second solve, so it is computed only while an event's editor is actually open. `null` when
  // the counterfactual cannot be formed — a later event depends on this one, so "the plan without
  // it" is not a plan to compare against.
  const impact = useMemo(
    () =>
      drawer?.kind === "event" ? impactView(state, usJurisdiction, drawer.eventId) : null,
    [drawer, state],
  );

  const summary = useMemo(() => {
    if (drawer?.kind !== "summary") return null;
    if (drawer.of === "income") return incomeSummary(result.household, projection, result);
    if (drawer.of === "spending") return spendingSummary(projection, result);
    return netWorthSummary(projection, result.household, result);
  }, [drawer, projection, result]);

  const gantt = useMemo(
    () => jobsGanttView(result.household, projection, ganttLabels),
    [result.household, projection, ganttLabels],
  );

  // The blocked-projection soft warning, off the AUTHORED run: it names the plan as written,
  // never the retirement preview. `null` until something stops, so its mere presence IS the
  // condition holding — persistence and clearing fall out of the render.
  const blocked = useMemo(
    () => blockedWarning(ledger, result.series, funding),
    [ledger, result.series, funding],
  );

  // Names and order come through supported engine seams — account descriptors and the
  // household's liabilities, labelled by kind — never the SimAccount class, so presentation
  // stays off the sim-construction path.
  const breakdown = useMemo(() => {
    // The engine's synthetic last-resort borrowing is a revolving credit card in the model, so
    // it charts as "Credit card" debt below zero: a plan living on borrowed money (or one
    // running dry in late retirement) shows that debt rather than the composition stopping.
    const liabilityLabels: Record<string, string> = {
      [SYNTHETIC_CARD_ID]: liabilityKindLabel("creditCard"),
    };
    for (const liability of result.household.liabilities) {
      liabilityLabels[liability.id] = liabilityKindLabel(liability.kind);
    }
    return buildNetWorthBreakdown(
      result.series,
      { accounts: projection.accountDescriptors(), liabilityLabels },
      horizonMonths,
    );
  }, [result, projection, horizonMonths]);

  const spending = useMemo(
    () => spendingView(plan, ledger, result, retirement.headlineMonth),
    [plan, ledger, result, retirement.headlineMonth],
  );

  // Markers carry per-event outcomes off the AUTHORED run, not the retirement preview: the
  // timeline is an authoring surface, so a blocked/not-reached indicator must reflect the plan
  // as written.
  const markers = useMemo(() => timelineMarkers(ledger, result.series), [ledger, result.series]);

  const accounts = useMemo(
    () => accountsView(projection, result.household, result),
    [projection, result],
  );

  return (
    <AppShell
      narrow={narrow}
      saveHint={saved ? "All changes saved" : "Unsaved changes"}
      onSave={() => setSaved(true)}
      onHome={goHome}
      onSettings={() => goTo("settings")}
    >
      {view === "home" ? (
        <Home
          view={home}
          series={previewResult ? previewResult.series : result.series}
          baselineSeries={previewResult ? result.series : undefined}
          retirementMonth={retirement.headlineMonth}
          horizonMonths={horizonMonths}
          currentAge={currentAge}
          narrow={narrow}
          onOpenCard={(of) => setDrawer({ kind: "summary", of })}
          onAddChange={() => setDrawer({ kind: "add", chosen: null })}
          onEditChange={(eventId) => setDrawer({ kind: "event", eventId })}
          blocked={blocked ? <BlockedWarning warning={blocked} /> : null}
        />
      ) : null}

      {view === "jobs" ? (
        <WorkspacePage
          title="Jobs & income"
          sub="Manage your jobs and see how your income changes over time."
          onBack={goHome}
          narrow={narrow}
          summary={[
            {
              label: "Household income",
              value: abbreviateDollars((currentFlows(result.series)?.totalIncomeCents ?? 0) * 12),
              sub: "per year, before tax",
            },
          ]}
        >
          <Section
            title="Jobs over time"
            note="Every job in the household on one calendar — overlaps, gaps, and pay."
            aside={
              <Tabs
                label="Label the axis by"
                tabs={[
                  { value: "dates" as const, label: "Dates" },
                  { value: "ages" as const, label: "Ages" },
                ]}
                value={ganttLabels}
                onChange={setGanttLabels}
              />
            }
          >
            <JobsGantt view={gantt} />
          </Section>

          <Section title="Jobs" note="Click a job to edit pay, dates, or raises.">
            <JobsPanel
              budget={plan}
              transact={write}
              household={result.household}
              ledger={ledger}
              projection={projection}
              payDisplay={result.jobPayDisplay}
            />
          </Section>
        </WorkspacePage>
      ) : null}

      {view === "spending" ? (
        <WorkspacePage
          title="Spending"
          sub="Household spending, today and over your lifetime."
          onBack={goHome}
          narrow={narrow}
          summary={spending.tiles}
          tabs={{
            items: [
              { value: "budget" as const, label: "Budget today" },
              { value: "time" as const, label: "Spending over time" },
            ],
            value: spendTab,
            onChange: setSpendTab,
          }}
        >
          {spendTab === "time" ? (
            <Section
              title="How spending changes"
              note="What the household spends now, and at each change still ahead."
            >
              <SpendingPhases phases={spending.phases} />
            </Section>
          ) : null}

          <Section
            title="Spending over time"
            note="Everything you spend each month, including debt payments, in today’s dollars."
          >
            <BaseAdjustmentsPanel
              plan={plan}
              transact={write}
              series={result.series}
              personNames={
                new Map(result.household.memberships.map((m) => [m.person.id, m.person.name]))
              }
              household={result.household}
              ledger={ledger}
              projection={projection}
            />
          </Section>
        </WorkspacePage>
      ) : null}

      {view === "accounts" ? (
        <WorkspacePage
          title="Accounts"
          sub="What you own, what you owe, and how that creates your net worth."
          onBack={goHome}
          narrow={narrow}
          summary={[
            { label: "Net worth", value: accounts.netWorth, sub: "today" },
            { label: "Assets", value: accounts.assets, sub: "cash, investments, property" },
            { label: "Debt", value: accounts.debt, sub: "mortgage and loans" },
          ]}
        >
          <Section title="Accounts" note="What you own and what you owe, as of today.">
            <AccountsList view={accounts} />
          </Section>
          <Section
            title="Add what you already have"
            note="A home, a loan, or a partner you started with — recorded as day-one facts."
          >
            <StartingPositionPanel onAdd={write} />
          </Section>
          <Section
            title="What net worth is made of"
            note="How cash, investments, property and debt compose the total over time."
          >
            <NetWorthBreakdownChart data={breakdown} />
          </Section>
          <Section
            title="At a point in time"
            note="Drag through the plan to see the household’s balances and flows at any month."
          >
            <Timeline
              markers={markers}
              scrubMonth={scrubMonth}
              horizonMonths={horizonMonths}
              editableTypes={EDITABLE_EVENT_TYPES}
              onScrub={setScrubMonth}
              onEdit={(eventId) => setDrawer({ kind: "event", eventId })}
              onRemove={(id) => {
                write((p) => {
                  p.removeTransaction(id);
                  return true as const;
                });
              }}
            />
            <SnapshotPanel ledger={ledger} result={result} month={scrubMonth} />
          </Section>
          <Section title="Goals" note="What you are saving towards, and in what order.">
            <GoalsPanel budget={plan} result={result} projection={projection} transact={write} />
          </Section>
        </WorkspacePage>
      ) : null}

      {view === "settings" ? (
        <WorkspacePage
          title="Plan settings"
          sub="Adjust the assumptions we use to project your future."
          onBack={goHome}
          narrow={narrow}
        >
          <Section
            title="Household & market"
            note="Who this plan is for, and the long-run averages behind it."
          >
            <BudgetEditor budget={plan} transact={write} />
          </Section>
          <Section title="Retirement & work" note="How we decide when you can stop.">
            <RetirementPanel
              view={retirement}
              budget={plan}
              previewing={previewResult !== null}
              onTogglePreview={setPreviewRetirement}
            />
          </Section>
          <Section
            title="Model details"
            note="What the engine assumed, and the figures it started from."
          >
            {/* A plan with no months is rejected at authoring time, so `months[0]` is present. */}
            <DebugPanel
              report={result.report}
              budget={plan}
              month0={result.series.months[0]!}
            />
          </Section>
          <Section
            title="Start over"
            note="Replace this plan with a starter scenario — plan and timeline together."
          >
            <div className="mb-4">
              <Button variant="secondary" size="md" onClick={() => setOnboarding({})}>
                Build a new plan
              </Button>
            </div>
            <Select
              label="Start from a scenario"
              hint={presetById(presetId).description}
              options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
              value={presetId}
              onChange={(e) => loadPreset(presetById(e.target.value))}
            />
          </Section>
        </WorkspacePage>
      ) : null}

      {onboarding ? (
        <Onboarding
          error={onboarding.error}
          onFinish={finishOnboarding}
          onCancel={() => setOnboarding(null)}
        />
      ) : null}

      {drawer ? (
        <Drawer
          narrow={narrow}
          title={
            drawer.kind === "summary"
              ? (summary?.title ?? "Details")
              : drawer.kind === "add"
                ? "What do you want to change?"
                : "Edit this change"
          }
          sub={
            drawer.kind === "summary"
              ? summary?.sub
              : drawer.kind === "add" && drawer.chosen === null
                ? "Pick a life change to add to your plan"
                : undefined
          }
          onClose={() => setDrawer(null)}
          footer={
            editingEvent ? (
              <>
                <Button
                  variant="ghost"
                  size="md"
                  iconLeft="trash-2"
                  onClick={() => {
                    // Only close on success. A removal the facade refuses (it would orphan a
                    // later event that depends on this one) leaves the drawer open with the
                    // conflict shown — closing it would discard the only explanation the
                    // reader gets. The sentinel distinguishes success from a write that
                    // returns nothing of its own.
                    const removed =
                      write((p) => {
                        p.removeTransaction(editingEvent.id);
                        return true as const;
                      }) === true;
                    if (removed) setDrawer(null);
                  }}
                >
                  Delete
                </Button>
                <div className="flex-1" />
                <Button variant="ghost" size="md" onClick={() => setDrawer(null)}>
                  Cancel
                </Button>
              </>
            ) : undefined
          }
        >
          {conflict ? (
            <div className="rounded-card border border-berry-500 bg-berry-100 px-4 py-3 text-[13.5px] text-berry-600">
              Can’t do that yet: {conflict}
            </div>
          ) : null}

          {drawer.kind === "summary" && summary ? (
            <SummaryBody view={summary} onFollowCta={() => goTo(summary.cta.view)} />
          ) : null}

          {drawer.kind === "add" && drawer.chosen === null ? (
            <ChangeChooser onChoose={(chosen) => setDrawer({ kind: "add", chosen })} />
          ) : null}

          {drawer.kind === "add" && drawer.chosen !== null ? (
            <AddEventForm
              kind={drawer.chosen}
              result={result}
              funding={funding}
              defaultMonth={0}
              horizonMonths={horizonMonths}
              onAdd={(w) => {
                write((p) => w(p));
                setDrawer(null);
              }}
            />
          ) : null}

          {editingEvent && EDITABLE_EVENT_TYPES.has(editingEvent.type) ? (
            <AddEventForm
              result={result}
              funding={funding}
              defaultMonth={0}
              horizonMonths={horizonMonths}
              onAdd={write}
              editing={{
                event: editingEvent,
                onRevise: (w) => {
                  write((p) => {
                    w(p);
                    return true as const;
                  });
                  setDrawer(null);
                },
                onCancel: () => setDrawer(null),
              }}
            />
          ) : null}

          {editingEvent && impact ? <ImpactPanel view={impact} /> : null}

          {editingEvent && !EDITABLE_EVENT_TYPES.has(editingEvent.type) ? (
            <p className="text-[14px] text-muted">
              This change can’t be edited in place yet — remove it and add it again to change it.
            </p>
          ) : null}
        </Drawer>
      ) : null}
    </AppShell>
  );
}

const rootEl = document.getElementById("app");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
