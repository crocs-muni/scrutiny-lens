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
