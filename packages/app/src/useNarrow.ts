/**
 * The app's single breakpoint, as state.
 *
 * 900px is where the rail stops fitting beside the chart and the drawer stops fitting beside the
 * page. Both must switch together — a bottom-sheet drawer over a side-by-side layout tears — so
 * one hook answers it for the whole tree rather than each surface writing its own media query.
 */

import { useEffect, useState } from "react";

export const NARROW_BREAKPOINT_PX = 900;

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < NARROW_BREAKPOINT_PX,
  );

  useEffect(() => {
    // Absent in jsdom, and absent is the honest answer there: a test environment has no viewport
    // to be narrow, so the wide layout stands rather than the hook throwing on mount.
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return narrow;
}
