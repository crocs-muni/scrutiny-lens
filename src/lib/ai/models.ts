// Live model list for the settings combobox (issue #11, spec §5): fetched
// from the user's configured endpoint, zod-gated like every AI surface.
// Failures surface as kinds so the dialog can name what happened; nothing
// throws, and the key never appears in a result (ADR-018).
//
// Path-probe note: the connection test fetches `${base}/models`, while the
// chat lane posts to `${base}/chat/completions` (same base, same origin, same
// CORS preflight triggers — the models GET carries the same Authorization
// header). A test that succeeds while chat fails therefore means path routing
// on the server (e.g. a base missing /v1), not a CORS block — CORS would take
// both down together.

import { z } from 'zod';

export type ModelsResult =
	| { ok: true; models: string[] }
	| { ok: false; kind: 'http'; status: number }
	| { ok: false; kind: 'invalid' }
	| { ok: false; kind: 'network' };

const modelListSchema = z.object({
	data: z.array(z.object({ id: z.string().min(1) }))
});

export async function fetchModels(
	baseUrl: string,
	apiKey: string,
	signal?: AbortSignal
): Promise<ModelsResult> {
	const url = `${baseUrl.replace(/\/+$/, '')}/models`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		return { ok: false, kind: 'network' };
	}
	if (!response.ok) return { ok: false, kind: 'http', status: response.status };
	const parsed = modelListSchema.safeParse(await response.json().catch(() => null));
	if (!parsed.success) return { ok: false, kind: 'invalid' };
	return {
		ok: true,
		models: [...new Set(parsed.data.data.map((m) => m.id))].sort()
	};
}
