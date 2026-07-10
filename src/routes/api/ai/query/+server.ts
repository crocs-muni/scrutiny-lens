import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { runQueryAgent } from '$lib/ai/agents/query.js';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { query?: string };
	const query = body.query?.trim();
	if (!query) error(400, 'query is required');

	const result = await runQueryAgent(env, { query }, request.signal);
	if (!result.ok) {
		return json({ ok: false, kind: result.kind, message: result.message }, { status: 503 });
	}

	return json({ ok: true, plan: result.result });
};
