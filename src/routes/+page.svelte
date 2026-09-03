<script lang="ts">
	/* APP SHELL (issue #10, spec §9): three retractable columns —
	 * frameless sessions rail · center canvas swapping search → results →
	 * session (results arrives with the query pipeline, spec §11 step 2)
	 * with the DetailDrawer below the canvas · chat column resident only
	 * while a session is open. */

	import { Tooltip } from 'bits-ui';
	import { handleShellKeydown, shell } from '$lib/shell.svelte';
	import { investigation } from '$lib/investigation.svelte';
	import { settings } from '$lib/settings.svelte';
	import SearchHero from '$lib/components/ui/SearchHero.svelte';
	import SidebarRecents from '$lib/components/ui/SidebarRecents.svelte';
	import DetailDrawer from '$lib/components/shell/DetailDrawer.svelte';
	import ChatColumn from '$lib/components/shell/ChatColumn.svelte';
	import SettingsDialog from '$lib/components/shell/SettingsDialog.svelte';

	let centerHeight = $state(0);
	// The drawer may grow until the canvas keeps a usable strip.
	const drawerMax = $derived(Math.max(240, centerHeight - 120));
</script>

<svelte:window onkeydown={handleShellKeydown} />

<Tooltip.Provider delayDuration={350}>
	<!-- inert while settings is open: keyboard focus stays inside the modal. -->
	<div class="flex h-dvh w-full gap-3 p-3" inert={shell.settingsOpen ? true : undefined}>
		<SidebarRecents
			collapsed={!shell.railOpen}
			sessions={shell.sessions}
			activeId={shell.session?.id ?? null}
			onToggle={() => shell.toggleRail()}
			onNew={() => shell.home()}
			onHome={() => shell.home()}
			onPick={(id) => shell.openSession(id)}
			onClose={(id) => shell.closeSession(id)}
			onSettings={() => shell.toggleSettings()}
		/>

		<div
			bind:clientHeight={centerHeight}
			class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-window bg-surface shadow-card"
		>
			<div class="flex min-h-0 flex-1 items-center justify-center p-6">
				{#if shell.view === 'search'}
					<!-- J1 hero (issue #37) — the trace (#36) and results (#38)
					surfaces take over the center stage after submit. -->
				<div class="h-full w-full overflow-y-auto">
					<SearchHero
						hasKey={settings.apiKey !== ''}
						onSearch={(q) => void investigation.start(q)}
						onSettings={() => shell.toggleSettings()}
					/>
				</div>
				{:else}
					<p class="max-w-64 text-center text-[12.5px] leading-relaxed text-ink-3">
						<span class="font-medium text-ink-2">{shell.session?.title}</span><br />
						The graph canvas lands here with the product-graph step (spec §11 step 3); the
						dossier lives in the drawer below.
					</p>
				{/if}
			</div>

			{#if shell.view === 'session'}
				<DetailDrawer
					open={shell.drawerOpen}
					height={Math.min(shell.drawerHeight, drawerMax)}
					maxHeight={drawerMax}
					onToggle={() => shell.toggleDrawer()}
					onResize={(next) => (shell.drawerHeight = next)}
				/>
			{/if}
		</div>

		{#if shell.view === 'session'}
			<ChatColumn collapsed={!shell.chatOpen} onToggle={() => shell.toggleChat()} />
		{/if}
	</div>

	{#if shell.settingsOpen}
		<SettingsDialog onClose={() => shell.toggleSettings()} />
	{/if}
</Tooltip.Provider>
