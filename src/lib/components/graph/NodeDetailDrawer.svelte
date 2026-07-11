<script lang="ts">
	import { X, ExternalLink, FileText, Trash2, GitCommitVertical } from '@lucide/svelte';
	import type { GraphNode, NostrEvent } from '$lib/session/types.js';
	import type { GraphNode as AIGraphNode } from '$lib/ai/types.js';

	interface Props {
		node: GraphNode | null;
		ai?: AIGraphNode | null;
		/** Patch events (scrutiny-patch) whose chain targets this node, oldest first. */
		patches?: NostrEvent[];
		onClose: () => void;
	}

	let { node, ai = null, patches = [], onClose }: Props = $props();

	const identifierList = $derived(node ? identifiers(node.event) : []);
	const attachmentList = $derived(node ? attachments(node.event) : []);

	function typeLabel(type: string) {
		return type === 'product' ? 'Certificate · Product' : 'Metadata';
	}

	function identifiers(event: NostrEvent) {
		return event.tags.filter((t) => t[0] === 'i').map((t) => t[1]);
	}

	function attachments(event: NostrEvent) {
		return event.tags
			.filter((t) => t[0] === 'imeta')
			.map((t) => {
				const url = t.find((x) => x.startsWith('url '))?.slice(4) ?? '';
				const alt = t.find((x) => x.startsWith('alt '))?.slice(4) ?? 'Attachment';
				return { url, alt };
			});
	}
</script>

{#if node}
	<div class="fixed inset-0 z-40 bg-foreground/10" onclick={onClose} role="none"></div>
	<aside class="fixed right-0 top-0 z-50 flex h-full w-[580px] flex-col border-l border-border bg-card shadow-[-24px_0_60px_-20px_rgba(15,23,42,0.4)]">
		<div class="flex items-start justify-between border-b border-border p-6">
			<div>
				<span class="inline-flex items-center rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground border border-pri-border">
					{typeLabel(node.type)}
				</span>
				<h2 class="mt-2 text-[21px] font-semibold text-card-foreground {node.retracted ? 'line-through text-muted-foreground' : ''}">
					{ai?.title ?? node.event.id.slice(0, 24)}
				</h2>
				<p class="mt-1 text-sm text-muted-foreground">{ai?.subtitle ?? node.event.pubkey.slice(0, 24)}</p>
			</div>
			<button onclick={onClose} class="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
				<X class="h-5 w-5" />
			</button>
		</div>

		<div class="flex-1 overflow-y-auto p-6">
			{#if node.retracted}
				<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
					<div class="flex items-center gap-2 text-destructive">
						<Trash2 class="h-4 w-4" />
						<span class="text-sm font-semibold">Retracted by author</span>
					</div>
					<p class="mt-1 text-sm text-foreground/80">{node.event.content}</p>
				</div>
			{/if}

			{#if ai?.summary}
				<p class="text-sm leading-relaxed text-foreground/80">{ai.summary}</p>
			{:else}
				<p class="whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">{node.event.content}</p>
			{/if}

			{#if identifierList.length > 0}
				<div class="mt-5">
					<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Identifiers</h3>
					<div class="mt-2 flex flex-wrap gap-2">
						{#each identifierList as id}
							<code class="rounded bg-accent px-2 py-1 text-xs font-mono text-accent-foreground border border-pri-border">{id}</code>
						{/each}
					</div>
				</div>
			{/if}

			<div class="mt-5 grid grid-cols-2 gap-4 border-t border-border pt-5">
				<div>
					<span class="text-xs text-muted-foreground">Kind</span>
					<p class="font-mono text-sm">{node.event.kind}</p>
				</div>
				<div>
					<span class="text-xs text-muted-foreground">Created</span>
					<p class="font-mono text-sm">{new Date(node.event.created_at * 1000).toLocaleDateString()}</p>
				</div>
				<div class="col-span-2">
					<span class="text-xs text-muted-foreground">Event ID</span>
					<p class="break-all font-mono text-xs text-muted-foreground">{node.event.id}</p>
				</div>
			</div>

			{#if patches.length > 0}
				<div class="mt-5 border-t border-border pt-5">
					<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patch history</h3>
					<div class="mt-2 space-y-2">
						{#each patches as patch (patch.id)}
							<div class="flex gap-2 rounded-md border border-border bg-surface p-2 text-sm">
								<GitCommitVertical class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
								<div class="min-w-0 flex-1">
									<p class="text-xs text-muted-foreground">{new Date(patch.created_at * 1000).toLocaleString()}</p>
									<p class="mt-0.5 whitespace-pre-wrap text-foreground/80">{patch.content}</p>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if attachmentList.length > 0}
				<div class="mt-5 border-t border-border pt-5">
					<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attachments</h3>
					<div class="mt-2 space-y-2">
						{#each attachmentList as att}
							<a href={att.url} target="_blank" class="flex items-center justify-between rounded-md border border-border bg-surface p-2 text-sm hover:border-primary">
								<span class="flex items-center gap-2"><FileText class="h-4 w-4 text-destructive" /> {att.alt}</span>
								<ExternalLink class="h-3.5 w-3.5 text-muted-foreground" />
							</a>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	</aside>
{/if}
