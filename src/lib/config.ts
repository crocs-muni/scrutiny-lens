/**
 * Config surface (spec §5/§8, issue #11): everything env-derived lives here.
 * No secrets exist in this app — the AI key is typed into settings and kept
 * in memory only; env carries endpoints and relay defaults at most.
 */

// $env/dynamic/public, not import.meta.env: SvelteKit never loads PUBLIC_*
// vars into import.meta.env (its typegen declares them undefined there) —
// an import.meta.env.PUBLIC_* read is ALWAYS empty (found live 2026-09-03
// while wiring the first real search). static/public's typegen hazard
// (vars frozen at sync time breaking pnpm check) is why dynamic is used.
import { env } from '$env/dynamic/public';

/** Relay pool bounds (spec §8: 1–4 entries — owner ruling 2026-09-03,
 * one working relay is a fully usable pool per spec §7). The settings
 * editor and the settings store share these — the UI greys the row
 * controls at the bounds and setRelays throws outside them. */
export const RELAY_MIN = 1;
export const RELAY_MAX = 4;

/** Spec §5 ships a known-good default; env overrides it, not replaces it. */
const SPEC_ENDPOINT = 'https://llm.fi.muni.cz/v1';

/** Spec §8 default relay pool (2026-09-17 test-corpus bootstrap: the user's
 * lens-demo relay (relay.tools/newlay) holds the full JCAlgTest + sec-certs
 * test corpora with NIP-50 search; Primal is the free public mirror that
 * accepted+retained first, verified live — other publish targets stay
 * addable through Settings; env overrides, not replaces). */
const SPEC_RELAYS = ['wss://lens-demo.feeds.relay.tools', 'wss://relay.primal.net/'];

export function parseRelayUrls(raw: string): string[] {
	const seen = new Set<string>();
	for (const part of raw.split(',')) {
		const url = part.trim();
		if (url.length > 0) seen.add(url);
	}
	return [...seen];
}

export function isValidRelayUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
	} catch {
		return false;
	}
}

export type Appearance = 'light' | 'dark' | 'system';

/** Defaults the settings store overlays. The AI-endpoint env var may point at
 * a trailing-slash URL — normalize once here so fetch paths join cleanly. */
export const DEFAULT_ENDPOINT = (env.PUBLIC_LLM_ENDPOINT?.trim() || SPEC_ENDPOINT).replace(/\/+$/, '');
export const DEFAULT_RELAYS = (() => {
	const fromEnv = parseRelayUrls(env.PUBLIC_RELAY_URLS ?? '').filter(isValidRelayUrl);
	return fromEnv.length > 0 ? fromEnv : [...SPEC_RELAYS];
})();
export const DEFAULT_APPEARANCE: Appearance = 'system';

/**
 * PUBLIC_INCLUDE_TEST_TAGS — SCRUTINY Fabric test-corpus bootstrap
 * (2026-09-16: jcalgtest re-tag + sec-certs port). When truthy ('1',
 * 'true', 'yes') the fabric seam treats the FULL-MIRROR `scrutiny-*-test`
 * t-tag namespace as first-class: admission NORMALIZES test t-tags to
 * their canonical counterparts (keeping both on the stored event), and
 * every relay query filter spans both namespaces (NIP-01 `#t` OR). Default
 * ON when unset — the upcoming test corpora are consumed by default;
 * set '0'/'false' to quarantine them again. See src/lib/fabric/test-tags.ts.
 */
/** Truthy forms accepted for PUBLIC_INCLUDE_TEST_TAGS: '1', 'true', 'yes'
 * (case-insensitive). Unset or blank counts as ON (the default); any other
 * value is false — '0'/'false' quarantine the test corpora. */
export function parseIncludeTestTags(raw: string | undefined): boolean {
	if (raw === undefined || raw.trim() === '') return true;
	return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase());
}

/** Live read: `$env/dynamic/public` resolves PUBLIC_* against process.env
 * at module load (build inlines it for the static adapter), so the value is
 * fixed per process — a function (not a frozen constant) keeps the read at
 * the same seam for the standalone verification runs, each with its own
 * process env. */
export function includeTestTags(): boolean {
	return parseIncludeTestTags(env.PUBLIC_INCLUDE_TEST_TAGS);
}
