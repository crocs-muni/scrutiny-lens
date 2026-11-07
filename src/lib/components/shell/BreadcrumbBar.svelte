<script lang="ts">
	/* BREADCRUMB BAR (issue #142) — the one 44px step bar shared by the
	 * results and session surfaces. Anatomy stays the results bar's (BIBLE
	 * J2): full-window width, one hairline, 12.5/13px baseline cluster.
	 *
	 * No motion: this bar is the highest-frequency navigation target in the
	 * app, so its hover affordance is a static underline/ink change rather
	 * than a transition (owner ruling, #142).
	 *
	 * The chevron is the machine-readable "one level up"; crumbs carry the
	 * trail. Every label is existing app text — the session question or the
	 * subject's dossier title — never generated here. */
	import KeyHint from './KeyHint.svelte';
	import type { AscendTarget, NavCrumb, NavTrail } from '$lib/nav';

	interface Props {
		trail: NavTrail;
		/** Right-aligned mono ledger (results: fetched/truncation). */
		meta?: string;
		/** Crumb click: results → results surface, session → clear subject. */
		onCrumb: (level: 'results' | 'session') => void;
		/** Back chevron: exactly one level up. */
		onAscend: (target: AscendTarget) => void;
	}

	let { trail, meta = '', onCrumb, onAscend }: Props = $props();

	let navEl = $state<HTMLElement | null>(null);

	/** After an ascend the pressed control may not exist at the new level
	 * (the subject crumb disappears), so focus moves to the control that
	 * continues the ascent — the back chevron — and otherwise to the bar
	 * itself. Landing on the current crumb at the root would open that
	 * crumb's focus tooltip, and the tooltip would eat the next Escape. */
	export function focusAfterAscend(): void {
		const target = navEl?.querySelector<HTMLElement>('button[aria-label]') ?? navEl;
		target?.focus();
	}

	const ascendLabel = $derived(
		trail.up === 'results' ? 'Back to results' : trail.up === 'clear-subject' ? 'Back to session' : ''
	);

	function ascend(): void {
		if (trail.up !== null) onAscend(trail.up);
	}

	function crumbClass(crumb: NavCrumb): string {
		const base = crumb.current
			? 'text-[13px] font-semibold text-ink'
			: 'text-[12.5px] text-ink-2';
		return crumb.interactive
			? `${base} hover:text-ink hover:underline underline-offset-2`
			: base;
	}

	/** Only ancestors are buttons; the subject crumb can never be one. */
	function openCrumb(crumb: NavCrumb): void {
		if (crumb.level === 'subject') return;
		onCrumb(crumb.level);
	}
</script>

<nav
	bind:this={navEl}
	tabindex="-1"
	aria-label="Breadcrumb"
	class="flex h-11 shrink-0 items-center border-b border-line px-4"
>
	{#if trail.up !== null}
		<!-- 28px hit target, pulled left so the glyph lines up with the bar's
			16px text inset. -->
		<button
			type="button"
			aria-label={ascendLabel}
			class="primitive-icon-button -ml-2 mr-0.5 shrink-0 text-ink-2 hover:bg-hover hover:text-ink"
			onclick={ascend}
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				class="shrink-0"
				aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg
			>
		</button>
	{/if}

	<!-- baseline-aligned cluster (owner report, PR #42 polish): one true
		baseline per item + svg on the same line, group centered by the bar. -->
	<div class="flex min-w-0 flex-1 items-baseline gap-2">
		<ol class="flex min-w-0 flex-1 items-baseline gap-2">
			{#each trail.crumbs as crumb, i (crumb.level)}
				{#if i > 0}
					<li aria-hidden="true" class="flex shrink-0 items-center">
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							class="shrink-0 text-ink-2"><path d="M9 6l6 6-6 6" /></svg
						>
					</li>
				{/if}
				<li class="flex min-w-0 items-baseline" class:flex-1={crumb.current}>
					{#if crumb.interactive}
						<!-- Clipped text is complete in the DOM, so the tip is a
							hover/focus supplement only (silent). -->
						<KeyHint label={crumb.label} nameless silent side="bottom">
							{#snippet trigger({ props })}
								<button
									{...props}
									type="button"
									class="min-w-0 truncate py-3 text-left leading-none {crumbClass(crumb)}"
									onclick={() => openCrumb(crumb)}
								>
									{crumb.label}
								</button>
							{/snippet}
						</KeyHint>
					{:else}
						<KeyHint label={crumb.label} nameless silent hoverOnly side="bottom">
							{#snippet trigger({ props })}
								<!-- tabindex=-1: not a tab stop, still a focus target
									for focusCurrent() after an ascend. -->
								<span
									{...props}
									tabindex="-1"
									aria-current={crumb.current ? 'page' : undefined}
									class="min-w-0 truncate leading-none {crumbClass(crumb)}"
								>
									{crumb.label}
								</span>
							{/snippet}
						</KeyHint>
					{/if}
				</li>
			{/each}
		</ol>
		{#if meta !== ''}
			<span class="shrink-0 font-mono leading-none text-[11px] text-ink-2">{meta}</span>
		{/if}
	</div>
</nav>
