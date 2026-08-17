/**
 * The home screen: a rail of what the household has today beside the answer that all of it adds
 * up to.
 *
 * The layout states the app's argument. The left rail is the present tense — income, spending,
 * net worth, and the life changes still ahead — and the main column is the consequence, led by a
 * single very large number. Everything in the rail is a click into the surface that edits it, so
 * the reader never has to find a menu to change what they just read.
 *
 * Below 900px the rail moves BELOW the main column (`order-2`) rather than collapsing into a
 * drawer: on a phone the answer should still come first, with the inputs underneath.
 */

import type { ReactNode } from "react";
import type { ProjectionSeries } from "@finley/engine";
import type { HomeView, LifeChangeRow, RailCard } from "../../homeView";
import { Button, Card, Icon, IconChip, EmptyState } from "../ds";
import { NetWorthPlot } from "../netWorthPlot/netWorthPlot";

export interface HomeProps {
  readonly view: HomeView;
  readonly series: ProjectionSeries;
  readonly retirementMonth: number | null;
  /** The authored plan, drawn dashed behind the chart's line while a preview is on. */
  readonly baselineSeries?: ProjectionSeries;
  readonly horizonMonths: number;
  readonly currentAge: number;
  readonly narrow: boolean;
  readonly onOpenCard: (id: RailCard["id"]) => void;
  readonly onAddChange: () => void;
  readonly onEditChange: (id: string) => void;
  /**
   * The blocked-projection advisory, when the plan stops before its horizon. Passed as a node
   * rather than data because the warning owns its own copy and alternatives — the home screen
   * only decides where it sits, which is directly under the headline it contradicts.
   */
  readonly blocked?: ReactNode;
}

/** The rail's five-at-a-time cap: enough to read the shape of a life, short of a wall of rows. */
const RAIL_EVENT_LIMIT = 5;

