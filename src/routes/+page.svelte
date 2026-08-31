<script lang="ts">
	/* APP SHELL (issue #10, spec §9): three retractable columns —
	 * frameless sessions rail · center canvas swapping search → results →
	 * session (results arrives with the query pipeline, spec §11 step 2)
	 * with the DetailDrawer below the canvas · chat column resident only
	 * while a session is open. */

	import { Tooltip } from 'bits-ui';
	import { IconX } from '@tabler/icons-svelte';
	import { handleShellKeydown, shell } from '$lib/shell.svelte';
	import SidebarRecents from '$lib/components/ui/SidebarRecents.svelte';
	import DetailDrawer from '$lib/components/shell/DetailDrawer.svelte';
	import ChatColumn from '$lib/components/shell/ChatColumn.svelte';

	let centerHeight = $state(0);
	// The drawer may grow until the canvas keeps a usable strip.
	const drawerMax = $derived(Math.max(240, centerHeight - 120));
</script>

<svelte:window onkeydown={handleShellKeydown} />

<Tooltip.Provider delayDuration={350}>
	<div class="flex h-dvh w-full gap-3 p-3">
		<SidebarRecents
			collapsed={!shell.railOpen}
			sessions={shell.sessions}
			activeId={shell.session?.id ?? null}
			onToggle={() => shell.toggleRail()}
			onNew={() => shell.newInvestigation()}
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
					<p class="max-w-64 text-center text-[12.5px] leading-relaxed text-ink-3">
						The search surface lands here with the query pipeline (spec §11 step 2).
					</p>
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
					height={shell.drawerHeight}
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

	<!-- Settings surface chrome; endpoint/key/model/relay controls land in #11. -->
	{#if shell.settingsOpen}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
			style:animation="fade-in 180ms ease-out both"
			onclick={() => shell.toggleSettings()}
			onkeydown={(e) => e.key === 'Enter' && shell.toggleSettings()}
			role="presentation"
		>
			<div
				class="w-80 rounded-window bg-surface p-4 shadow-overlay"
				style:animation="pop-in 180ms cubic-bezier(0.23,1,0.32,1) both"
				role="dialog"
				aria-modal="true"
				aria-label="Settings"
			>
				<div class="mb-2 flex items-center">
					<span class="flex-1 text-[14px] font-semibold text-ink">Settings</span>
					<button
						type="button"
						aria-label="Close settings"
						onclick={() => shell.toggleSettings()}
						class="primitive-icon-button text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
					>
						<IconX size={16} stroke-width={2} />
					</button>
				</div>
				<p class="text-[12.5px] leading-relaxed text-ink-2">
					AI endpoint, API key, model picker, and the relay pool arrive in #11 (spec §5). The
					key never persists — memory only.
				</p>
			</div>
		</div>
	{/if}
</Tooltip.Provider>
