import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
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
        },
      },
    ],
  },
});
