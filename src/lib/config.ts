/**
 * Config surface (spec §5/§8, issue #11): everything env-derived lives here.
 * No secrets exist in this app — the AI key is typed into settings and kept
 * in memory only; env carries endpoints and relay defaults at most.
 */

// No env import: $env/static/public typegen only includes vars present at
// svelte-kit sync time, so referencing an unset var breaks `pnpm check` on
// fresh clones; import.meta.env inlines the same way without that hazard.
/** Relay pool bounds (spec §8: 2–4 entries). The settings editor and the
 * settings store share these — the UI greys the row controls at the bounds
 * and setRelays throws outside them. */
export const RELAY_MIN = 2;
export const RELAY_MAX = 4;

/** Spec §5 ships a known-good default; env overrides it, not replaces it. */
const SPEC_ENDPOINT = 'https://llm.ai.e-infra.cz/v1';

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
export const DEFAULT_ENDPOINT = (import.meta.env.PUBLIC_LLM_ENDPOINT?.trim() || SPEC_ENDPOINT).replace(/\/+$/, '');
export const DEFAULT_RELAYS = parseRelayUrls(import.meta.env.PUBLIC_RELAY_URLS ?? '');
export const DEFAULT_APPEARANCE: Appearance = 'system';
