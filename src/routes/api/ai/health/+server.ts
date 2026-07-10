import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { env } from '$env/dynamic/private';
import { isKeyConfigured, getModel } from '$lib/ai/provider.js';

export const GET: RequestHandler = async () => {
	return json({ ok: isKeyConfigured(env), model: getModel(env) });
};
