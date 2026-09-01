<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { initPersistence, listSessions } from '$lib/db';
	import { hydrateDeadLetters } from '$lib/ai/deadLetter';
	import { shell } from '$lib/shell.svelte';

	let { children } = $props();

	// Boot hydration (issue #12, spec §6): persistence is best-effort and fails
	// silently to memory-only, so nothing in here can throw.
	onMount(async () => {
		await initPersistence();
		// Keep a session created before hydration finishes instead of
		// clobbering it — its fire-and-forget put may land after listSessions.
		const persisted = await listSessions();
		const known = new Set(persisted.map((s) => s.id));
		shell.sessions = [...persisted, ...shell.sessions.filter((s) => !known.has(s.id))];
		await hydrateDeadLetters();
	});
</script>

{@render children()}
