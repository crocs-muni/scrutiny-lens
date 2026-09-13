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
import { gatewayFetch, GatewayError } from './gateway';

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
		// Route GET /models through the AI gateway's fetch (issue #53): it runs
		// the FIFO semaphore, per-baseUrl 429 cooldown, and retry/backoff, and
		// returns the final Response for the same mapping below.
		response = await gatewayFetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal,
			apiKey
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		// Endpoint answered but retries exhausted (e.g. a 429 that never let us
		// through, or a 5xx past maxAttempts): GatewayError carries the surviving
		// HTTP status — honest as 'http', never mislabeled 'network'. A status-less
		// GatewayError (network: true) is the CORS/mixed-content block: the request
		// never reached the server, so it is 'network'.
		if (error instanceof GatewayError) {
			if (error.network === true || error.statusCode === undefined) {
				return { ok: false, kind: 'network' };
			}
			return { ok: false, kind: 'http', status: error.statusCode ?? 0 };
		}
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