export function Home({
  view,
  series,
  retirementMonth,
  baselineSeries,
  horizonMonths,
  currentAge,
  narrow,
  onOpenCard,
  onAddChange,
  onEditChange,
  blocked,
}: HomeProps) {
  const shown = view.lifeChanges.slice(0, RAIL_EVENT_LIMIT);

  return (
    <>
      <aside
        aria-label="Your plan today"
        className={[
          "flex flex-col gap-2.5 bg-surface-page px-5 pt-5.5 pb-10",
          narrow
            ? "order-2 w-full shrink-0 border-t border-border-subtle"
            : "w-[308px] shrink-0 overflow-y-auto border-r border-border-subtle",
        ].join(" ")}
      >
        <div>
          <h2 className="font-display text-[19px] font-bold tracking-tight text-leaf-900">Today</h2>
          <p className="text-[14px] text-muted">{view.householdLine}</p>
        </div>

        <div className="mt-3.5 eyebrow">Current life</div>

        {view.railCards.map((card) => (
          <Card
            key={card.id}
            interactive
            label={card.label}
            onClick={() => onOpenCard(card.id)}
            className="px-4 py-3.5"
          >
            <div className="flex items-center justify-between gap-2.5">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-1.5">
                  <Icon name={card.icon} size={15} color="var(--leaf-700)" />
                  <span className="text-[14px] font-semibold text-ink-600">{card.label}</span>
                </div>
                <div className="font-mono text-[21px] font-medium tracking-tight text-leaf-900">
                  {card.value}
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted">{card.sub}</div>
              </div>
              <Icon name="chevron-right" size={18} color="var(--ink-400)" />
            </div>
          </Card>
        ))}

        <div className="mt-5.5 mb-2 flex items-center justify-between">
          <div className="eyebrow">Life changes</div>
          <span className="text-[12.5px] text-muted">{view.changeCountLabel}</span>
        </div>

        <Button variant="primary" size="sm" fullWidth iconLeft="plus" onClick={onAddChange}>
          Add life change
        </Button>

        {shown.length > 0 ? (
          <div className="mt-2.5 flex flex-col gap-0.5">
            {shown.map((change) => (
              <LifeChangeItem key={change.id} change={change} onClick={() => onEditChange(change.id)} />
            ))}
          </div>
        ) : (
          <div className="mt-2.5">
            <EmptyState
              align="left"
              title="What might change in the future?"
              body="Add a home, career change, large purchase, or other life event."
            />
          </div>
        )}
      </aside>

      <main
        className={[
          "min-w-0 flex-1 bg-surface-page",
          narrow ? "px-4.5 pt-5.5 pb-7" : "overflow-y-auto px-9 pt-7.5 pb-12",
        ].join(" ")}
      >
        <div className="mx-auto max-w-[1120px]">
          <div className="px-0 pt-1.5 pb-6.5 text-center">
            <div className="eyebrow">{view.headlineEyebrow}</div>
            <div className="mt-1.5 flex items-baseline justify-center gap-3">
              <span
                className="font-display leading-none font-extrabold tracking-[-0.03em] text-leaf-900"
                style={{ fontSize: view.unreachable ? "46px" : narrow ? "64px" : "86px" }}
              >
                {view.headlineValue}
              </span>
              {view.headlineUnit ? (
                <span className="text-[19px] text-ink-600">{view.headlineUnit}</span>
              ) : null}
            </div>
            <p className="mt-2 text-[15px] text-muted">{view.headlineSub}</p>

            {view.unreachable ? (
              <div className="mx-auto mt-3.5 max-w-[560px] rounded-card border border-sun-500 bg-sun-100 px-4.5 py-3.5 text-left">
                <div className="mb-0.5 font-semibold text-leaf-900">{view.unreachableTitle}</div>
                <p className="text-[13.5px] leading-normal text-ink-700">{view.unreachableBody}</p>
              </div>
            ) : null}

            {blocked ? <div className="mx-auto mt-3.5 max-w-[560px] text-left">{blocked}</div> : null}
          </div>

          <section className="rounded-panel border border-border-subtle bg-surface-card px-6 pt-5.5 pb-3 shadow-sm">
            <h2 className="font-display text-[21px] font-bold tracking-tight text-leaf-900">
              Net worth over time
            </h2>
            <p className="mt-0.5 text-[13.5px] text-muted">
              From today through age {currentAge + Math.round(horizonMonths / 12)} · in today’s dollars
            </p>
            <NetWorthPlot
              series={series}
              retirementMonth={retirementMonth}
              horizonMonths={horizonMonths}
              lifeChanges={view.lifeChanges}
              currentAge={currentAge}
              baseline={baselineSeries}
            />
          </section>

          {view.lifeChanges.length > 0 ? (
            <section className="mt-4.5 rounded-panel border border-border-subtle bg-surface-card px-6 pt-5 pb-5.5 shadow-sm">
              <div className="mb-4.5 flex items-center justify-between">
                <h3 className="font-display text-[17px] font-semibold text-leaf-900">
                  Your life, in order
                </h3>
                <span className="text-[13px] text-muted">Click any change to edit it</span>
              </div>
              <LifeTimeline
                changes={view.lifeChanges}
                currentAge={currentAge}
                onEdit={onEditChange}
              />
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}

function LifeChangeItem({ change, onClick }: { change: LifeChangeRow; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${change.label}, ${change.ageLabel}`}
      className="flex items-start gap-2.5 rounded-md px-2 py-2.5 text-left transition-colors duration-150 ease-standard hover:bg-surface-brand-soft"
    >
      <IconChip name={change.icon} size={30} color={change.color} background="var(--cream-100)" />
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] leading-snug font-semibold text-ink-900">
          {change.label}
        </span>
        <span className="block text-[12.5px] text-muted">{change.detail}</span>
      </span>
      <span className="pt-0.5 font-mono text-[12.5px] text-ink-400">{change.ageLabel}</span>
    </button>
  );
}

/**
 * The ordered life: "today" first, then every change on one horizontal rule.
 *
 * Scrolls horizontally at a 640px floor rather than wrapping — a life read left to right is the
 * point of the section, and a wrapped second row would read as a second life.
 */
function LifeTimeline({
  changes,
  currentAge,
  onEdit,
}: {
  changes: readonly LifeChangeRow[];
  currentAge: number;
  onEdit: (id: string) => void;
}) {
  return (
    <div className="relative overflow-x-auto px-1 pt-6.5 pb-1.5">
      <div className="absolute top-[60px] right-3 left-3 h-0.5 bg-ink-100" />
      <div className="relative flex min-w-[640px] justify-between gap-6">
        <TimelineStop age={`Age ${currentAge}`} label="Today" sub="" icon="circle-dot" color="var(--ink-200)" iconColor="var(--ink-400)" />
        {changes.map((change) => (
          <TimelineStop
            key={change.id}
            age={change.ageLabel}
            label={change.label}
            sub={change.detail}
            icon={change.icon}
            color={change.color}
            iconColor={change.color}
            onClick={() => onEdit(change.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TimelineStop({
  age,
  label,
  sub,
  icon,
  color,
  iconColor,
  onClick,
}: {
  age: string;
  label: string;
  sub: string;
  icon: LifeChangeRow["icon"];
  color: string;
  iconColor: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="mb-2 font-mono text-[13px] text-ink-600">{age}</div>
      <div className="flex h-6.5 items-center justify-center">
        <span
          className="flex h-6.5 w-6.5 items-center justify-center rounded-pill bg-surface-card"
          style={{ border: `2px solid ${color}` }}
        >
          <Icon name={icon} size={13} color={iconColor} />
        </span>
      </div>
      <div className="mt-2 text-[13.5px] leading-snug font-semibold text-ink-900">{label}</div>
      <div className="font-mono text-[12.5px] text-muted">{sub}</div>
    </>
  );

  if (!onClick) {
    return <div className="min-w-24 flex-1 text-center">{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}, ${age}`}
      className="min-w-24 flex-1 text-center"
    >
      {content}
    </button>
  );
}
