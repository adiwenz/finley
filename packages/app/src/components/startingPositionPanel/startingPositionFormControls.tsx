/** Shared props for the starting-position forms. No month — a holding's date is the now marker,
 *  not a caller choice (see engine `PRE_NOW_MONTH`), so these forms ask for none. */

import type { Projection } from "@finley/engine";

export interface StartingPositionFormProps {
  /** Run one transaction against a momentary {@link Projection}, same as every event form. */
  onAdd: (write: (projection: Projection) => void) => void;
  /** Called after a successful submit, so the panel can collapse the open form. */
  onDone: () => void;
}
