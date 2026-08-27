import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { suggestFollowups } from '$lib/server/ai/agents/followups';

/**
 * POST /api/ai/followups — question + answer + rootSummary → ≤3 follow-ups.
 * The agent degrades to a static generic set on any LLM failure, so any valid
 * body yields 200; only a malformed body is a 400.
 * Provider override: body field `provider` or JSON header `x-provider-override`.
 */

const providerSchema = z.object({
	name: z.string().trim().min(1).optional(),
	baseUrl: z.string().trim().min(1).optional(),
	model: z.string().trim().min(1).optional(),
	apiKey: z.string().min(1).optional()
});

const bodySchema = z.object({
	question: z.string().min(1),
	answer: z.string().min(1),
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

	const res = await suggestFollowups({
		question: parsed.data.question,
		answer: parsed.data.answer,
		rootSummary: parsed.data.rootSummary,
		profile: parsed.data.profile,
		provider
	});

	// suggestFollowups never fails honestly — on LLM failure it returns the
	// static degrade set with ok:true.
	return json({ followUps: res.ok ? res.result : [] });
};
