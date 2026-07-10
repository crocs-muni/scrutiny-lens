import { generateObject, type LanguageModel } from 'ai';
import { type ZodSchema } from 'zod';
import type { AIResult, AIErrorKind } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GenerateOptions {
	model: LanguageModel;
	system: string;
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	temperature?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function generateStructured<T>(
	schema: ZodSchema<T>,
	options: GenerateOptions
): Promise<AIResult<T>> {
	const { model, system, messages, temperature = 0.2, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	function onAbort() {
		controller.abort();
	}
	signal?.addEventListener('abort', onAbort);

	try {
		const { object } = await generateObject({
			model,
			schema,
			system,
			messages,
			temperature,
			abortSignal: controller.signal
		});

		return { ok: true, result: object };
	} catch (error) {
		if (controller.signal.aborted || signal?.aborted) {
			return fail('timeout', 'LLM request timed out');
		}
		return fail('gateway', error instanceof Error ? error.message : String(error));
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', onAbort);
	}
}

function fail(kind: AIErrorKind, message: string): { ok: false; kind: AIErrorKind; message: string } {
	return { ok: false, kind, message };
}
