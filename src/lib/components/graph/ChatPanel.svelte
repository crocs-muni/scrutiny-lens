<script lang="ts">
	import { Send, Sparkles, Info } from '@lucide/svelte';
	import { askChat, type AskChatResult } from '$lib/ai/client.js';
	import type { NostrEvent } from '$lib/session/types.js';
	import { renderMarkdownWithCitations, verifyQuote } from '$lib/ai/citationRender.js';
	import { createCitationRegistry, resolveGlobalCitations, remapAnswerMarkers } from '$lib/ai/citationRegistry.js';

	interface MessageCitation {
		n: number;
		id: string;
		quote: string;
		/** Whether `quote` was found verbatim in the cited event's real content. */
		verified: boolean;
	}

	interface Message {
		role: 'user' | 'assistant';
		content: string;
		citations?: MessageCitation[];
	}

	interface Props {
		events: NostrEvent[];
		rootSummary?: string;
		questions?: string[];
		onCitationHover?: (target: { id: string; n: number } | null) => void;
		onCitationClick?: (target: { id: string; n: number; quote: string; verified: boolean }) => void;
	}

	let {
		events = [],
		rootSummary = 'A SCRUTINY certification event graph.',
		questions = [],
		onCitationHover,
		onCitationClick
	}: Props = $props();
	let input = $state('');
	let messages = $state<Message[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Stable eventId -> citation-number map for this whole open chat, so
	// asking a second question that cites a node the first question already
	// cited as [2] shows [2] again instead of restarting at [1] (see
	// citationRegistry.ts). Plain mutable state, not $state -- it's internal
	// bookkeeping read only when a message finishes, not rendered directly.
	const citationRegistry = createCitationRegistry();

	function markdownToHtml(text: string, citations?: Message['citations']): string {
		return renderMarkdownWithCitations(text, citations ?? []);
	}

	function citationTarget(el: Element): { id: string; n: number; quote: string; verified: boolean } | null {
		const hit = el.closest('[data-citation]');
		if (!hit) return null;
		const n = Number(hit.getAttribute('data-citation'));
		const id = hit.getAttribute('data-citation-id');
		if (!id || Number.isNaN(n)) return null;
		const quote = hit.getAttribute('data-citation-quote') ?? '';
		const verified = hit.getAttribute('data-citation-verified') === '1';
		return { id, n, quote, verified };
	}

	function handleMessagesOver(e: MouseEvent) {
		const target = citationTarget(e.target as Element);
		if (target) onCitationHover?.({ id: target.id, n: target.n });
	}

	function handleMessagesOut(e: MouseEvent) {
		const leaving = citationTarget(e.target as Element);
		const entering = e.relatedTarget instanceof Element ? citationTarget(e.relatedTarget) : null;
		if (leaving && entering?.id !== leaving.id) onCitationHover?.(null);
	}

	function handleMessagesClick(e: MouseEvent) {
		const target = citationTarget(e.target as Element);
		if (target) onCitationClick?.(target);
	}

	function handleMessagesFocusIn(e: FocusEvent) {
		const target = citationTarget(e.target as Element);
		if (target) onCitationHover?.({ id: target.id, n: target.n });
	}

	function handleMessagesFocusOut(e: FocusEvent) {
		const leaving = citationTarget(e.target as Element);
		if (leaving) onCitationHover?.(null);
	}

	function handleMessagesKeydown(e: KeyboardEvent) {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		const target = citationTarget(e.target as Element);
		if (!target) return;
		e.preventDefault();
		onCitationClick?.(target);
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

		const { resolved, localToGlobal } = resolveGlobalCitations(citationRegistry, result.citations ?? []);
		const remappedAnswer = remapAnswerMarkers(result.answer ?? '', localToGlobal);
		const verifiedCitations: MessageCitation[] = resolved.map((c) => {
			const event = events.find((e) => e.id === c.id);
			return { ...c, verified: event ? verifyQuote(event.content, c.quote) : false };
		});

		messages[assistantIdx] = {
			...assistantMessage,
			content: remappedAnswer,
			citations: verifiedCitations
		};
		messages = [...messages];
	}
</script>

<div class="flex h-full w-[404px] flex-col border-l border-border bg-surface">
	<div class="border-b border-border bg-card px-4 py-3">
		<h3 class="text-sm font-semibold text-card-foreground">Ask about this graph</h3>
		<p class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
			<span>Grounded in {events.length} {events.length === 1 ? 'event' : 'events'} currently visible</span>
			<span
				role="img"
				aria-label="What's included in grounding"
				title="Only events behind what's currently on screen: visible nodes, plus the bindings and patch history that reference them. Collapsing a hop level or hiding deleted nodes removes them from what the assistant can see or cite."
			>
				<Info class="h-3 w-3 shrink-0" />
			</span>
		</p>
	</div>

	<!-- svelte-ignore a11y_mouse_events_have_key_events -- keyboard parity is
	     handled via onfocusin/onfocusout (which bubble, unlike focus/blur) and
	     onkeydown, since this delegates over many citation pills/buttons -->
	<div
		class="flex-1 overflow-y-auto p-4 space-y-4"
		onmouseover={handleMessagesOver}
		onmouseout={handleMessagesOut}
		onfocusin={handleMessagesFocusIn}
		onfocusout={handleMessagesFocusOut}
		onclick={handleMessagesClick}
		onkeydown={handleMessagesKeydown}
		role="presentation"
	>
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
								{@html markdownToHtml(msg.content, msg.citations)}
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
										data-citation={c.n}
										data-citation-id={c.id}
										data-citation-quote={c.quote}
										data-citation-verified={c.verified ? '1' : '0'}
										class="block w-full text-left rounded-md bg-accent px-2.5 py-1.5 text-[12px] leading-snug text-accent-foreground hover:bg-pri-tint transition-colors"
									>
										<span class="mr-1.5 font-mono text-[11px] font-bold text-primary">[{c.n}]</span>
										<span>{c.quote ? c.quote.slice(0, 140) : c.id.slice(0, 48)}</span>
										{#if !c.verified}
											<span class="ml-1 text-muted-foreground">· not verbatim</span>
										{/if}
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
	</div>

	{#if questions.length > 0 && messages.length === 0}
		<div class="px-3 pb-2">
			<div class="flex flex-wrap gap-2">
				{#each questions as q}
					<button
						type="button"
						onclick={() => submit(q)}
						disabled={loading}
						class="rounded-full border border-pri-border bg-accent px-3 py-1.5 text-xs text-accent-foreground transition-colors hover:bg-pri-tint disabled:opacity-50"
					>
						{q}
					</button>
				{/each}
			</div>
		</div>
	{/if}

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
