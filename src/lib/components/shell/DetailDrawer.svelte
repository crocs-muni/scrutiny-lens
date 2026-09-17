<script lang="ts">
	/* DETAIL DRAWER — bottom drawer below the canvas (spec §9 + issue #10):
	 * sticky counted sections (Summary · Content · History · Files), a
	 * resizable splitter, a 32px collapsed handle. The drawer stays MOUNTED
	 * when collapsed — the section body is clipped, not destroyed — so the
	 * citation ring (spec §9, chat step) persists across open/closed.
	 *
	 * Subjects (issue #29a): all four sections render the Dossier derivation
	 * ($lib/dossier.ts) — deterministic by construction (spec §2 rule 1),
	 * resolve() the only patch source. Design rulings #29 comment
	 * 2026-09-13: frozen content carries a deterministic state banner;
	 * History = canonical chain + retraction row + a non-canonical group;
	 * Files rows speak N1⑦'s arrow language; the active section persists
	 * across dossier swaps (chrome class, same as height); a retracted
	 * subject renders fully — Show deleted never gates an opened dossier. */

	import {
		IconChevronDown,
		IconChevronUp,
		IconClock,
		IconCpu,
		IconShield
	} from '@tabler/icons-svelte';
	import { nip19 } from 'nostr-tools';
	import KeyHint from './KeyHint.svelte';
	import SharePopover from './SharePopover.svelte';
	import PublisherChip from '../ui/PublisherChip.svelte';
	import { COLLAPSE } from '../ui/motion';
	import { formatRel, shell, type DrawerSection } from '$lib/shell.svelte';
	import { VERB_CLIP, type Dossier, type HistoryRow } from '$lib/dossier';
	import { artifactIcon } from '$lib/artifacts';
	import { IconExternalLink } from '@tabler/icons-svelte';
	import { clipMiddle } from '$lib/text';

	interface Section {
		key: DrawerSection;
		label: string;
	}

	/* Title-settle (issue #82): the drawer's two-face title (mono rule-5 ⇄
	 * sans interpreted) flips when the card merge lands while the drawer is
	 * open. One ~200ms settle-fade marks the change; the first observed
	 * value is the subject's first stable paint here → never blooms (cache
	 * calm). */
	let titleBloom = $state(false);
	let titleObserved: boolean | null = null;
	$effect(() => {
		const now = dossier !== null && dossier.title.interpreted;
		if (titleObserved === null) {
			titleObserved = now;
			return;
		}
		if (now && !titleObserved) titleBloom = true;
		titleObserved = now;
	});

	interface Props {
		open: boolean;
		/** Open height in px. */
		height: number;
		/** Drag clamp upper bound, measured by the parent canvas card. */
		maxHeight: number;
		/** The selected subject's dossier — null renders the honest
		 * no-subject line (ruling 7), never placeholder copy. */
		dossier: Dossier | null;
		/** ADR 0001 companion: the subject survives filtering, but the
		 * drawer says so — persistence is never silent. */
		hiddenByFilter?: boolean;
		/** Files rows deep-link (BIBLE 678): selecting a counterparty swaps
		 * the dossier in place — the metadata-dossier path pre-canvas. */
		onSelect?: (id: string) => void;
		onClearFilters?: () => void;
		onToggle: () => void;
		onResize: (next: number) => void;
	}

	let {
		open,
		height,
		maxHeight,
		dossier,
		hiddenByFilter = false,
		onSelect,
		onClearFilters,
		onToggle,
		onResize
	}: Props = $props();

	// spec §9: 32px collapsed handle.
	const COLLAPSED = 32;
	const MIN_OPEN = 168;

	const SECTIONS: Section[] = [
		{ key: 'summary', label: 'Summary' },
		{ key: 'content', label: 'Content' },
		{ key: 'history', label: 'History' },
		{ key: 'files', label: 'Files' }
	];

	// Counts live on the dossier (§2 rule 2: each equals its rows rendered);
	// Content has no meaningful count, so its chip stays hidden.
	const counts = $derived<Partial<Record<DrawerSection, number>>>(
		dossier === null ? {} : { ...dossier.counts, content: undefined }
	);

	// The active section is user-owned chrome (ruling 9): dossier swaps keep
	// it — comparison flows read History-at-A then History-at-B. It lives on
	// the shell because this component unmounts on every view hop.
	const active = $derived(shell.drawerSection);
	let dragging = $state(false);

	function startDrag(event: PointerEvent) {
		event.preventDefault();
		const startY = event.clientY;
		const startHeight = height;
		dragging = true;
		const move = (e: PointerEvent) =>
			onResize(Math.round(Math.min(Math.max(startHeight + (startY - e.clientY), MIN_OPEN), maxHeight)));
		const up = () => {
			dragging = false;
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
	}

	/** BIBLE's hover convention: relative clock, absolute ISO on hover. */
	function absolute(createdAt: number): string {
		const iso = new Date(createdAt * 1000).toISOString();
		return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
	}

	/** History rows name authors as short npubs (mono) — kind-0 profiles
	 * belong to the publisher chip, not per-row fetches. */
	function npubShort(pubkey: string): string {
		if (pubkey === '') return 'unknown';
		const npub = nip19.npubEncode(pubkey);
		return `${npub.slice(0, 14)}…`;
	}

	/** State word per row (mono vocabulary, all computed). */
	function rowState(row: HistoryRow): string {
		switch (row.state) {
			case 'root':
				return 'root';
			case 'applied':
				return 'applied';
			case 'halted-here':
				return 'halted here';
			case 'fork-parent':
				return 'shared parent';
			case 'fork-branch':
				return 'fork branch';
			case 'pending':
				return 'pending';
			case 'overlay':
				return row.overlayState ?? 'overlay';
			case 'retraction':
				return 'retracted';
		}
	}

	/** The only-patchless-chain case: one honest root row (startup mandate) —
	 * true when no canonical patch, non-canonical entry, or retraction exists. */
	const bareRoot = $derived(
		dossier !== null && dossier.history.every((r) => r.state === 'root')
	);
</script>
<section
	aria-label="Detail drawer"
	data-drawer-collapsed={!open}
	class="relative flex shrink-0 flex-col overflow-hidden border-t border-line"
	style:height="{open ? height : COLLAPSED}px"
	style:transition={dragging ? 'none' : `height ${COLLAPSE.duration}ms ${COLLAPSE.easing}`}
	style:--drawer-copy-duration="{COLLAPSE.copyDuration}ms"
>
	{#if open}
		<!-- splitter: drag between canvas and dossier -->
		<div
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize detail drawer"
			onpointerdown={startDrag}
			class="group flex h-2.5 w-full shrink-0 cursor-row-resize touch-none items-center justify-center"
		>
			<span
				class="h-1 w-9 rounded-full bg-line transition-colors duration-150 group-hover:bg-line-strong"
			></span>
		</div>
	{/if}

	<!-- counted section bar sticks to the drawer's top (= the 32px collapsed handle) -->
	<div class="flex h-8 shrink-0 items-center gap-0.5 px-2">
		{#each SECTIONS as section (section.key)}
			<button
				type="button"
				aria-pressed={active === section.key}
				onclick={() => (shell.drawerSection = section.key)}
				class="flex h-6 items-center gap-1 rounded-chip px-2 text-[12.5px] font-medium transition-colors duration-100 {active ===
				section.key
					? 'bg-accent-tint text-accent-ink'
					: 'text-ink-2 hover:bg-hover'}"
			>
				{section.label}
				{#if counts[section.key] !== undefined}
					<span class="font-mono text-[11px] text-ink-3">· {counts[section.key]}</span>
				{/if}
			</button>
		{/each}
		<!-- The collapsed handle names the subject (ruling 2 — selection is
			marked on this surface too); mono when uninterpreted, matching the
			fallback vocabulary everywhere else. -->
		{#if !open && dossier !== null}
			<span
				class="ml-2 min-w-0 truncate {dossier.title.interpreted
					? 'text-[12px] font-medium text-ink'
					: 'font-mono text-[11px] text-ink-2'} {titleBloom ? 'title-settle' : ''}"
				onanimationend={() => (titleBloom = false)}
			>
				{dossier.title.text}
			</span>
		{/if}
		<span class="min-w-0 flex-1"></span>
		<!-- BIBLE L1090: share lives in the drawer header — copies the
			record's share links (issue #31: URL + nostr: URI). -->
		{#if dossier !== null}
			<SharePopover subject={dossier.subject} />
		{/if}
		<KeyHint
			label="Detail drawer"
			keys="Ctrl+;"
			side="top"
			class="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
			onclick={onToggle}
		>
			{#if open}
				<IconChevronDown size={16} stroke-width={2} />
			{:else}
				<IconChevronUp size={16} stroke-width={2} />
			{/if}
		</KeyHint>
	</div>

	<!-- Body stays mounted while collapsed (citation-ring persistence, header
	 * comment); the frame clips it and the copy fades ahead of the height. -->
	<div class="drawer-copy min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
		{#if hiddenByFilter}
			<!-- ADR 0001: the subject outlives the filter, and says so. -->
			<div
				class="mb-2 flex items-center gap-2 rounded-[8px] border border-line bg-inset px-2.5 py-1.5 font-mono text-[11px] text-ink-2"
			>
				hidden by the current filter
				{#if onClearFilters !== undefined}
					<button
						type="button"
						class="text-accent-ink underline underline-offset-2 hover:text-ink"
						onclick={() => onClearFilters()}
					>
						clear filters
					</button>
				{/if}
			</div>
		{/if}

		{#if dossier === null}
			<!-- ruling 7: one honest line, section bar above stays constant. -->
			<p class="max-w-md font-mono text-[11.5px] leading-relaxed text-ink-3">
				select a result to open its dossier
			</p>
		{:else if active === 'summary'}
			<div class="flex items-center gap-2.5">
				<!-- ① kind-mapped neutral icon tile (BIBLE N1/N2) -->
				<span
					class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border border-line bg-inset {dossier.subjectType ===
					'product'
						? 'text-accent-ink'
						: 'text-ink-2'}"
				>
					{#if dossier.subjectType === 'product'}
						<IconCpu size={16} stroke={1.7} aria-hidden="true" />
					{:else}
						<IconShield size={16} stroke={1.7} aria-hidden="true" />
					{/if}
				</span>
				<!-- ② title: sans on a cache hit, mono rule-5 on a miss — the
					exact same two faces the card has (§2 rule 5). -->
				<span
					class="min-w-0 truncate {dossier.title.interpreted
						? 'text-[14px] font-semibold text-ink'
						: 'font-mono text-[12px] font-medium text-ink-2'} {titleBloom ? 'title-settle' : ''}"
					onanimationend={() => (titleBloom = false)}
				>
					{dossier.title.text}
				</span>
				{#if dossier.retracted}
					<!-- protocol kind-5, never presentational (spec §2 rule 2);
						the drawer's pill matches the card's exactly (ruling 3). -->
					<span
						class="shrink-0 rounded-full border border-[oklch(0.93_0.04_20)] bg-red-tint px-2.5 py-0.5 font-mono text-[11px] font-medium text-red"
					>
						retracted
					</span>
				{/if}
				<span class="flex-1"></span>
				<!-- ③ publisher (kind-0 dot+name, npub fallback) · ⑤ time -->
				<PublisherChip pubkey={dossier.publisher} />
				<span
					class="inline-flex shrink-0 items-center gap-1.5 text-ink-2"
					title={absolute(dossier.createdAt)}
				>
					<IconClock size={12} stroke={2} aria-hidden="true" />
					<span class="font-mono text-[11px]">{formatRel(dossier.createdAt * 1000)}</span>
				</span>
			</div>
			<!-- ④ description: products only, one line, cache-only — a miss
				renders no line at all rather than fabricated prose. -->
			{#if dossier.snippet !== undefined}
				<p class="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">{dossier.snippet}</p>
			{/if}
			{#if dossier.identifiers.length > 0}
				<div class="mt-2 flex flex-wrap items-center gap-1.5">
					{#each dossier.identifiers as id (id)}
						<span
							class="rounded-[6px] border border-line bg-inset px-2 py-[3px] font-mono text-[11px] text-ink-2"
						>
							{id}
						</span>
					{/each}
				</div>
			{/if}
		{:else if active === 'content'}
			<!-- Content = resolve()'s chain content verbatim, monospace; frozen
				content carries its deterministic state banner (ruling 4). -->
			{#if dossier.content.banner !== null}
				<p
					class="mb-2 rounded-[6px] border border-line bg-inset px-2.5 py-1.5 font-mono text-[11px] text-ink-2"
				>
					{dossier.content.banner}
				</p>
			{/if}
			{#if dossier.content.text !== null}
				<pre
					class="font-mono text-[11.5px] leading-relaxed break-all whitespace-pre-wrap text-ink">{dossier
						.content.text}</pre>
			{:else if dossier.content.banner === null}
				<p class="font-mono text-[11.5px] text-ink-3">no content</p>
			{/if}
		{:else if active === 'history'}
			<div class="flex flex-col gap-1">
				{#each dossier.history as row, i (row.id + row.state)}
					{#if i > 0 && !row.canonical && dossier.history[i - 1].canonical}
						<!-- ruling 5: overlays and pending render as their own
							group — never silently mixed into the chain. -->
						<div
							class="mt-2 mb-1 border-t border-line pt-1.5 font-mono text-[10.5px] tracking-wide text-ink-3 uppercase"
						>
							not in the canonical chain
						</div>
					{/if}
					<div class="flex items-center gap-2 text-[12px] text-ink-2">
						<span class="w-7 shrink-0 font-mono text-[11px] text-ink-3">
							{row.position !== null ? `#${row.position}` : '·'}
						</span>
						{#if row.state === 'retraction'}
							<span
								class="shrink-0 rounded-full border border-[oklch(0.93_0.04_20)] bg-red-tint px-2 py-px font-mono text-[10.5px] font-medium text-red"
							>
								retracted
							</span>
						{:else}
							<span
								class="shrink-0 rounded-[6px] border border-line bg-inset px-2 py-px font-mono text-[10.5px] text-ink-2 {row.state ===
									'overlay' && row.overlayState !== 'clean'
									? 'border-orange/40 text-orange'
									: ''}"
							>
								{rowState(row)}
							</span>
						{/if}
						{#if bareRoot}
							<span class="font-mono text-[11px] text-ink-3">no patches observed</span>
						{/if}
						<span class="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3">
							{row.id.slice(0, 16)}…
						</span>
						<span class="shrink-0 font-mono text-[11px] text-ink-3" title={row.author}>
							{npubShort(row.author)}
						</span>
						<span
							class="shrink-0 font-mono text-[11px] text-ink-2"
							title={absolute(row.createdAt)}
						>
							{formatRel(row.createdAt * 1000)}
						</span>
					</div>
				{/each}
			</div>
		{:else}
			<!-- Files: the record's ARTIFACTS (#77) — one row per artifact
				(imeta-first + parsed legacy, artifacts.ts); subject-own rows
				first ("this record"), then per (binding × record) with verb
				chip and counterparty/story deep-link preserved (BIBLE-678).
				open↗ is the EXTERNAL affordance (noopener,noreferrer); the
				record chip swaps the dossier in place. -->
			{#if dossier.files.length === 0}
				<p class="font-mono text-[11.5px] text-ink-3">no artifacts in this record or its bound references</p>
			{:else}
				<div class="flex flex-col gap-1">
					{#each dossier.files as row (row.id)}
						{@const RowIcon = artifactIcon(row.artifact)}
						<div
							class="flex items-start gap-2 rounded-[8px] px-1.5 py-1 transition-colors duration-100 hover:bg-hover"
						>
							<RowIcon size={15} stroke={1.7} class="mt-[3px] shrink-0 text-ink-2" />
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<!-- mono: machine-derived label/basename (§9 writing rule) -->
									<span class="truncate font-mono text-[12px] font-medium text-ink">
										{row.artifact.label ?? clipMiddle(row.artifact.url, 44)}
									</span>
									{#if row.artifact.sizeText !== undefined}
										<span class="shrink-0 font-mono text-[10.5px] text-ink-3">{row.artifact.sizeText}</span>
									{/if}
									{#if row.artifact.sha256 !== undefined}
										<span
											class="shrink-0 rounded-[5px] border border-line bg-inset px-1.5 py-px font-mono text-[10px] text-ink-3"
											title="SHA-256: {row.artifact.sha256}"
										>
											{clipMiddle(row.artifact.sha256, 17)}
										</span>
									{/if}
									<a
										href={row.artifact.url}
										target="_blank"
										rel="noopener noreferrer"
										class="ml-auto shrink-0 rounded-[6px] p-1 text-ink-3 transition-colors hover:text-accent-ink"
										title="Open artifact: {row.artifact.url}"
										onclick={(e) => e.stopPropagation()}
									>
										<IconExternalLink size={13} stroke={2} />
									</a>
								</div>
								<button
									type="button"
									class="mt-0.5 flex min-w-0 items-center gap-1.5 text-left"
									title="{row.destination === 'subject' ? 'root' : 'link'} endpoint · {row.recordId}"
									onclick={() => onSelect?.(row.recordId)}
								>
									<span class="shrink-0 font-mono text-[10.5px] text-ink-3">
										{row.destination === 'subject' && row.verb !== null ? '←' : row.verb !== null ? '→' : '·'}
									</span>
									{#if row.verb !== null && row.verb !== ''}
										<!-- corpus bindings carry machine sentences, not
											four-letter verbs — the chip clips (full text on
											hover + in Content); the count is untouched. -->
										<span
											class="shrink-0 rounded-[6px] border border-line bg-inset px-1.5 py-px font-mono text-[10px] text-ink-2"
											title={clipMiddle(row.verb, VERB_CLIP) !== row.verb ? row.verb : undefined}
										>
											{clipMiddle(row.verb, VERB_CLIP)}
										</span>
									{/if}
									{#if row.recordTitle !== null}
										<span
											class="truncate {row.recordTitle.interpreted
												? 'text-[12px] font-medium text-ink'
												: 'font-mono text-[11px] text-ink-2'}"
										>
											{row.recordTitle.text}
										</span>
									{:else}
										<span class="shrink-0 font-mono text-[10.5px] text-ink-3">this record</span>
									{/if}
								</button>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</section>

<style>
	.drawer-copy {
		opacity: 1;
		transition: opacity var(--drawer-copy-duration) ease-out;
	}
	/* Height collapse: copy exits first, frame follows — same harness
	 * choreography as the column collapses (issue #10). */
	[data-drawer-collapsed='true'] .drawer-copy {
		opacity: 0;
	}
	/* tile-settle shared language — the title crossfade (issue #82). */
	.title-settle {
		animation: settle-fade-in 200ms var(--ease-link) both;
	}
</style>
