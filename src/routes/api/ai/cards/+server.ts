import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { runCardAgent } from '$lib/ai/agents/cards.js';
import { env } from '$env/dynamic/private';
import type { NostrEvent } from '$lib/session/types.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		event?: NostrEvent;
		query?: string;
	};
	if (!body.event) error(400, 'event is required');
	if (!body.query) error(400, 'query is required');

	const result = await runCardAgent(env, { event: body.event, query: body.query }, request.signal);
	if (!result.ok) {
		return json({ ok: false, kind: result.kind, message: result.message }, { status: 503 });
	}

	return json({ ok: true, result: result.result });
};
