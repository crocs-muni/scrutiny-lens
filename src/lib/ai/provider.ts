import { z } from 'zod';

/** Shared copy for every consumer surfacing a missing BYOK key. */
export const NO_KEY_MESSAGE = 'No API key set (open settings)';

export interface ProviderConfig {
	name: string;
	baseUrl: string;
	model: string;
	apiKey: string;
}

export interface ProviderOverrideInput {
	name?: string;
	baseUrl?: string;
	model?: string;
	apiKey?: string;
}

export type ProviderResult =
	| { ok: true; config: ProviderConfig }
	| { ok: false; kind: 'no_key' }
	| { ok: false; kind: 'invalid_request'; issues: string[] };

const overrideSchema = z.object({
	name: z.string().trim().min(1).optional(),
	baseUrl: z.string().trim().regex(/^https?:\/\/.+$/i, 'baseUrl must be an http(s) URL'),
	model: z.string().trim().min(1),
	apiKey: z.string().min(1)
});

/**
 * Resolve the active LLM provider configuration.
 *
 * ADR-018: When an override is supplied by the browser (BYOK), the override
 * `apiKey` MUST NEVER be written to logs, error messages, exceptions, or any
 * persisted store. This function enforces that contract: validation failures
 * surface only as generic issue strings; the apiKey value is never echoed.
 */
export function getProviderConfig(override?: ProviderOverrideInput): ProviderResult {
	if (override === undefined) {
		// BYOK: no server-side default key exists; the caller must supply one.
		return { ok: false, kind: 'no_key' };
	}

	const parsed = overrideSchema.safeParse(override);
	if (!parsed.success) {
		// ADR-018: never include the apiKey (or any field value) in surfaced issues.
		const issues = parsed.error.issues.map(
			(i) => `${i.path.join('.') || 'override'}: ${i.message}`
		);
		return { ok: false, kind: 'invalid_request', issues };
	}

	return {
		ok: true,
		config: {
			name: parsed.data.name ?? 'override',
			baseUrl: parsed.data.baseUrl,
			model: parsed.data.model,
			apiKey: parsed.data.apiKey
		}
	};
}
