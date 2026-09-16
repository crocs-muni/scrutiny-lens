<!--
	SHARE POPOVER — the spec §9 share affordance (bits-ui Popover, §9 L94),
	mounted in the detail drawer's header (BIBLE L1090: 'Share — copies link').
	Two copy channels from one event (spec §1 L22):
	  - link      — `${origin}${base}event/<nevent1…>` opens this record again
	  - nostr: URI — the NIP-21 form every other nostr client understands
	Both encode the SAME nevent: id + ≤3 seen-on relay hints + author +
	kind TLVs. Seen-on relays are recorded by transport ingest (Slice A);
	when IDB has none yet the nevent carries id+author+kind only — an honest
	gap (a harder cold-open, not a fake address). Machine strings stay mono
	(spec §9 writing rule L108); values middle-clip, full text on hover.

	The IDB read is async, so links compute lazily on popover open and the
	rows show a transient '…' while pending. Icon flips to a check on copy,
	timed like ResultCard/CitationPill (1200ms).
-->
<script lang="ts">
	import type { NostrEvent } from 'nostr-tools';
	import { Popover } from 'bits-ui';
	import { IconCheck, IconShare } from '@tabler/icons-svelte';
	import { seenOnRelays } from '$lib/net/seen-on';
	import { buildShareLinks } from '$lib/share/deep-link';
	import { clipMiddle } from '$lib/text';

	interface Props {
		/** The dossier's subject event — id/author/kind/seen-on are what the
		 * nevent encodes; the rest of the event never leaves this component. */
		subject: NostrEvent;
	}

	let { subject }: Props = $props();

	let open = $state(false);
	let url = $state('');
	let nostrUri = $state('');
	let copied: 'link' | 'nostr' | null = $state(null);

	/** Lazily (re)compute on open and every dossier swap — the seen-on read
	 * is an IDB round-trip keyed to the CURRENT subject; a failed read means
	 * no hints, never an unbuildable address. */
	async function computeLinks(subj: NostrEvent): Promise<void> {
		url = '';
		nostrUri = '';
		let seen: string[] = [];
		try {
			seen = await seenOnRelays(subj.id);
		} catch {
			// IDB unavailable (private mode): share hintless — honest, still opens.
			seen = [];
		}
		// Stale-write guard: the dossier may have swapped during the IDB read.
		if (subj.id !== subject.id) return;
		const links = buildShareLinks(subj, seen);
		url = links.url;
		nostrUri = links.nostrUri;
	}

	$effect(() => {
		const subj = subject;
		if (open) void computeLinks(subj);
	});

	/** One clipboard path for both channels; the row names which one
	 * flipped via the transient flag. */
	async function copy(which: 'link' | 'nostr', text: string): Promise<void> {
		await navigator.clipboard.writeText(text);
		copied = which;
		setTimeout(() => (copied = null), 1200);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		aria-label="Share this record"
		title="Share — copies link"
		class="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
	>
		<IconShare size={16} stroke-width={2} />
	</Popover.Trigger>
	<Popover.Portal>
		<!-- side=top: the trigger sits in the 32px drawer-header handle, so the
			surface opens upward into the canvas, never off the viewport edge. -->
		<Popover.Content
			side="top"
			align="end"
			sideOffset={6}
			collisionPadding={12}
			class="z-50 flex w-[300px] flex-col gap-1 rounded-card border border-line bg-surface p-2 shadow-overlay"
		>
			{@render row('link', 'Copy link', url)}
			{@render row('nostr', 'Copy nostr: URI', nostrUri)}
		</Popover.Content>
	</Popover.Portal>
</Popover.Root>

{#snippet row(which: 'link' | 'nostr', label: string, value: string)}
	<button
		type="button"
		disabled={value === ''}
		class="flex w-full flex-col gap-0.5 rounded-control px-2 py-1.5 text-left transition-colors duration-100 hover:bg-hover disabled:opacity-80"
		onclick={() => void copy(which, value)}
	>
		<span class="flex items-center gap-1.5 text-[12px] font-medium text-ink">
			{#if copied === which}
				<IconCheck size={13} stroke-width={2} class="shrink-0 text-green" />
				copied
			{:else}
				<IconShare size={13} stroke-width={2} class="shrink-0 text-ink-3" />
				{label}
			{/if}
		</span>
		<!-- URLs/nevents are machine-made (§9 writing rule): mono, middle-clipped;
			the full value hangs on the title for hover reveal. -->
		<span
			class="w-full truncate font-mono text-[11px] {value === '' ? 'text-ink-3' : 'text-ink-2'}"
			title={value}
		>
			{value === '' ? '…' : clipMiddle(value, 42)}
		</span>
	</button>
{/snippet}
