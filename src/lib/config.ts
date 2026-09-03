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
export const DEFAULT_ENDPOINT = (env.PUBLIC_LLM_ENDPOINT?.trim() || SPEC_ENDPOINT).replace(/\/+$/, '');
export const DEFAULT_RELAYS = parseRelayUrls(env.PUBLIC_RELAY_URLS ?? '').filter(isValidRelayUrl);
export const DEFAULT_APPEARANCE: Appearance = 'system';
