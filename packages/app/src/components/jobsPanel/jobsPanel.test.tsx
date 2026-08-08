/**
 * @vitest-environment jsdom
 *
 * **The Jobs panel — one jsdom environment, five behavioural suites.**
 *
 * The panel's tests are split by what each part owns (see `jobsPanel.suites/`), but they are all
 * the same React surface rendered through the same harness, and a jsdom environment costs about a
 * second to stand up. Splitting them into five DISCOVERED files bought navigability and paid for
 * it five times over in startup.
 *
 * So this file is the only thing Vitest's `packages/*​/src/**​/*.test.{ts,tsx}` glob matches here:
 * it declares the environment and the one `afterEach(cleanup)` that unmounts between tests, and
 * imports each suite module for its side effect of registering `describe` blocks. The modules in
 * `jobsPanel.suites/` are plain `.tsx` — deliberately outside the glob — so they stay small and
 * separately navigable without each one booting a DOM of its own.
 *
 * This is a packaging decision and nothing more. It applies to several suites over ONE component;
 * a genuinely different component keeps its own entrypoint (see `jobCard.test.tsx`), and engine
 * suites stay physically split, since a Node environment is nearly free and independent targeted
 * runs are worth more there.
 *
 * To run one suite: `npx vitest run jobsPanel -t "<describe name>"`.
 */
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(cleanup);

import "./jobsPanel.suites/list";
import "./jobsPanel.suites/authoring";
import "./jobsPanel.suites/payChanges";
import "./jobsPanel.suites/oneOffAdjustments";
import "./jobsPanel.suites/continuation";
