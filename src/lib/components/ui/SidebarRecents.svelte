<script lang="ts">
	/* SIDEBAR RECENTS — vendored mutation of canon SidebarNav
	 * (beautiful-ui-svelte/src/components/SidebarNav/SidebarNav.svelte).
	 *
	 * Vendored per the spec §9 two-tier rule: this rail carries app anatomy
	 * (issue #10) that canon does not model — a static brand header (no
	 * workspace menu; "the menu carries no other settings entry", spec §9),
	 * Investigations rows with timestamp + unseen dot + hover-close, the
	 * Settings dock at the bottom, and a frameless 40px stub. Improvements
	 * flow back upstream via the data-driven pass — tracked at
	 * aykoooo/beautiful-ui-svelte#2 (umbrella: #1); when it lands, this
	 * vendored copy deletes and the rail returns to source-path import —
	 * a vendored copy is never a dead fork (spec §9).
	 *
	 * Motion contract inherits canon's harness rules verbatim: width-only
	 * 280ms collapse, copy fades/exits in 180ms, content stays at open
	 * width clipped (no reflow jumps). Icons are @tabler/icons-svelte
	 * substitutes for the paid @central-icons-react set, as in canon. */

	import GlideHighlight from 'beautiful-ui-svelte/src/lib/GlideHighlight.svelte';
	import {
		IconAdjustmentsHorizontal,
		IconArrowBarToLeft,
		IconArrowBarToRight,
		IconChevronDown,
		IconPencil,
		IconSearch,
		IconX
	} from '@tabler/icons-svelte';
	import { formatRel, type SessionRow } from '$lib/shell.svelte';
	import KeyHint from '../shell/KeyHint.svelte';
	import { COLLAPSE } from './motion';

	interface Props {
		collapsed: boolean;
		sessions: SessionRow[];
		activeId: string | null;
		onToggle: () => void;
		onNew: () => void;
		onPick: (id: string) => void;
		onClose: (id: string) => void;
		onSettings: () => void;
	}

	let {
		collapsed,
		sessions,
		activeId,
		onToggle,
		onNew,
		onPick,
		onClose,
		onSettings
	}: Props = $props();

	const MOTION = {
		expandedWidth: 224,
		// issue #10: "Sessions stub 40px flat" (canon ships 52).
		collapsedWidth: 40,
		...COLLAPSE
	};

	// Search field: 180ms width bloom, same curve as the shell contract.
	const SEARCH_MOTION = {
		duration: COLLAPSE.copyDuration,
		closedWidth: 28,
		easing: COLLAPSE.easing
	};

	let listOpen = $state(true);
	let searchOpen = $state(false);
	let query = $state('');
	let searchEl: HTMLInputElement | null = $state(null);

	const visibleSessions = $derived(
		sessions.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase()))
	);

	$effect(() => {
		if (searchOpen) searchEl?.focus();
	});

	function closeSearch() {
		searchOpen = false;
		query = '';
	}
</script>

<aside
	data-sidebar-collapsed={collapsed}
	aria-label="Sessions"
	class="relative flex h-full shrink-0 overflow-hidden transition-[width]"
	style:width={collapsed ? `${MOTION.collapsedWidth}px` : `${MOTION.expandedWidth}px`}
	style:transition-duration="{MOTION.duration}ms"
	style:transition-timing-function={MOTION.easing}
	style:--sidebar-copy-duration="{MOTION.copyDuration}ms"
	style:--sidebar-copy-offset="{MOTION.copyOffset}px"
	style:--sidebar-easing={MOTION.easing}
