import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db';

export const GET: RequestHandler = () => {
	const cfg = getConfig();

	if (!cfg.apiKey) {
		// Deterministic degradation: app runs without an LLM key.
		return json({ ok: false, reason: 'no_key' }, { status: 503 });
	}

	// Ensure the database is openable; never echo secrets.
	getDb();

	return json({
		ok: true,
		model: cfg.model,
		baseUrl: cfg.baseUrl,
		provider: 'env',
		providerOverride: 'supported',
		db: 'ok',
		degradation: 'none'
	});
};
