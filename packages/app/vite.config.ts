import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * Resolve the workspace packages to their TypeScript source so engine changes
 * are visible in the UI immediately, with no build step.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
