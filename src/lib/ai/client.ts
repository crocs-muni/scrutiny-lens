import { SOURCES_SENTINEL, type Citation } from './types.js';

export interface AskChatRequest {
	question: string;
	history: Array<{ role: 'user' | 'assistant'; content: string }>;
	events: Record<string, unknown>[];
	rootSummary: string;
}

export interface AskChatOptions {
	onDelta?: (text: string) => void;
	signal?: AbortSignal;
}

export interface AskChatResult {
	ok: boolean;
	answer?: string;
	citations?: Citation[];
	kind?: string;
	message?: string;
}

export async function askChat(req: AskChatRequest, opts: AskChatOptions = {}): Promise<AskChatResult> {
	const { onDelta, signal } = opts;

	try {
		const res = await fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(req),
			signal
		});

		if (!res.ok) {
			const info = await res.json().catch(() => ({}));
			return { ok: false, kind: info.kind ?? 'gateway', message: info.message ?? `HTTP ${res.status}` };
		}

		const text = await res.text();
		return parseChatResponse(text, onDelta);
	} catch (err: unknown) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			return { ok: false, kind: 'timeout', message: 'Request was aborted' };
		}
		return { ok: false, kind: 'gateway', message: err instanceof Error ? err.message : String(err) };
	}
}

function parseChatResponse(text: string, onDelta?: (text: string) => void): AskChatResult {
	const idx = text.indexOf(SOURCES_SENTINEL);
	if (idx === -1) {
		const answer = text.trim();
		onDelta?.(answer);
		return { ok: true, answer, citations: [] };
	}

	const answer = text.slice(0, idx).trim();
	onDelta?.(answer);

	const tail = text.slice(idx + SOURCES_SENTINEL.length).trim();
	let citations: Citation[] = [];
	try {
		const raw = JSON.parse(tail);
		if (Array.isArray(raw)) {
			citations = raw.map((c: Record<string, unknown>) => ({
				n: Number(c.n ?? 0),
				id: String(c.id ?? ''),
				snippet: typeof c.snippet === 'string' ? c.snippet : undefined
			}));
		}
	} catch {
		// citations remain empty
	}

	return { ok: true, answer, citations };
}

export async function chatHealth(): Promise<{ ok: boolean; model?: string }> {
	try {
		const res = await fetch('/api/ai/health');
		if (!res.ok) return { ok: false };
		return await res.json();
	} catch {
		return { ok: false };
	}
}
