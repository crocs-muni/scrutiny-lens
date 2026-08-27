/**
 * W5 · Followups agent — question + answer + rootSummary → ≤3 suggested
 * follow-up questions.
 *
 * Zod-array gated via generateStructured (exactly one repair-retry inside).
 * Follow-ups are a convenience, never load-bearing: ANY failure (no key,
 * unreachable, schema) degrades to a static generic set rather than an error.
 */

import { z } from 'zod';
import {
	generateStructured,
	type AIResult,
	type CallLLM
} from '../output';
import type { ProviderOverrideInput } from '../../provider';
import { buildSystemPrompt, DEFAULT_PROFILE } from '../prompts/vocabCcd';

export const MAX_FOLLOWUPS = 3;

/** Static degrade set used on any LLM failure. */
export const STATIC_FOLLOWUPS: string[] = [
	'Which nodes on this graph are archived?',
	'Show the bound vulnerabilities',
	'Summarise the root product'
];

const followUpsSchema = z.array(z.string().min(1).max(100)).max(MAX_FOLLOWUPS);

export interface SuggestFollowupsOptions {
	question: string;
	answer: string;
	rootSummary: string;
	profile?: string;
	provider?: ProviderOverrideInput;
	abortSignal?: AbortSignal;
	/** Test seam; defaults to the real generateText transport. */
	callLLM?: CallLLM;
}

export async function suggestFollowups(
	opts: SuggestFollowupsOptions
): Promise<AIResult<string[]>> {
	const profile = opts.profile ?? DEFAULT_PROFILE;
	const res = await generateStructured({
		schema: followUpsSchema,
		system: buildSystemPrompt({ profile }),
		messages: [
			{
				role: 'user',
				content: [
					`Graph root: ${opts.rootSummary}`,
					`The user asked: ${opts.question}`,
					`The assistant answered: ${opts.answer}`,
					'',
					`Suggest up to ${MAX_FOLLOWUPS} short follow-up questions (≤100 chars each) the visible graph can plausibly answer.`,
					'Respond with JSON only: an array of question strings, no prose.'
				].join('\n')
			}
		],
		provider: opts.provider,
		callLLM: opts.callLLM,
		abortSignal: opts.abortSignal
	});

	if (!res.ok) return { ok: true, result: [...STATIC_FOLLOWUPS] };
	return { ok: true, result: res.result.slice(0, MAX_FOLLOWUPS) };
}
