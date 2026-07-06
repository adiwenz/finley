import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Root Vitest config. Discovers every `*.test.ts` under the workspaces and
 * resolves the `@finley/*` package names to their TypeScript source so tests
 * (e.g. in `rules`) can import the engine without a build step.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@finley/engine": fileURLToPath(
        new URL("./packages/engine/src/index.ts", import.meta.url),
      ),
      "@finley/rules": fileURLToPath(
        new URL("./packages/rules/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
  },
});
