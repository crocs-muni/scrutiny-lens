import { generateStructured } from '../output.js';
import { getModel, getProvider, type AIEnv } from '../provider.js';
import { getCache, setCache } from '../cache.js';
import { FollowUps, type AIResult } from '../types.js';
import type { NostrEvent } from '$lib/session/types.js';

const FOLLOWUPS_PROMPT = `You suggest follow-up questions a security analyst might ask about a SCRUTINY session graph.

Return a JSON object matching this schema:
{
  "questions": ["question 1", "question 2", "question 3"]
}

Rules:
- Questions should be concrete and grounded in the provided events.
- Focus on relationships, status changes, CVE impact, EAL levels, and patch history.
- Return exactly 3 questions.
- Do not explain, only return JSON.`;

export interface FollowupsAgentRequest {
	events: NostrEvent[];
}

export async function runFollowupsAgent(
	env: AIEnv,
	req: FollowupsAgentRequest,
	signal?: AbortSignal
): Promise<AIResult<FollowUps>> {
	const provider = getProvider(env);
	if (!provider) return { ok: false, kind: 'no-key', message: 'API key not configured' };

	const cached = getCache(env, 'followups', req);
	if (cached) {
		const parsed = FollowUps.safeParse(cached);
		if (parsed.success) return { ok: true, result: parsed.data, cached: true };
	}

	const eventsJson = JSON.stringify(req.events, null, 2);
	const result = await generateStructured(FollowUps, {
		model: provider(getModel(env)),
		system: FOLLOWUPS_PROMPT,
		messages: [
			{
				role: 'user',
				content: `Suggest follow-up questions for this session graph:\n\n${eventsJson}`
			}
		],
		signal,
		temperature: 0.4
	});

	if (!result.ok) return result;

	setCache(env, 'followups', req, result.result, getModel(env));
	return result;
}
