<script lang="ts">
	/* BREADCRUMB BAR (issue #142) — the one 44px step bar shared by the
	 * results and session surfaces. Anatomy stays the results bar's (BIBLE
	 * J2): full-window width, one hairline, 12.5/13px baseline cluster.
	 *
	 * No motion: this bar is the highest-frequency navigation target in the
	 * app, so its hover affordance is a static underline/ink change rather
	 * than a transition (owner ruling, #142).
	 *
	 * `Results` is a section heading outside the breadcrumb list; the question
	 * crumb is the real Results destination and the card crumb is the current
	 * graph anchor. Every label is existing app text — the session question,
	 * the graph node's title — never generated here. */
	import BreadcrumbTrigger from './BreadcrumbTrigger.svelte';
	import type { AscendTarget, NavAction, NavCrumb, NavTrail } from '$lib/nav';

	interface Props {
		trail: NavTrail;
		/** Right-aligned mono ledger (results: fetched/truncation). */
		meta?: string;
		/** Crumb click: the question crumb opens Results. */
		onCrumb: (action: NavAction) => void;
		/** Back chevron: exactly one step up. */
		onAscend: (target: AscendTarget) => void;
	}

	let { trail, meta = '', onCrumb, onAscend }: Props = $props();

	let navEl = $state<HTMLElement | null>(null);

	/** After an ascend the pressed control may not exist at the new level
	 * (the card crumb disappears), so focus moves to the control that
	 * continues the ascent — the back chevron — and otherwise to the bar
	 * itself. Landing on the current crumb at the root would open that
	 * crumb's focus tooltip, and the tooltip would eat the next Escape. */
	export function focusAfterAscend(): void {
		const target =
			navEl?.querySelector<HTMLElement>('[data-focus-back]') ?? navEl;
		target?.focus();
	}

	function ascend(): void {
		if (trail.up !== null) onAscend(trail.up);
	}

	function crumbClass(crumb: NavCrumb): string {
		const base = crumb.current
			? crumb.mono
				? 'font-mono text-[11.5px] font-medium text-ink'
				: 'text-[13px] font-semibold text-ink'
			: crumb.mono
				? 'font-mono text-[11.5px] text-ink-2'
				: 'text-[12.5px] text-ink-2';
		// A persistent affordance separates real destinations from the
		// section heading and the current card before hover (issue #142
		// review: hover-only underline hid which crumb was clickable).
		return crumb.action !== null
			? `${base} underline decoration-dotted decoration-ink-3 underline-offset-2 hover:text-ink hover:decoration-solid`
			: base;
	}

	function openCrumb(crumb: NavCrumb): void {
		if (crumb.action === null) return;
		onCrumb(crumb.action);
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
			16px text inset. data-focus-back is the stable focus target after
			an ascend; it stays correct if another crumb gains an aria-label. -->
		<button
			type="button"
			data-focus-back
			aria-label={trail.upLabel}
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
		<!-- Section heading, not a crumb: there is no separate Results page
			to open beyond the question surface. -->
		<span class="shrink-0 text-[12.5px] leading-none text-ink-2">{trail.rootLabel}</span>
		<span aria-hidden="true" class="flex shrink-0 items-center">
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
		</span>
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
					<BreadcrumbTrigger
						{crumb}
						class={crumbClass(crumb)}
						onActivate={() => openCrumb(crumb)}
					/>
				</li>
			{/each}
		</ol>
		{#if meta !== ''}
			<span class="shrink-0 font-mono leading-none text-[11px] text-ink-2">{meta}</span>
		{/if}
	</div>
	<!-- Trail changes are announced; focus alone does not say which level is
		now current or where the next back press goes. -->
	<span class="sr-only" aria-live="polite">{trail.live}</span>
</nav>
