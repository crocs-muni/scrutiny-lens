import { z } from 'zod';

export interface AppConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	relayUrls: string[];
}

const relayUrlSchema = z
	.string()
	.regex(/^wss?:\/\/.+$/i, 'must be a ws:// or wss:// URL');

const relaysSchema = z
	.string()
	.trim()
	.default('ws://localhost:8080/ws')
	.transform((s) => s.split(',').map((r) => r.trim()).filter(Boolean))
	.pipe(
		z
			.array(relayUrlSchema)
			.min(1, 'PUBLIC_RELAY_URLS must list at least 1 relay')
			.max(4, 'PUBLIC_RELAY_URLS may list at most 4 relays')
	);

export const envSchema = z.object({
	API_KEY: z.string().trim().optional(),
	BASE_URL: z
		.string()
		.trim()
		.regex(/^https?:\/\/.+$/i, 'BASE_URL must be an http(s) URL')
		.default('https://llm.ai.e-infra.cz/v1'),
	MODEL: z.string().trim().min(1).default('coder'),
	PUBLIC_RELAY_URLS: relaysSchema
});

export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
	const parsed = envSchema.parse(env);
	return {
		apiKey: parsed.API_KEY ?? '',
		baseUrl: parsed.BASE_URL,
		model: parsed.MODEL,
		relayUrls: parsed.PUBLIC_RELAY_URLS
	};
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
	return (cached ??= parseConfig(process.env));
}

/** Test helper: drop the memoized config so tests can mutate process.env. */
export function resetConfigCache(): void {
	cached = null;
}
