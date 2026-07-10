import { generateStructured } from '../output.js';
import { getModel, getProvider, type AIEnv } from '../provider.js';
import { getCache, setCache } from '../cache.js';
import { FilterPlan, type AIResult } from '../types.js';
import { KNOWN_INDEXER_PREFIXES } from '../../search/modes.js';

const QUERY_PROMPT = `You translate free-text security-certificate queries into structured relay filters.

Return only a JSON object matching this schema:
{
  "interpretation": "a one-line plain-English summary of what you recognized",
  "filters": [
    {
      "mode": "identifier" | "freetext" | "browse",
      "identifier": "optional, fully-qualified identifier like cve:CVE-2017-15361 or vendor:infineon",
      "search": "optional free-text search string for freetext mode",
      "types": ["optional type tag array, e.g. scrutiny-product"]
    }
  ]
}

Rules:
- Known indexer prefixes: ${Array.from(KNOWN_INDEXER_PREFIXES).join(', ')}.
- If the query mentions a CVE, use identifier mode with "cve:CVE-YYYY-NNNN".
- If the query mentions a vendor, use identifier mode with "vendor:<name>".
- If the query mentions a certificate id (e.g. BSI-DSZ-CC-0814-2012), use identifier mode with "cc:<id>".
- Prefer identifier mode when you are confident; use freetext mode for broad or vague queries.
- Emit at most 4 filters.
- The "types" field is optional; only include it when the query clearly asks for a specific event type (product, metadata, binding, patch).
- Do not explain, only return JSON.`;

export interface QueryAgentRequest {
	query: string;
}

export async function runQueryAgent(
	env: AIEnv,
	req: QueryAgentRequest,
	signal?: AbortSignal
): Promise<AIResult<FilterPlan>> {
	const provider = getProvider(env);
	if (!provider) return { ok: false, kind: 'no-key', message: 'API key not configured' };

	const cached = getCache(env, 'query', req);
	if (cached) {
		const parsed = FilterPlan.safeParse(cached);
		if (parsed.success) return { ok: true, result: parsed.data, cached: true };
	}

	const result = await generateStructured(FilterPlan, {
		model: provider(getModel(env)),
		system: QUERY_PROMPT,
		messages: [{ role: 'user', content: req.query }],
		signal
	});

	if (!result.ok) return result;

	// Validate and normalize identifiers
	const filters = result.result.filters.filter((f) => {
		if (f.mode === 'identifier' && f.identifier) {
			const prefix = f.identifier.split(':')[0]?.toLowerCase();
			return KNOWN_INDEXER_PREFIXES.has(prefix);
		}
		return true;
	});

	const plan: FilterPlan = { ...result.result, filters };
	setCache(env, 'query', req, plan, getModel(env));
	return { ok: true, result: plan };
}
