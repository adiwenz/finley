import { useId } from "react";

/**
 * A document-unique id for a `<pattern>`. Two charts on one page sharing a literal id would have the
 * second silently redefine the first; `useId` keeps it unique. Its colons are legal in an id but not
 * in a `url(#…)` reference, so they go.
 */
export function useHatchId(prefix: string): string {
  return `${prefix}-not-simulated-${useId().replace(/:/g, "")}`;
}

/**
 * Diagonal hatch for a chart's never-simulated tail: reads as "no data here" where a flat fill could
 * be mistaken for a plotted band. The total and breakdown charts share it so the pair is read as one
 * picture. Place inside `<defs>`; reference the same `id` from the shaded area's `fill`.
 */
export function NotSimulatedHatch({ id, stroke }: { id: string; stroke: string }) {
  return (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1={0} y1={0} x2={0} y2={6} stroke={stroke} strokeWidth={1.5} strokeOpacity={0.28} />
    </pattern>
  );
}
