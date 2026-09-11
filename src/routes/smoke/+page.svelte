<!--
  Dev-only AI smoke page (issue #54). The entire body sits behind
  import.meta.env.DEV (Vite replaces it with `false` in prod builds, so
  Rollup dead-code-eliminates the branch AND the dynamic import chunk is
  never emitted — verified against `pnpm build` output).
-->
<script lang="ts">
	import { onMount } from 'svelte';

	let lines: string[] = $state(['']);
	let done = $state(false);

	onMount(async () => {
		if (!import.meta.env.DEV) {
			lines = ['smoke page is dev-only'];
			return;
		}
		// Dynamic import keeps the pipeline + fake-gateway plumbing out of
		// every other route's module graph (and out of prod bundles entirely).
		const { runSmoke } = await import('./smoke.runner');
		const out = await runSmoke();
		lines = out.lines;
		done = true;
	});
</script>

<svelte:head><title>{import.meta.env.DEV ? 'AI smoke (dev)' : ''}</title></svelte:head>

{#if import.meta.env.DEV}
	<pre class="p-4 font-mono text-xs whitespace-pre-wrap">{lines.join('\n')}</pre>
	{#if done}<p class="px-4">Smoke complete. Corpus: <code>.smoke/corpus/</code></p>{/if}
{/if}
