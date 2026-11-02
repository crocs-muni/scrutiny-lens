// Under jsdom the SvelteKit plugin serves `$env/dynamic/public` from the
// client global (in the node project it reads process.env). config.ts falls
// back to its defaults when no PUBLIC_* key is set, which is what we want.
//
// No ResizeObserver stub: floating-ui feature-detects it, and these tests
// pass without one (checked), so none is carried.
(globalThis as Record<string, unknown>).__sveltekit_dev ??= { env: {} };
