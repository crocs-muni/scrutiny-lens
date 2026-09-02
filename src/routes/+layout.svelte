<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { initPersistence, listSessions } from '$lib/db';
	import { hydrateDeadLetters } from '$lib/ai/deadLetter';
	import { mergeSessionLists, shell } from '$lib/shell.svelte';
	import { settings } from '$lib/settings.svelte';
	import { applyTheme } from '$lib/theme';

	let { children } = $props();
	// Theme (issue #11, spec §5): tracks settings.appearance and, for the
	// system choice, prefersDark inside applyTheme — the swap lands as one
	// repaint per the .theme-switching freeze rule in app.css.
	$effect(() => {
		applyTheme(settings.appearance);
	});

	// Boot hydration (issue #12, spec §6): persistence is best-effort and fails
	// silently to memory-only, so nothing in here can throw.
	onMount(async () => {
		await initPersistence();
		// Settings first: the theme/relay/endpoint defaults must be the
		// persisted ones before any dialog opens (a pre-hydration edit would
		// otherwise be clobbered).
		await settings.hydrate();
		// Keep a session created before hydration finishes instead of
		// clobbering it — its fire-and-forget put may land after listSessions.
		shell.sessions = mergeSessionLists(await listSessions(), shell.sessions);
		await hydrateDeadLetters();
	});
</script>

{@render children()}
