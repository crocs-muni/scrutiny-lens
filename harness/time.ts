// The one fixed instant every fixture and every capture agrees on, as unix
// seconds. Fixtures are dated relative to it and the browser's Date is pinned
// one hour past it, so relative labels ("14d ago") render identically on
// every run.
export const T0 = Math.floor(Date.parse('2026-11-01T12:00:00Z') / 1000);

/** What the page's `Date` reads during capture, in milliseconds. */
export const PAGE_NOW_MS = (T0 + 3_600) * 1000;
