/**
 * PROTOTYPE — throwaway. Entry point for the pay-history UI variants.
 *
 * Run: `npm run dev` (repo root), then open
 *   http://localhost:5173/prototype-pay-history.html?v=a
 * The bottom bar switches variants and rewrites `?v=`, so a variant is linkable.
 *
 * State is in memory and shared across variants — switch mid-edit and the same job carries
 * over, which is the fastest way to compare how each surface presents the SAME facts.
 * Nothing here talks to the engine or persists anything.
 */

import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SEED_JOB, SEED_JOBS, type ProtoJob } from "./model";
import { StateReadout } from "./shared";
import { VariantA } from "./variantA";
import { VariantB } from "./variantB";
import { VariantC } from "./variantC";
import { VariantD } from "./variantD";
import { VariantE } from "./variantE";
import "../../../assets/styles/tokens.css";
import "../../../assets/styles/globals.css";
import styles from "./proto.module.css";

const VARIANTS = [
  { id: "a", label: "A · Pay history section" },
  { id: "b", label: "B · Minimal unblock" },
  { id: "c", label: "C · Separate editor" },
  { id: "d", label: "D · Lifetime editor" },
  { id: "e", label: "E · A’s editor + D’s graph" },
] as const;

type VariantId = (typeof VARIANTS)[number]["id"];

const initialVariant = (): VariantId => {
  const v = new URLSearchParams(window.location.search).get("v");
  return VARIANTS.some((x) => x.id === v) ? (v as VariantId) : "a";
};

function Prototype() {
  const [variantId, setVariantId] = useState<VariantId>(initialVariant);
  // Shared across variants: switching mid-edit keeps the same facts, which is the fastest way
  // to compare how each surface presents them. `jobs[0]` is the job A/B/C edit; D sees all.
  const [jobs, setJobs] = useState<readonly ProtoJob[]>(SEED_JOBS);
  const job = jobs[0];
  const setJob = (next: ProtoJob) => setJobs((js) => js.map((j, i) => (i === 0 ? next : j)));

  function pick(id: VariantId) {
    setVariantId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("v", id);
    window.history.replaceState(null, "", url);
  }

  return (
    <div className={styles.page}>
      <h1>Pay history — UI prototype</h1>
      <p className="sub">
        Throwaway. Three ways to author a job’s pay before “now”. Seeded with the scenario the
        front end can’t currently reach: $60k start, raised to $75k at 36, $80k today.
      </p>

      <div className="card">
        {variantId === "a" && <VariantA job={job} setJob={setJob} />}
        {variantId === "b" && <VariantB job={job} setJob={setJob} />}
        {variantId === "c" && <VariantC job={job} setJob={setJob} />}
        {variantId === "d" && <VariantD jobs={jobs} setJobs={setJobs} />}
        {variantId === "e" && <VariantE jobs={jobs} setJobs={setJobs} />}
      </div>

      <div className="card">
        <h2>What the engine would receive</h2>
        <p className="hint">
          Negative months are the historical half. The month-0 step is authored and deliberately
          not reconciled — see handoff-83.
        </p>
        {/* Every job, not just the first: E lets you select one, and an ended job's inert
            current-pay anchor is only checkable if it is on screen. */}
        {jobs.map((j) => (
          <div key={j.name} style={{ marginBottom: 10 }}>
            <p className="hint" style={{ margin: "0 0 4px" }}>
              <strong>{j.name}</strong> · age {j.startAge}–{j.endAge ?? "retirement"}
              {(j.endAge ?? 99) <= j.currentAge
                ? " · ended before now, so currentSalaryCents is never read"
                : ""}
            </p>
            <StateReadout job={j} />
          </div>
        ))}
        <div className={styles.formActions} style={{ marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => setJobs(SEED_JOBS)}>
            Reset to seed scenario
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setJob({ ...SEED_JOB, startingMonthlyDollars: job.currentMonthlyDollars, payChanges: [] })
            }
          >
            Flatten (no history)
          </button>
        </div>
      </div>

      <div className={styles.bar}>
        <span className={styles.barLabel}>Variant</span>
        {VARIANTS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={v.id === variantId ? styles.barActive : undefined}
            onClick={() => pick(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const rootEl = document.getElementById("app");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <Prototype />
    </StrictMode>,
  );
}