>
	<!-- open-width column: stays 224px while the frame clips it (no reflow) -->
	<div class="rail-copy flex h-full min-h-0 w-[224px] shrink-0 flex-col py-1.5" inert={collapsed}>
		<div class="mb-2 flex h-10 shrink-0 items-center px-2">
			<span
				class="flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-accent text-[13px] font-semibold text-white"
				aria-hidden="true">S</span
			>
			<span class="ml-2 min-w-0 flex-1 truncate text-[14px] font-semibold text-ink"
				>Scrutiny Lens</span
			>
			<KeyHint
				label="Sessions rail"
				keys="Ctrl+\"
				class="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover-2 hover:text-ink"
				onclick={onToggle}><IconArrowBarToLeft size={18} stroke-width={1.8} /></KeyHint
			>
		</div>

		<GlideHighlight
			rowSelector="[data-row]"
			highlightClass="sidebar-glide-highlight rounded-[7px] bg-hover-2"
			class="group/glide flex flex-col gap-px"
		>
			<button
				data-row
				type="button"
				onclick={onNew}
				class="sidebar-action-row relative z-10 mx-2 flex h-8 items-center rounded-control px-2 text-left transition-transform duration-150 active:scale-[0.98]"
			>
				<span class="flex size-5 shrink-0 items-center justify-center text-ink-2">
					<IconPencil size={18} stroke-width={1.8} />
				</span>
				<span class="ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2"
					>New investigation</span
				>
			</button>
		</GlideHighlight>

		<div class="mt-3 min-h-0 flex-1 overflow-y-auto">
			<div class="relative mx-2 mb-1 h-8">
				<button
					type="button"
					aria-label={listOpen ? 'Collapse sessions' : 'Expand sessions'}
					aria-expanded={listOpen}
					tabindex={searchOpen ? -1 : 0}
					onclick={() => (listOpen = !listOpen)}
					class="absolute inset-0 flex items-center gap-1.5 rounded-control px-2 text-left text-[12.5px] font-medium text-ink-3 transition-[opacity,transform,color] hover:text-ink-2 {searchOpen
						? 'pointer-events-none -translate-x-1 opacity-0'
						: 'translate-x-0 opacity-100'}"
					style:transition-duration="{SEARCH_MOTION.duration}ms"
					style:transition-timing-function={SEARCH_MOTION.easing}
				>
					<span class="flex shrink-0 transition-transform duration-150 {listOpen ? '' : '-rotate-90'}">
						<IconChevronDown size={16} stroke-width={2} />
					</span>
					<span>Investigations</span>
				</button>

				<button
					type="button"
					aria-label="Search sessions"
					aria-expanded={searchOpen}
					onclick={() => (searchOpen = true)}
					class="absolute top-0 right-0 z-10 flex size-8 items-center justify-center rounded-control text-ink-3 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96] {searchOpen
						? 'pointer-events-none opacity-0'
						: 'opacity-100'}"
					style:transition-duration="{SEARCH_MOTION.duration}ms"
				>
					<IconSearch size={16} stroke-width={1.8} />
				</button>

				<div
					class="absolute top-0 right-0 z-20 flex h-8 items-center overflow-hidden rounded-control bg-field text-ink-3 shadow-hairline transition-[width,opacity] focus-within:text-ink-2 {searchOpen
						? 'pointer-events-auto opacity-100'
						: 'pointer-events-none opacity-0'}"
					style:width={searchOpen ? '100%' : `${SEARCH_MOTION.closedWidth}px`}
					style:transition-duration="{SEARCH_MOTION.duration}ms"
					style:transition-timing-function={SEARCH_MOTION.easing}
				>
					<span class="ml-2 flex shrink-0 items-center justify-center">
						<IconSearch size={15} stroke-width={1.8} />
					</span>
					<input
						bind:this={searchEl}
						bind:value={query}
						onkeydown={(event) => {
							if (event.key === 'Escape') closeSearch();
						}}
						placeholder="Search investigations"
						aria-label="Search investigations"
						class="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
					/>
					<button
						type="button"
						aria-label="Close session search"
						onclick={closeSearch}
						class="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
					>
						<IconX size={16} stroke-width={1.8} />
					</button>
				</div>
			</div>

			{#if listOpen}
				<GlideHighlight
					rowSelector="[data-row]"
					highlightClass="sidebar-glide-highlight rounded-[7px] bg-hover-2"
					class="group/glide flex flex-col gap-px"
				>
					{#each visibleSessions as item (item.id)}
						<div
							data-row
							role="presentation"
							class="group/session relative z-10 mx-2 rounded-control"
						>
							<button
								type="button"
								title={item.title}
								onclick={() => onPick(item.id)}
								class="sidebar-action-row flex w-full flex-col gap-0.5 rounded-control px-2 py-1.5 text-left transition-transform duration-150 active:scale-[0.98] {item.id ===
								activeId
									? 'group-hover/glide:bg-transparent'
									: ''}"
							>
								<span
									class="min-w-0 truncate pr-5 text-[14px] font-medium {item.id === activeId
										? 'text-ink'
										: 'text-ink-2'}">{item.title}</span
								>
								<span class="flex items-center gap-1.5">
									{#if item.unseen}
										<span class="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unseen updates"></span>
									{/if}
									<span class="font-mono text-[11px] text-ink-3">{formatRel(item.createdAt)}</span>
								</span>
							</button>
							<button
								type="button"
								aria-label="Close investigation"
								onclick={(event) => {
									event.stopPropagation();
									onClose(item.id);
								}}
								class="absolute top-1.5 right-1 hidden size-5 items-center justify-center rounded-[5px] text-ink-3 group-hover/session:flex group-focus-within/session:flex hover:bg-hover hover:text-ink"
							>
								<IconX size={13} stroke-width={2} />
							</button>
						</div>
					{/each}
					{#if query && visibleSessions.length === 0}
						<div class="mx-2 px-2 py-2 text-[12.5px] text-ink-3">No investigations found</div>
					{/if}
				</GlideHighlight>
			{/if}
		</div>

		<!-- Settings dock — the rail's bottom slot (spec §9 rail chrome) -->
		<div class="mx-2 mt-2 shrink-0 border-t border-line pt-2">
			<KeyHint
				label="Settings"
				keys="Ctrl+,"
				class="flex h-8 w-full items-center rounded-control px-2 text-left transition-colors duration-150 hover:bg-hover-2"
				onclick={onSettings}
			>
				<span class="flex size-5 shrink-0 items-center justify-center text-ink-2">
					<IconAdjustmentsHorizontal size={18} stroke-width={1.8} />
				</span>
				<span class="ml-1.5 min-w-0 flex-1 truncate text-[14px] font-medium text-ink-2">Settings</span>
				<kbd class="shrink-0 font-mono text-[10px] text-ink-3">Ctrl+,</kbd>
			</KeyHint>
		</div>
	</div>

	<!-- collapsed stub: 40px flat icon stack, fades in behind the copy exit -->
	<div
		class="rail-stub absolute inset-0 flex flex-col items-center gap-px py-1.5"
		inert={!collapsed}
	>
		<KeyHint
			label="Sessions rail"
			keys="Ctrl+\"
			class="primitive-icon-button mb-1 shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover-2 hover:text-ink"
			onclick={onToggle}><IconArrowBarToRight size={18} stroke-width={1.8} /></KeyHint
		>
		<span
			class="mb-1 flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-accent text-[12px] font-semibold text-white"
			aria-hidden="true">S</span
		>
		<button
			type="button"
			aria-label="New investigation"
			onclick={onNew}
			class="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover-2 hover:text-ink"
		>
			<IconPencil size={17} stroke-width={1.8} />
		</button>
		<span class="flex-1"></span>
		<KeyHint
			label="Settings"
			keys="Ctrl+,"
			class="primitive-icon-button shrink-0 text-ink-3 transition-colors duration-150 hover:bg-hover-2 hover:text-ink"
			onclick={onSettings}
		>
			<IconAdjustmentsHorizontal size={17} stroke-width={1.8} />
		</KeyHint>
	</div>
</aside>

<style>
	/* Copy choreography — canon's contract, scoped to this vendored copy:
	 * copy exits in 180ms ahead of the 280ms width animation; the stub
	 * fades in behind it. */
	.rail-copy {
		opacity: 1;
		transform: translateX(0);
		transition:
			opacity var(--sidebar-copy-duration) ease-out,
			transform var(--sidebar-copy-duration) var(--sidebar-easing);
	}

	.rail-stub {
		pointer-events: none;
		opacity: 0;
		transition: opacity var(--sidebar-copy-duration) ease-out;
	}

	[data-sidebar-collapsed='true'] .rail-copy {
		pointer-events: none;
		opacity: 0;
		transform: translateX(calc(var(--sidebar-copy-offset) * -1));
	}

	[data-sidebar-collapsed='true'] .rail-stub {
		pointer-events: auto;
		opacity: 1;
		transition-delay: calc(var(--sidebar-copy-duration) / 2);
	}

	:global(.sidebar-glide-highlight) {
		right: 8px;
		left: 8px;
	}
</style>
