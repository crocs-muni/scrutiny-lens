import { z } from 'zod';
import { generateStructured } from '../output.js';
import { getModel, getProvider, type AIEnv } from '../provider.js';
import { getCache, setCache } from '../cache.js';
import { GraphNode, type AIResult } from '../types.js';
import type { NostrEvent } from '$lib/session/types.js';

const NODE_PROMPT = `You label a batch of Nostr SCRUTINY events for a graph view. Everything else about a node (subtitle, description) comes from its real tags/content, not you -- your only job is a short title and a few badges.

For each event, return an object matching this schema:
{
  "eventId": "the exact event id",
  "title": "short product/metadata/patch title (1 line)",
  "badges": ["short label", "cc:..."]
}

Rules:
- Use only the provided event tags and content.
- For product events, title is the product/certificate name.
- For metadata events, title is the document type (e.g. Certification Report, Security Target).
- For patch events, title is the change type (e.g. "Maintenance update").
- For deletion/retraction events, title is "Retracted".
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

	// Cache is keyed per event id (not per whole request batch) so an event
	// already summarized is never resent to the model, even if it later shows
	// up in a differently-sized batch (e.g. after a node expand). Scoped to
	// this agent -- see nodes.ts caller for why cache.ts's generic keying is
	// left alone.
	const cachedNodes: GraphNode[] = [];
	const uncachedEvents: NostrEvent[] = [];
	for (const event of req.events) {
		const cached = getCache(env, 'nodes', { eventId: event.id });
		const parsed = cached ? GraphNode.safeParse(cached) : undefined;
		if (parsed?.success) {
			cachedNodes.push(parsed.data);
		} else {
			uncachedEvents.push(event);
		}
	}

	if (uncachedEvents.length === 0) {
		return { ok: true, result: cachedNodes, cached: true };
	}

	const eventsJson = JSON.stringify(uncachedEvents, null, 2);
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

	const freshNodes = result.result.nodes.map((n, i) => ({
		...n,
		eventId: uncachedEvents[i]?.id ?? n.eventId
	}));
	for (const node of freshNodes) {
		setCache(env, 'nodes', { eventId: node.eventId }, node, getModel(env));
	}
	return { ok: true, result: [...cachedNodes, ...freshNodes] };
}
