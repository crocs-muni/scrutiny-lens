<script lang="ts">
	import { goto } from '$app/navigation';
	import { sessionStore } from '$lib/stores/session.svelte.js';
	import { Search, Plus, LayoutList, User } from '@lucide/svelte';

	let query = $state('');
	let searching = $state(false);

	const examples = [
		'ROCA in Infineon smartcards',
		'CVE-2017-15361',
		'BSI-DSZ-CC-0814-2012'
	];

	function submit() {
		if (!query.trim()) return;
		searching = true;
		goto(`/search?q=${encodeURIComponent(query.trim())}`);
	}
</script>

<div class="flex h-screen w-full">
	<!-- Left rail -->
	<aside class="flex w-[260px] flex-col border-r border-border bg-surface p-3">
		<div class="flex h-11 items-center gap-2 px-2">
			<div class="h-6 w-6 rounded bg-primary"></div>
			<span class="text-sm font-semibold">Scrutiny Lens</span>
		</div>
		<button class="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90">
			<Plus class="h-4 w-4" /> New search
		</button>
		<div class="mt-4 flex items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			<span>Previous sessions</span>
		</div>
		<div class="mt-2 flex-1 space-y-1 overflow-y-auto">
			{#each sessionStore.sessions as session}
				<a
					href="/session/{session.id}"
					class="block rounded-md px-2.5 py-2 hover:bg-secondary"
				>
					<div class="text-[13px] font-medium text-card-foreground truncate">{session.title}</div>
					<div class="text-[11.5px] text-muted-foreground truncate">{session.query}</div>
				</a>
			{/each}
		</div>
		<div class="mt-auto flex items-center gap-2 border-t border-border px-2 pt-3">
			<div class="flex h-7 w-7 items-center justify-center rounded-full bg-secondary">
				<User class="h-4 w-4 text-muted-foreground" />
			</div>
			<span class="text-xs font-medium">Analyst workspace</span>
		</div>
	</aside>

	<!-- Main -->
	<main class="flex flex-1 flex-col items-center justify-center bg-background px-6">
		<div class="w-full max-w-[640px] text-center">
			<h1 class="text-[40px] font-semibold tracking-tight text-foreground">What are you investigating?</h1>
			<p class="mx-auto mt-3 max-w-[560px] text-[16.5px] text-muted-foreground">
				Search certificates, CVEs, and product lineages across SCRUTINY relays.
			</p>

			<form
				onsubmit={(e) => {
					e.preventDefault();
					submit();
				}}
				class="mt-8"
			>
				<div class="relative flex h-[60px] items-center rounded-[14px] border border-primary/30 bg-card shadow-lg shadow-primary/5">
					<Search class="ml-4 h-5 w-5 text-primary" />
					<input
						bind:value={query}
						placeholder="Search certificates — e.g. 'ROCA vulnerability in Infineon chips' or BSI-DSZ-CC-0814-2012"
						class="h-full flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground"
					/>
					<button
						type="submit"
						disabled={searching}
						class="mr-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
					>
						{searching ? 'Searching...' : 'Search'}
					</button>
				</div>
			</form>

			<div class="mt-5 flex flex-wrap items-center justify-center gap-2">
				{#each examples as ex}
					<button
						onclick={() => {
							query = ex;
							submit();
						}}
						class="rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground hover:border-primary hover:text-primary"
					>
						{ex}
					</button>
				{/each}
			</div>
		</div>
	</main>
</div>
