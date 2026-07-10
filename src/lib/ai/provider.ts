import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const DEFAULT_BASE_URL = 'https://llm.ai.e-infra.cz/v1';
export const DEFAULT_MODEL = 'coder';

export interface AIEnv {
	API_KEY?: string;
	E_INFRA_API_KEY?: string;
	BASE_URL?: string;
	MODEL?: string;
	AI_CACHE_PATH?: string;
}

export function getProvider(env: AIEnv) {
	const apiKey = env.API_KEY ?? env.E_INFRA_API_KEY;
	if (!apiKey) return null;

	return createOpenAICompatible({
		name: 'e-infra',
		baseURL: env.BASE_URL ?? DEFAULT_BASE_URL,
		apiKey
	});
}

export function getModel(env: AIEnv): string {
	return env.MODEL ?? DEFAULT_MODEL;
}

export function isKeyConfigured(env: AIEnv): boolean {
	return Boolean(env.API_KEY ?? env.E_INFRA_API_KEY);
}
