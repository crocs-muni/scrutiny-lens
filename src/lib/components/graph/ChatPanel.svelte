<script lang="ts">
	import { Send, Sparkles } from '@lucide/svelte';
	import { askChat, type AskChatResult } from '$lib/ai/client.js';
	import type { NostrEvent } from '$lib/session/types.js';
	import { marked } from 'marked';
	import DOMPurify from 'isomorphic-dompurify';

	interface Message {
		role: 'user' | 'assistant';
		content: string;
		citations?: Array<{ n: number; id: string; snippet?: string }>;
	}

	interface Props {
		events: NostrEvent[];
		rootSummary?: string;
		questions?: string[];
	}

	let { events = [], rootSummary = 'A SCRUTINY certification event graph.', questions = [] }: Props = $props();
	let input = $state('');
	let messages = $state<Message[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	function markdownToHtml(text: string): string {
		const raw = marked.parse(text, { async: false }) as string;
		return DOMPurify.sanitize(raw);
	}

	function eventsAsPlain(): Record<string, unknown>[] {
		return events.map((e) => ({
			id: e.id,
			pubkey: e.pubkey,
			kind: e.kind,
			created_at: e.created_at,
			tags: e.tags,
			content: e.content
		}));
	}

	async function submit(q?: string) {
		const question = (q ?? input).trim();
		if (!question || loading) return;
		if (!q) input = '';

		messages.push({ role: 'user', content: question });
		error = null;
		loading = true;

		let answer = '';
		const assistantMessage: Message = { role: 'assistant', content: '' };
		messages = [...messages, assistantMessage];
		const assistantIdx = messages.length - 1;

		const result = await askChat(
			{
				question,
				history: messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
				events: eventsAsPlain(),
				rootSummary
			},
			{
				onDelta(text) {
					answer = text;
					messages[assistantIdx] = { ...assistantMessage, content: answer };
					messages = [...messages];
				}
			}
		);

		loading = false;

		if (!result.ok) {
			error = result.message ?? 'Chat request failed';
			messages[assistantIdx] = {
				...assistantMessage,
				content: result.message ?? 'Chat request failed.'
			};
			messages = [...messages];
			return;
		}

		messages[assistantIdx] = {
			...assistantMessage,
			content: result.answer ?? '',
			citations: result.citations
		};
		messages = [...messages];
	}
</script>

<div class="flex h-full w-[404px] flex-col border-l border-border bg-surface">
	<div class="border-b border-border bg-card px-4 py-3">
		<h3 class="text-sm font-semibold text-card-foreground">Ask about this graph</h3>
		<p class="text-xs text-muted-foreground">Answers are grounded in the resolved session graph.</p>
	</div>

	<div class="flex-1 overflow-y-auto p-4 space-y-4">
		{#if messages.length === 0}
			<div class="flex justify-end">
				<div class="max-w-[86%] rounded-[12px_12px_4px_12px] bg-primary px-3.5 py-2.5 text-[13px] text-primary-foreground">
					What can you tell me about this certification lineage?
				</div>
			</div>
			<div class="flex justify-start">
				<div class="max-w-[88%] rounded-xl border border-border bg-card px-3.5 py-3 text-[13.5px] leading-[1.65] text-foreground/80">
					<div class="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
						<Sparkles class="h-3.5 w-3.5" /> SCRUTINY
					</div>
					I have loaded {events.length} events in this session. Ask me anything about their contents, relationships, or trust status.
				</div>
			</div>
		{/if}

		{#each messages as msg, i}
			{#if msg.role === 'user'}
				<div class="flex justify-end">
					<div class="max-w-[86%] rounded-[12px_12px_4px_12px] bg-primary px-3.5 py-2.5 text-[13px] text-primary-foreground">
						{msg.content}
					</div>
				</div>
			{:else}
				<div class="flex justify-start">
					<div class="max-w-[88%] rounded-xl border border-border bg-card px-3.5 py-3 text-[13.5px] leading-[1.65] text-foreground/80">
						<div class="mb-2 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
							<Sparkles class="h-3.5 w-3.5" /> SCRUTINY
						</div>
						{#if msg.content}
							<div class="prose prose-sm max-w-none prose-headings:text-sm prose-headings:font-semibold prose-a:text-primary prose-code:text-xs prose-code:font-mono">
								{@html markdownToHtml(msg.content)}
							</div>
						{:else if loading && i === messages.length - 1}
							<div class="flex items-center gap-2 text-muted-foreground">
								<span class="animate-pulse">Thinking</span>
								<span class="animate-bounce text-primary">.</span>
								<span class="animate-bounce text-primary" style="animation-delay: 0.2s">.</span>
								<span class="animate-bounce text-primary" style="animation-delay: 0.4s">.</span>
							</div>
						{/if}

						{#if msg.citations && msg.citations.length > 0}
							<div class="mt-3 pt-3 border-t border-border space-y-1.5">
								<p class="text-[11px] font-semibold text-muted-foreground">Sources</p>
								{#each msg.citations as c}
									<button
										type="button"
										class="block w-full text-left rounded-md bg-accent px-2.5 py-1.5 text-[12px] leading-snug text-accent-foreground hover:bg-pri-tint transition-colors"
									>
										<span class="mr-1.5 font-mono text-[11px] font-bold text-primary">[{c.n}]</span>
										<span>{c.snippet ? c.snippet.slice(0, 140) : c.id.slice(0, 48)}</span>
									</button>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{/if}
		{/each}

		{#if error}
			<div class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">{error}</div>
		{/if}

		{#if questions.length > 0}
			<div class="flex flex-wrap gap-2 pt-2">
				{#each questions as q}
					<button
						type="button"
						onclick={() => submit(q)}
						disabled={loading}
						class="rounded-full border border-pri-border bg-accent px-3 py-1.5 text-xs text-accent-foreground hover:bg-pri-tint disabled:opacity-50"
					>
						{q}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="border-t border-border p-3">
		<form
			onsubmit={(e) => { e.preventDefault(); submit(); }}
			class="flex items-end gap-2 rounded-[11px] border border-border bg-card p-2"
		>
			<input
				bind:value={input}
				disabled={loading}
				placeholder="Ask a question..."
				class="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
			/>
			<button
				type="submit"
				disabled={loading || !input.trim()}
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
			>
				<Send class="h-4 w-4" />
			</button>
		</form>
	</div>
</div>
