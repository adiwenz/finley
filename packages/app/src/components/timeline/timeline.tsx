/** Timeline track: markers on the shared time axis. */

import type { LifeEvent } from "@finley/engine";
import { monthLabel } from "../../format";
import type { MarkerOutcome, TimelineMarker } from "../../ledgerView";
import styles from "./timeline.module.css";

// Left inset matches the chart's YAxis width (72) + left margin (16); right = 16.
const TRACK_LEFT = 88;
const TRACK_RIGHT = 16;

/**
 * Row-badge and track-dot presentation for the two non-executed outcomes; `executed` shows neither.
 * The one place outcome maps to markup — both surfaces read `label`/`dot`/`badge` off it.
 */
const OUTCOME_INDICATOR: Record<
  MarkerOutcome,
  { readonly label: string; readonly dot: string; readonly badge: string } | null
> = {
  executed: null,
  blocked: { label: "Blocked", dot: styles.blockedDot, badge: styles.mlBlocked },
  "not-reached": { label: "Not reached", dot: styles.notReachedDot, badge: styles.mlNotReached },
};

export function Timeline({
  markers,
  scrubMonth,
  horizonMonths,
  editableTypes,
  onScrub,
  onEdit,
  onRemove,
  removalConflicts,
}: {
  markers: readonly TimelineMarker[];
  scrubMonth: number;
  /** Full span of the axis — matches the net-worth chart so the two align. */
  horizonMonths: number;
  /**
   * The event types that have an authoring form, so their markers can offer Edit. A type with
   * no form (a debt payoff, authored elsewhere) shows Remove alone rather than a dead control.
   */
  editableTypes: ReadonlySet<LifeEvent["type"]>;
  onScrub: (month: number) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  /**
   * Which markers cannot be dropped, by id, and which OTHER event stands in the way — the
   * ledger's own replay, asked before the click rather than after it.
   *
   * Removal is the one gesture with no form to fill in first, so its refusal used to arrive as an
   * alert below the whole timeline, naming the events by id: the row that was clicked said
   * nothing, and the row responsible was not the one the reader was looking at. Answered here,
   * the control that cannot work is the one that explains itself, and it names the blocker with
   * the label already printed beside it.
   */
  removalConflicts?: ReadonlyMap<string, { readonly strandedEventId: string }>;
}) {
  // Position markers/handle as a fraction of the plan's horizon (to life expectancy).
  const pct = (month: number): string => `${(month / horizonMonths) * 100}%`;
  return (
    <div className={styles.timeline}>
      <div className={styles.trackWrap} style={{ paddingLeft: TRACK_LEFT, paddingRight: TRACK_RIGHT }}>
        <div className={styles.track}>
          <div className={styles.scrubFill} style={{ width: pct(scrubMonth) }} />
          {markers.map((m) => {
            const indicator = OUTCOME_INDICATOR[m.outcome];
            return (
              <button
                key={m.id}
                className={m.month <= scrubMonth ? styles.marker : `${styles.marker} ${styles.future}`}
                style={{ left: pct(m.month) }}
                title={`${m.label} — ${m.detail} · ${monthLabel(m.month)}${indicator ? ` · ${indicator.label}` : ""}`}
                onClick={() => onScrub(m.month)}
              >
                <span className={indicator ? `${styles.markerDot} ${indicator.dot}` : styles.markerDot} />
              </button>
            );
          })}
          <div className={styles.handle} style={{ left: pct(scrubMonth) }} aria-hidden />
        </div>
        <input
          className={styles.scrubber}
          type="range"
          min={0}
          max={horizonMonths}
          step={1}
          value={scrubMonth}
          aria-label="Scrub to a month"
          onChange={(e) => onScrub(Number(e.target.value))}
        />
      </div>

      {markers.length === 0 ? (
        <p className="hint">No life events yet. Add one to see its marker here.</p>
      ) : (
        <ul className={styles.markerList}>
          {markers.map((m) => {
            const indicator = OUTCOME_INDICATOR[m.outcome];
            return (
              <li key={m.id}>
                <span className={styles.mlWhen}>{monthLabel(m.month)}</span>
                <span className={styles.mlLabel}>{m.label}</span>
                <span className={styles.mlDetail}>{m.detail}</span>
                {indicator ? (
                  <span className={`${styles.mlOutcome} ${indicator.badge}`}>{indicator.label}</span>
                ) : null}
                {editableTypes.has(m.type) && (
                  <button className="btn link" onClick={() => onEdit(m.id)}>
                    Edit
                  </button>
                )}
                {(() => {
                  const blocked = removalConflicts?.get(m.id);
                  // Named by its own marker where there is one, so the blocker is identified by
                  // the words already on this list rather than by an id from the ledger.
                  const blocker =
                    blocked === undefined
                      ? undefined
                      : markers.find((other) => other.id === blocked.strandedEventId);
                  const why =
                    blocked === undefined
                      ? undefined
                      : blocker === undefined
                        ? "Something later on the timeline depends on this."
                        : `${blocker.label} in ${monthLabel(blocker.month)} depends on this.`;
                  return (
                    <>
                      <button
                        className="btn link"
                        disabled={blocked !== undefined}
                        title={why}
                        onClick={() => onRemove(m.id)}
                      >
                        Remove
                      </button>
                      {why !== undefined && (
                        <span className={`hint warn ${styles.mlBlockedRemove}`} role="status">
                          Can’t remove — {why}
                        </span>
                      )}
                    </>
                  );
                })()}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
