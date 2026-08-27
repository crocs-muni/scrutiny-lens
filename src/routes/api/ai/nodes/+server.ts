import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { batchNodeInterpret } from '$lib/server/ai/agents/nodes';

/**
 * POST /api/ai/nodes — visible events → one NodeVM per event (api.md).
 * 400 invalid_request · 503 no_key/unreachable (Retry-After: 30).
 * Provider override: body field `provider` or JSON header `x-provider-override`.
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
	events: z.array(nostrEventSchema).min(1).max(24),
	graphContext: z.object({
		rootSummary: z.string(),
		query: z.string()
	}),
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

	const res = await batchNodeInterpret({
		events: parsed.data.events,
		graphContext: parsed.data.graphContext,
		profile: parsed.data.profile,
		provider
	});

	if (!res.ok) {
		if (res.kind === 'invalid_request') {
			return json(
				{ error: res.kind, message: res.message, retryable: false },
				{ status: 400 }
			);
		}
		return json(
			{ error: res.kind, message: res.message, retryable: true },
			{ status: 503, headers: { 'retry-after': '30' } }
		);
	}

	return json(res.result);
};
