import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { chatground } from '$lib/server/ai/agents/chat';
import { getProviderConfig } from '$lib/server/provider';

/**
 * POST /api/chat — grounded chat over the visible graph, REAL SSE streaming.
 *
 * Response: text/event-stream of
 *   data: {"type":"delta", ...} ×N → data: {"type":"final", ...}
 * (mid-stream failures surface as data: {"type":"error", ...} before close).
 *
 * Pre-stream errors only: 400 invalid_request · 503 no_key (Retry-After: 30).
 * The request's abortSignal (client disconnect) is wired through to the LLM
 * call. Provider override: body field `provider` or JSON header
 * `x-provider-override`.
 */

const providerSchema = z.object({
	name: z.string().trim().min(1).optional(),
	baseUrl: z.string().trim().min(1).optional(),
	model: z.string().trim().min(1).optional(),
	apiKey: z.string().min(1).optional()
});

const nostrEventSchema = z.object({
	id: z.string(),
	sig: z.string(),
	pubkey: z.string(),
	created_at: z.number(),
	kind: z.number(),
	tags: z.array(z.array(z.string())),
	content: z.string()
});

const bodySchema = z.object({
	question: z.string().min(1),
	history: z
		.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
		.max(20)
		.default([]),
	visibleEvents: z.array(nostrEventSchema).max(50).default([]),
	rootSummary: z.string(),
	profile: z.enum(['smartcard', 'certificate', 'generic']).optional(),
	provider: providerSchema.optional()
});

function invalid(issues: string[]): Response {
	return json({ error: 'invalid_request', issues }, { status: 400 });
}

export const POST: RequestHandler = async ({ request }) => {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return invalid(['body is not valid JSON']);
	}

	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return invalid(
			parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
		);
	}

	// Header fallback for the provider override (body field takes precedence).
	let provider = parsed.data.provider;
	const header = request.headers.get('x-provider-override');
	if (!provider && header) {
		let headerJson: unknown;
		try {
			headerJson = JSON.parse(header);
		} catch {
			return invalid(['x-provider-override header is not valid JSON']);
		}
		const h = providerSchema.safeParse(headerJson);
		if (!h.success) return invalid(h.error.issues.map((i) => i.message));
		provider = h.data;
	}

	// Pre-stream envelope errors (everything later rides the SSE error frame).
	const provRes = getProviderConfig(provider);
	if (!provRes.ok) {
		return json(
			{ error: 'invalid_request', message: provRes.issues.join('; '), retryable: false },
			{ status: 400 }
		);
	}
	if (!provRes.config.apiKey) {
		return json(
			{ error: 'no_key', message: 'No API key configured', retryable: true },
			{ status: 503, headers: { 'retry-after': '30' } }
		);
	}

	const stream = chatground({
		question: parsed.data.question,
		history: parsed.data.history,
		visibleEvents: parsed.data.visibleEvents,
		rootSummary: parsed.data.rootSummary,
		profile: parsed.data.profile,
		provider,
		abortSignal: request.signal
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
};
