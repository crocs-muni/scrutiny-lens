import { z } from 'zod';
import { generateStructured } from '../output.js';
import { getModel, getProvider, type AIEnv } from '../provider.js';
import { getCache, setCache } from '../cache.js';
import { GraphNode, type AIResult } from '../types.js';
import type { NostrEvent } from '$lib/session/types.js';

const NODE_PROMPT = `You summarize a batch of Nostr SCRUTINY events into concise graph node labels.

For each event, return an object matching this schema:
{
  "eventId": "the exact event id",
  "title": "short product/metadata/patch title (1 line)",
  "subtitle": "vendor · scheme · EAL, or type/subtype context (1 line)",
  "badges": ["short label", "cc:..."],
  "summary": "1-2 sentence summary of the event's role in the graph"
}

Rules:
- Use only the provided event tags and content.
- For product events, title is the product/certificate name; subtitle is vendor · scheme · EAL.
- For metadata events, title is document type (e.g. Certification Report, Security Target); subtitle is the bound certificate id.
- For patch events, title is the change type; subtitle is the target certificate id.
- For deletion/retraction events, title is "Retracted" and summary explains why.
- Badges should include identifiers like cc:... or cve:... when present.
- Do not explain, only return the JSON array under "nodes".`;

export interface NodesAgentRequest {
	events: NostrEvent[];
}

export async function runNodesAgent(
	env: AIEnv,
	req: NodesAgentRequest,
	signal?: AbortSignal
): Promise<AIResult<GraphNode[]>> {
	const provider = getProvider(env);
	if (!provider) return { ok: false, kind: 'no-key', message: 'API key not configured' };

	const cached = getCache(env, 'nodes', req);
	if (cached) {
		const parsed = z.array(GraphNode).safeParse((cached as { nodes: unknown }).nodes);
		if (parsed.success) return { ok: true, result: parsed.data, cached: true };
	}

	const eventsJson = JSON.stringify(req.events, null, 2);
	const result = await generateStructured(z.object({ nodes: z.array(GraphNode) }), {
		model: provider(getModel(env)),
		system: NODE_PROMPT,
		messages: [
			{
				role: 'user',
				content: `Summarize the following events into graph nodes. Return a JSON object with a "nodes" array.\n\n${eventsJson}`
			}
		],
		signal,
		temperature: 0.2
	});

	if (!result.ok) return result;

	const nodes = result.result.nodes.map((n, i) => ({
		...n,
		eventId: req.events[i]?.id ?? n.eventId
	}));
	setCache(env, 'nodes', req, { nodes }, getModel(env));
	return { ok: true, result: nodes };
}
