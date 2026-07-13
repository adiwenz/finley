/** Timeline track: markers on the shared time axis (§10.2). */

import { HORIZON_MONTHS } from "../../config";
import { monthLabel } from "../../format";
import type { TimelineMarker } from "../../ledgerView";
import styles from "./timeline.module.css";

// Left inset matches the chart's YAxis width (72) + left margin (16); right = 16.
const TRACK_LEFT = 88;
const TRACK_RIGHT = 16;

function pct(month: number): string {
  return `${(month / HORIZON_MONTHS) * 100}%`;
}

export function Timeline({
  markers,
  scrubMonth,
  onScrub,
  onUndo,
}: {
  markers: readonly TimelineMarker[];
  scrubMonth: number;
  onScrub: (month: number) => void;
  onUndo: (id: string) => void;
}) {
  return (
    <div className={styles.timeline}>
      <div className={styles.trackWrap} style={{ paddingLeft: TRACK_LEFT, paddingRight: TRACK_RIGHT }}>
        <div className={styles.track}>
          <div className={styles.scrubFill} style={{ width: pct(scrubMonth) }} />
          {markers.map((m) => (
            <button
              key={m.id}
              className={m.month <= scrubMonth ? styles.marker : `${styles.marker} ${styles.future}`}
              style={{ left: pct(m.month) }}
              title={`${m.label} — ${m.detail} · ${monthLabel(m.month)}`}
              onClick={() => onScrub(m.month)}
            >
              <span className={styles.markerDot} />
            </button>
          ))}
          <div className={styles.handle} style={{ left: pct(scrubMonth) }} aria-hidden />
        </div>
        <input
          className={styles.scrubber}
          type="range"
          min={0}
          max={HORIZON_MONTHS}
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
          {markers.map((m) => (
            <li key={m.id}>
              <span className={styles.mlWhen}>{monthLabel(m.month)}</span>
              <span className={styles.mlLabel}>{m.label}</span>
              <span className={styles.mlDetail}>{m.detail}</span>
              <button className="btn link" onClick={() => onUndo(m.id)}>
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
