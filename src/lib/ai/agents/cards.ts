import { generateStructured } from '../output.js';
import { getModel, getProvider, type AIEnv } from '../provider.js';
import { getCache, setCache } from '../cache.js';
import { SearchCard, type AIResult } from '../types.js';
import type { NostrEvent } from '$lib/session/types.js';

const CARD_PROMPT = `You summarize a Nostr SCRUTINY event as a search result card.

Return a JSON object matching this schema:
{
  "eventId": "the exact event id",
  "title": "certificate or product name (1 line)",
  "badges": ["scheme · country", "EAL level", "status", "relevant identifier like cc:..."],
  "snippet": "2-3 sentence plain-English summary of why this event matches the query"
}

Rules:
- Use only the provided event tags and content.
- Badges should be short labels; include the certificate id if present.
- Snippet must be factual and cite concrete fields (EAL, scheme, status, CVE).
- Do not explain, only return JSON.`;

export interface CardAgentRequest {
	event: NostrEvent;
	query: string;
}

export async function runCardAgent(
	env: AIEnv,
	req: CardAgentRequest,
	signal?: AbortSignal
): Promise<AIResult<SearchCard>> {
	const provider = getProvider(env);
	if (!provider) return { ok: false, kind: 'no-key', message: 'API key not configured' };

	const cached = getCache(env, 'cards', req);
	if (cached) {
		const parsed = SearchCard.safeParse(cached);
		if (parsed.success) return { ok: true, result: parsed.data, cached: true };
	}

	const eventJson = JSON.stringify(req.event, null, 2);
	const result = await generateStructured(SearchCard, {
		model: provider(getModel(env)),
		system: CARD_PROMPT,
		messages: [
			{
				role: 'user',
				content: `Query: ${req.query}\n\nEvent:\n${eventJson}\n\nReturn the search card JSON.`
			}
		],
		signal,
		temperature: 0.2
	});

	if (!result.ok) return result;

	const card = { ...result.result, eventId: req.event.id };
	setCache(env, 'cards', req, card, getModel(env));
	return { ok: true, result: card };
}
