<script lang="ts">
	/* SETTINGS DIALOG (issue #11, spec §5/§6/§8): AI provider (endpoint / key /
	 * live model list), appearance, relay pool editor (2–4 entries), and the
	 * one Clear-all action. Replaces the #10 staging overlay; mounted only
	 * while open (+page.svelte gates on shell.settingsOpen), so drafts copy
	 * from the hydrated settings singleton at mount.
	 *
	 * The key is memory-only (spec §6): setApiKey keeps it in runes state and
	 * arms the registerSecret strip; nothing here serializes it. */

	import { Combobox } from 'bits-ui';
	import {
		IconCheck,
		IconChevronDown,
		IconDeviceDesktop,
		IconMoon,
		IconPlus,
		IconSun,
		IconTrash,
		IconX
	} from '@tabler/icons-svelte';
	import { fetchModels } from '$lib/ai/models';
	import KeyField from '$lib/components/ui/KeyField.svelte';
	import { RELAY_MAX, RELAY_MIN, type Appearance } from '$lib/config';
	import { clearAllLocalData } from '$lib/db';
	import { settings } from '$lib/settings.svelte';

	interface Props {
		onClose: () => void;
	}

	let { onClose }: Props = $props();

	// ── AI provider ──────────────────────────────────────────────────────────

	let endpointDraft = $state(settings.endpoint);

	function commitEndpoint(): void {
		const endpoint = endpointDraft.trim();
		if (endpoint !== '' && endpoint !== settings.endpoint) void settings.setEndpoint(endpoint);
	}

	/** Live model list (spec §5): refetches (debounced) whenever the endpoint
	 * or key changes. No key → the combobox shows a hint instead. */
	type ModelState = 'idle' | 'loading' | 'ready' | 'error';
	let modelState = $state<ModelState>('idle');
	let models = $state<string[]>([]);
	let modelError = $state('');
	let modelInput = $state(settings.model);

	const filteredModels = $derived(
		models
			.filter((m) => m.toLowerCase().includes(modelInput.toLowerCase()))
			.map((m) => ({ value: m, label: m }))
	);

	$effect(() => {
		const endpoint = settings.endpoint;
		const apiKey = settings.apiKey;
		if (apiKey === '') {
			modelState = 'idle';
			models = [];
			return;
		}
		const controller = new AbortController();
		modelState = 'loading';
		const timer = setTimeout(() => {
			void (async () => {
				try {
					const result = await fetchModels(endpoint, apiKey, controller.signal);
					if (controller.signal.aborted) return;
					if (result.ok) {
						models = result.models;
						modelState = 'ready';
					} else {
						models = [];
						modelError =
							result.kind === 'http'
								? `Endpoint answered ${result.status}.`
								: result.kind === 'invalid'
									? 'Endpoint did not return an OpenAI-style model list.'
									: 'Endpoint unreachable.';
						modelState = 'error';
					}
				} catch {
					// Aborted by a newer effect run.
				}
			})();
		}, 400);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	// ── Appearance (spec §5: light / dark / system) ──────────────────────────

	const appearanceOptions: { value: Appearance; label: string; icon: typeof IconSun }[] = [
		{ value: 'light', label: 'Light', icon: IconSun },
		{ value: 'dark', label: 'Dark', icon: IconMoon },
		{ value: 'system', label: 'System', icon: IconDeviceDesktop }
	];

	// ── Relay pool (spec §8: 2–4 entries, user-editable) ─────────────────────

	// A misconfigured env can hand the store fewer than RELAY_MIN relays
	// (the editor enforces bounds only on commit) — pad the drafts with
	// empty rows so the editor always shows itself at the valid floor.
	function padRelayDrafts(drafts: string[]): string[] {
		while (drafts.length < RELAY_MIN) drafts.push('');
		return drafts;
	}

	let relayDrafts = $state<string[]>(padRelayDrafts([...settings.relays]));
	let relayError = $state('');
	// Backdrop close applies ONLY when the press itself started on the
	// backdrop — a text-selection drag that leaves the dialog would
	// otherwise close it with uncommitted drafts (review #11).
	let backdropPressed = false;

	async function commitRelays(): Promise<void> {
		// Blank drafts (padded-to-floor rows, or a row the user emptied) are
		// "not entered yet", never a payload — committing them as entries would
		// throw a spurious validation error on an innocent blur (review #11).
		const drafts = relayDrafts.map((u) => u.trim()).filter((u) => u !== '');
		if (drafts.length === settings.relays.length && drafts.every((u, i) => u === settings.relays[i])) {
			relayError = '';
			return;
		}
		try {
			await settings.setRelays(drafts);
			relayDrafts = padRelayDrafts([...drafts]); // drop consumed blanks
			relayError = '';
		} catch (error) {
			relayError = error instanceof Error ? error.message : String(error);
		}
	}

	function removeRelay(index: number): void {
		relayDrafts.splice(index, 1);
		void commitRelays();
	}

	function addRelay(): void {
		relayDrafts.push('');
	}

	// ── Data (spec §6: one Clear-all action) ─────────────────────────────────

	async function clearAll(): Promise<void> {
		await clearAllLocalData();
		location.reload();
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
	style:animation="fade-in 180ms ease-out both"
	onclick={(event) => {
		if (backdropPressed && event.target === event.currentTarget) onClose();
		backdropPressed = false;
	}}
	onmousedown={(event) => (backdropPressed = event.target === event.currentTarget)}
	role="presentation"
>
	<div
		class="max-h-[85dvh] w-[26rem] overflow-y-auto rounded-window bg-surface p-4 shadow-overlay"
		style:animation="pop-in 180ms cubic-bezier(0.23,1,0.32,1) both"
		role="dialog"
		aria-modal="true"
		aria-label="Settings"
	>
		<div class="mb-3 flex items-center">
			<span class="flex-1 text-[14px] font-semibold text-ink">Settings</span>
			<button
				type="button"
				aria-label="Close settings"
				onclick={onClose}
				class="primitive-icon-button text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
			>
				<IconX size={16} stroke-width={2} />
			</button>
		</div>

		<!-- AI provider (spec §5) -->
		<section class="mb-4">
			<h3 class="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">AI provider</h3>
			<label for="settings-endpoint" class="mb-1 block text-[12.5px] text-ink-2">Endpoint</label>
			<input
				id="settings-endpoint"
				bind:value={endpointDraft}
				onblur={commitEndpoint}
				onkeydown={(event) => event.key === 'Enter' && commitEndpoint()}
				spellcheck="false"
				class="mb-3 w-full rounded-control bg-field px-2 py-1.5 font-mono text-[12.5px] text-ink shadow-hairline outline-none transition-shadow duration-150 placeholder:text-ink-3 focus:shadow-card"
			/>

			<label for="settings-key" class="mb-1 block text-[12.5px] text-ink-2">API key</label>
			<KeyField
				id="settings-key"
				value={settings.apiKey}
				oninput={(value) => settings.setApiKey(value)}
			/>
			<!-- spec §5: in-product disclosure at the key field -->
			<p class="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
				Everything you send — event contents, your questions, chat — goes to this endpoint
				provider. The key lives in memory for this tab only.
			</p>

			<span class="mt-3 mb-1 block text-[12.5px] text-ink-2">Model</span>
			{#if settings.apiKey === ''}
				<input
					disabled
					value={settings.model}
					placeholder="Set an API key to load models from the endpoint"
					class="w-full rounded-control bg-field px-2 py-1.5 text-[12.5px] text-ink-3 shadow-hairline"
				/>
			{:else}
				<Combobox.Root
					type="single"
					value={settings.model}
					onValueChange={(value) => {
						void settings.setModel(value);
						// bits-ui mirrors the picked label into its internal input
						// text; keep the local filter in the same state.
						modelInput = value;
					}}
					items={filteredModels}
				>
					<div
						class="flex items-center rounded-control bg-field shadow-hairline transition-shadow duration-150 focus-within:shadow-card"
					>
						<Combobox.Input
							aria-label="Model"
							placeholder={modelState === 'loading' ? 'Loading models…' : 'Search models'}
							defaultValue={modelInput}
							oninput={(event) => (modelInput = event.currentTarget.value)}
							class="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3"
						/>
						<Combobox.Trigger
							class="primitive-icon-button mr-0.5 text-ink-3 hover:bg-hover hover:text-ink"
							aria-label="Show models"
						>
							<IconChevronDown size={14} stroke-width={2} />
						</Combobox.Trigger>
					</div>
					<Combobox.Portal>
						<Combobox.Content
							class="z-50 max-h-48 w-[var(--bits-combobox-anchor-width)] min-w-48 overflow-y-auto rounded-card bg-surface p-1 shadow-overlay"
							sideOffset={4}
						>
							<Combobox.Viewport>
								{#each filteredModels as model (model.value)}
									<Combobox.Item
										value={model.value}
										label={model.label}
										class="flex cursor-pointer items-center gap-1.5 rounded-control px-2 py-1.5 text-[12.5px] text-ink data-highlighted:bg-hover"
									>
										{#snippet children({ selected })}
											<span class="w-3.5 text-ink-2">
												{#if selected}<IconCheck size={13} stroke-width={2.5} />{/if}
											</span>
											<span class="font-mono">{model.label}</span>
										{/snippet}
									</Combobox.Item>
								{:else}
									<div class="px-2 py-1.5 text-[12.5px] text-ink-3">
										{modelState === 'error' ? modelError : 'No matching models.'}
									</div>
								{/each}
							</Combobox.Viewport>
						</Combobox.Content>
					</Combobox.Portal>
				</Combobox.Root>
				{#if modelState === 'error'}
					<p class="mt-1.5 text-[11.5px] text-red">{modelError}</p>
				{:else if modelState === 'ready' && models.length === 0}
					<p class="mt-1.5 text-[11.5px] text-ink-3">The endpoint reported no models.</p>
				{/if}
			{/if}
		</section>

		<!-- Appearance -->
		<section class="mb-4">
			<h3 class="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Appearance</h3>
			<div class="flex gap-0.5 rounded-control bg-field p-0.5 shadow-hairline" role="group" aria-label="Appearance">
				{#each appearanceOptions as option (option.value)}
					<button
						type="button"
						aria-pressed={settings.appearance === option.value}
						onclick={() => void settings.setAppearance(option.value)}
						class="flex flex-1 items-center justify-center gap-1.5 rounded-[6px] py-1 text-[12.5px] transition-colors duration-150 {settings.appearance ===
						option.value
							? 'bg-surface text-ink shadow-btn'
							: 'text-ink-3 hover:text-ink'}"
					>
						<option.icon size={13} stroke-width={2} />
						{option.label}
					</button>
				{/each}
			</div>
		</section>

		<!-- Relay pool -->
		<section class="mb-4">
			<h3 class="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Relays</h3>
			<div class="flex flex-col gap-1.5">
				{#each relayDrafts as relay, index (index)}
					<div class="flex items-center gap-1">
						<input
							bind:value={relayDrafts[index]}
							onblur={() => void commitRelays()}
							placeholder="wss://…"
							spellcheck="false"
							class="min-w-0 flex-1 rounded-control bg-field px-2 py-1.5 font-mono text-[12.5px] text-ink shadow-hairline outline-none transition-shadow duration-150 placeholder:text-ink-3 focus:shadow-card"
						/>
						<button
							type="button"
							aria-label="Remove relay"
							disabled={relayDrafts.length <= RELAY_MIN}
							onclick={() => removeRelay(index)}
							class="primitive-icon-button text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-red disabled:opacity-40"
						>
							<IconTrash size={14} stroke-width={2} />
						</button>
					</div>
				{/each}
			</div>
			{#if relayDrafts.length < RELAY_MAX}
				<button
					type="button"
					onclick={addRelay}
					class="mt-1.5 flex items-center gap-1 text-[12.5px] text-ink-2 transition-colors duration-150 hover:text-ink"
				>
					<IconPlus size={13} stroke-width={2} /> Add relay
				</button>
			{/if}
			{#if relayError}
				<p class="mt-1.5 text-[11.5px] text-red">{relayError}</p>
			{/if}
			<p class="mt-1 text-[11.5px] text-ink-3">{RELAY_MIN}–{RELAY_MAX} relays; the pool is saved automatically once valid.</p>
		</section>

		<!-- Data (spec §6) -->
		<section>
			<h3 class="mb-2 text-[12px] font-semibold tracking-wide text-ink-3 uppercase">Local data</h3>
			<p class="mb-2 text-[11.5px] leading-relaxed text-ink-3">
				Settings, sessions, and interpretations live unencrypted in this browser's IndexedDB, best-effort — the browser may evict them, and private windows keep nothing.
			</p>
			<button
				type="button"
				onclick={() => void clearAll()}
				class="rounded-control bg-red-tint px-2.5 py-1.5 text-[12.5px] font-medium text-red transition-colors duration-150 hover:bg-red hover:text-white"
			>
				Clear all local data
			</button>
		</section>
	</div>
</div>
