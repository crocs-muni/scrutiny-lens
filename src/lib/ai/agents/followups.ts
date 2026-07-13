import { generateStructured } from '../output.js';
import { getModel, getProvider, type AIEnv } from '../provider.js';
import { getCache, setCache } from '../cache.js';
import { FollowUps, type AIResult } from '../types.js';
import type { NostrEvent } from '$lib/session/types.js';

const FOLLOWUPS_PROMPT = `You suggest the most basic, natural first questions a security analyst would
ask the moment they open this session graph -- orientation questions, not deep
technical follow-ups.

Return a JSON object matching this schema:
{
  "questions": ["question 1", "question 2", "question 3"]
}

Rules:
- Ground each question in what's actually in the provided events (the real
  product/vendor name, its actual status, what it's actually bound to) --
  never invent facts. But keep the questions themselves basic and broad, the
  kind a newcomer asks first: what is this, is it still valid, what's it
  connected to, has anything changed -- not comparative or deep-dive questions.
- Each question is a short, natural sentence, roughly 4-8 words.
- Do not assume any particular field exists -- no fixed focus on EAL levels,
  CVE ids, or patch history specifically. Let whatever's actually present in
  the events guide what's askable, since not every graph has the same kinds
  of events.
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
