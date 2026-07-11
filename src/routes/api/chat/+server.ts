import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { runChatAgent } from '$lib/ai/agents/chat.js';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	if (!body.question?.trim()) error(400, 'question is required');

	return runChatAgent(env, body, request.signal);
};
