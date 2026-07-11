import { streamText } from 'ai';
import { getProvider, getModel, type AIEnv } from '../provider.js';
import type { ChatRequest } from '../types.js';
import { buildPrompt } from '../context.js';

const CHAT_TIMEOUT_MS = 90_000;

export async function runChatAgent(env: AIEnv, req: ChatRequest, signal?: AbortSignal) {
	const provider = getProvider(env);
	if (!provider) {
		return new Response(
			JSON.stringify({ ok: false, kind: 'no-key', message: 'API key not configured' }),
			{ status: 503, headers: { 'content-type': 'application/json' } }
		);
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
	function onAbort() {
		controller.abort();
	}
	signal?.addEventListener('abort', onAbort);

	try {
		const { system, messages } = buildPrompt(req);
		const result = streamText({
			model: provider(getModel(env)),
			system,
			messages
		});

		return result.toTextStreamResponse();
	} catch (error: unknown) {
		if (controller.signal.aborted || signal?.aborted) {
			return new Response(
				JSON.stringify({ ok: false, kind: 'timeout', message: 'Chat request timed out' }),
				{ status: 504, headers: { 'content-type': 'application/json' } }
			);
		}
		return new Response(
			JSON.stringify({
				ok: false,
				kind: 'gateway',
				message: error instanceof Error ? error.message : String(error)
			}),
			{ status: 502, headers: { 'content-type': 'application/json' } }
		);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', onAbort);
	}
}
