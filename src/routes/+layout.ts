// Pure SPA (spec §8): no SSR, no server. The static fallback page boots the
// client router for every URL, incl. deep /event/<nevent> links.
export const ssr = false;
