import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { runNodesAgent } from '$lib/ai/agents/nodes.js';
import { env } from '$env/dynamic/private';
import type { NostrEvent } from '$lib/session/types.js';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { events?: NostrEvent[] };
	if (!body.events || !Array.isArray(body.events)) error(400, 'events array is required');

	const result = await runNodesAgent(env, { events: body.events }, request.signal);
	if (!result.ok) {
		return json({ ok: false, kind: result.kind, message: result.message }, { status: 503 });
	}

	return json({ ok: true, result: result.result });
};
