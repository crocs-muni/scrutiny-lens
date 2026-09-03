<script lang="ts">
	/* NO-KEY BANNER — J1 hero hint (design board BIBLE §1, spec §4 "No AI
	 * key set" row, issue #37). Everything still works; AI texts fall back
	 * (§2 rule 5). The bold route opens Settings (the rail dock carries the
	 * only settings entry, spec §9). Amber = warning only — the banner
	 * disappears once a key exists. */

	import { IconAlertCircle } from '@tabler/icons-svelte';

	interface Props {
		onSettings: () => void;
	}

	let { onSettings }: Props = $props();
</script>

<div
	class="flex max-w-[480px] items-center gap-2 rounded-[8px] border border-[oklch(0.93_0.05_60)] bg-orange-tint px-3 py-2 text-[12.5px] text-[oklch(0.47_0.10_61)]"
>
	<IconAlertCircle size={14} stroke={2} class="shrink-0" />
	<span>
		No API key yet — everything works, AI texts fall back.
		<button type="button" class="font-semibold hover:underline" onclick={onSettings}>
			Set one in Settings →
		</button>
	</span>
</div>
