<script lang="ts">
	/* NOTICE BANNER — dismissible amber strip for deterministic pipeline/AI
	 * notices in the results surface (issue #38, spec §4). Amber = warning
	 * only, mirroring NoKeyBanner's amber convention; the message is
	 * machine/AI text so it renders verbatim in mono (spec §9) and wraps
	 * rather than truncating — a href status must never be cut off. */

	import { IconAlertTriangle, IconX } from '@tabler/icons-svelte';

	interface Props {
		message: string;
		onDismiss(): void;
	}

	let { message, onDismiss }: Props = $props();
</script>

<div class="flex items-start gap-2 rounded-[8px] border border-[oklch(0.93_0.05_60)] bg-orange-tint px-3 py-2">
	<IconAlertTriangle size={14} stroke={2} class="mt-px shrink-0 text-orange" />
	<p class="flex-1 font-mono text-[12px] leading-relaxed text-orange">{message}</p>
	<button
		type="button"
		class="shrink-0 rounded-[4px] text-orange hover:opacity-70"
		aria-label="Dismiss notice"
		onclick={onDismiss}
	>
		<IconX size={14} stroke={2} />
	</button>
</div>
