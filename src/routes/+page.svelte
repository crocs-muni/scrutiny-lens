<script lang="ts">
	import { onMount } from 'svelte';

	let health = $state<unknown>(null);
	let status = $state<number | null>(null);
	let error = $state<string | null>(null);

	onMount(async () => {
		try {
			const res = await fetch('/api/ai/health');
			status = res.status;
			health = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<main>
	<h1>SCRUTINY Lens</h1>
	<section>
		<h2>Health</h2>
		<pre>{JSON.stringify({ status, health, error }, null, 2)}</pre>
	</section>
</main>
