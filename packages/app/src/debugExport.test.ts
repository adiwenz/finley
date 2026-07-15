import { describe, it, expect } from "vitest";
import { debugExportFilename } from "./debugExport";

describe("debugExportFilename", () => {
  it("is filesystem-safe and sortable", () => {
    expect(debugExportFilename(new Date("2026-07-15T14:30:00Z"))).toBe(
      "finley-debug-2026-07-15-14-30-00.json",
    );
  });
});
