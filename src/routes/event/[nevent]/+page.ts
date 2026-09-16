// Issue #31 share-link cold open (spec §8): the nevent is a runtime value,
// never a build-time route — keep it out of the static build's graph the
// same way the dev-only smoke route does (SPA fallback serves the app for
// every /event/<nevent> URL, and this page resolves the link at runtime).
export const prerender = false;
