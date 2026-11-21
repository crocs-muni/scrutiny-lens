import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig, type Plugin } from "vitest/config";
import { smokeGatewayMiddleware } from "./scripts/smoke-gateway";

/** Dev-only smoke gateway wiring (issue #54). Never applies to `vite build`. */
function smokeGateway(): Plugin {
  return {
    name: "smoke-gateway",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(smokeGatewayMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [smokeGateway(), tailwindcss(), sveltekit()],
  test: {
    // Thread pool, not the forks default: on Windows every forked test file
    // pays a full process spawn, and the suite is 85+ files of ~1 s imports.
    // Measured median: 145 s (forks) -> 100 s (threads) for the same tests.
    pool: "threads",
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "lib",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/dom/**"],
        },
      },
      {
        // Component render tests (issue #39). A docblock environment is not
        // enough for Svelte 5: mount() needs the browser build, which
        // svelteTesting() resolves (and registers auto-cleanup).
        extends: "./vite.config.ts",
        plugins: [svelteTesting()],
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/dom/**/*.test.ts"],
          setupFiles: ["tests/dom/setup.ts"],
        },
      },
    ],
  },
});
