<script lang="ts">
	/* RESULT CARD — the rule-5 fallback variant (issue #36, spec §2 rule 5).
	 *
	 * Skeleton ≡ no-key fallback ≡ AI-down fallback: the event speaks for
	 * itself — its i-tags, type tag, first ~200 chars, "not interpreted"
	 * marked, never invented text. This file is the permanent home of the
	 * P3 result card: #38 grows the interpreted and retracted variants
	 * (title/snippet/counts/publisher) into it; the dashed fallback stays.
	 *
	 * All values here are machine-made, so the whole card is mono
	 * (spec §9 writing rule). The dashed border marks un-interpreted state
	 * (BIBLE legend). */

	import type { SkeletonCard } from '$lib/pipeline';

	interface Props {
		card: SkeletonCard;
	}

	let { card }: Props = $props();

	const title = $derived(card.typeTag ?? card.itags[0] ?? 'untyped event');
	const rawLine = $derived(
		[
			card.typeTag ? `t: ${card.typeTag}` : null,
			...card.itags.slice(0, 3).map((t) => `i: ${t}`),
			`"${card.contentStart}"`
		]
			.filter((s) => s !== null)
			.join(' · ')
	);
</script>

<article
	class="rounded-[12px] border-[1.5px] border-dashed border-line-strong bg-surface px-4 py-3 shadow-card [content-visibility:auto] [contain-intrinsic-size:auto_120px]"
>
	<div class="flex items-center gap-2">
		<h3 class="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-ink">{title}</h3>
		<span
			class="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[10.5px] text-ink-3"
		>
			not interpreted
		</span>
	</div>
	<p class="mt-1.5 line-clamp-3 font-mono text-[11px] leading-relaxed break-all text-ink-2">
		{rawLine}
	</p>
</article>
