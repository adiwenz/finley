import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Resolve the workspace packages to their TypeScript source so engine changes
 * are visible in the UI immediately, with no build step (issue #1).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@finley/engine": fileURLToPath(
        new URL("../engine/src/index.ts", import.meta.url),
      ),
      "@finley/rules": fileURLToPath(
        new URL("../rules/src/index.ts", import.meta.url),
      ),
    },
  },
});
