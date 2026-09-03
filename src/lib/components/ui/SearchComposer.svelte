<script lang="ts">
	/* SEARCH COMPOSER — the J1 hero input (issue #37, spec §9).
	 *
	 * VENDORED MUTATION of canon PromptBar
	 * (beautiful-ui-svelte/src/components/PromptBar/PromptBar.svelte) in its
	 * TALL variant — the layout the beautiful-ui harness uses on its home
	 * surface: multi-line input, controls on their own row (model picker
	 * left, send right). Stripped per the app's real control set: the
	 * attachments plus button, @/sources and /command menus, dictation, the
	 * demo walkthrough, and the glimm celebratory sweep.
	 *
	 * The model picker is app-wired instead of demo-hardcoded: the list is
	 * fetched live from the user's endpoint (/v1/models, same seam as the
	 * Settings combobox, spec §5) and choosing one persists via
	 * settings.setModel. Without an API key the field routes to Settings —
	 * the same answer the no-key banner gives (spec §4).
	 *
	 * Model ids are machine-made values, so they render mono (spec §9
	 * writing rule); titles/snippets stay sans. */

	import GlideHighlight from 'beautiful-ui-svelte/src/lib/GlideHighlight.svelte';
	import { IconArrowUp, IconChevronDown } from '@tabler/icons-svelte';
	import { fetchModels } from '$lib/ai/models';
	import { settings } from '$lib/settings.svelte';
	import KeyHint from '../shell/KeyHint.svelte';

	interface Props {
		onSubmit: (question: string) => void;
		/** Which model the picker label falls back to before one is chosen comes
		 * from settings itself; without a key the picker routes here. */
		onSettings: () => void;
	}

	let { onSubmit, onSettings }: Props = $props();

	let draft = $state('');
	let modelOpen = $state(false);

	let models = $state<string[]>([]);
	let modelsStatus = $state<'idle' | 'loading' | 'ok' | 'error'>('idle');

	const canSend = $derived(draft.trim() !== '');

	function send() {
		if (!canSend) return;
		onSubmit(draft.trim());
		draft = '';
		modelOpen = false;
	}

	/* Tall composer chord (canon PromptBar): Enter sends, Shift+Enter
	 * newline, Escape closes the open menu first. */
	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && modelOpen) {
			modelOpen = false;
			return;
		}
		if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			send();
		}
	}

	/* Model menu: the list is fetched on open (live endpoint truth, spec §5),
	 * never cached across sessions. No key = route to Settings, same as the
	 * no-key banner (spec §4). */
	async function toggleModels(): Promise<void> {
		if (settings.apiKey === '') {
			onSettings();
			return;
		}
		modelOpen = !modelOpen;
		if (!modelOpen) return;
		modelsStatus = 'loading';
		const result = await fetchModels(settings.endpoint, settings.apiKey);
		if (result.ok) {
			models = result.models;
			modelsStatus = 'ok';
		} else {
			modelsStatus = 'error';
		}
	}

	function selectModel(id: string): void {
		void settings.setModel(id);
		modelOpen = false;
	}

	/* Canon's outside-click close, scoped to this composer. */
	function onWindowPointerDown(event: PointerEvent): void {
		if (!modelOpen) return;
		if (!(event.target as Element).closest('[data-search-composer]')) modelOpen = false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div data-search-composer class="relative">

	<!-- composer: canon tall chrome (controls on their own row) -->
	<div
		class="relative isolate flex flex-col gap-2.5 rounded-[22px] border border-line bg-surface p-3.5 shadow-card transition-[border-color] duration-150 focus-within:border-line-strong"
	>
		<!-- svelte-ignore a11y_autofocus — the hero composer IS the page's
			purpose (spotlight pattern); focus lands where the only action is. -->
		<textarea
			bind:value={draft}
			{onkeydown}
			rows="2"
			autofocus
			aria-label="Question"
			placeholder="Ask in plain English, or drop a CVE, GHSA, package URL, cert id…"
			class="min-h-[68px] w-full min-w-0 resize-none bg-transparent px-2 py-2 text-[14px] leading-5 text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-2"
		></textarea>

		<div class="grid grid-cols-[auto_minmax(0,1fr)_28px] items-end gap-x-1">
			<!-- model picker (left) — the menu anchors to the button and
				grows over the composer like canon's, never floats to the
				container's top edge. -->
			<div class="relative col-start-1 row-start-1">
				<button
					type="button"
					aria-expanded={modelOpen}
					aria-label="Choose model"
					onclick={toggleModels}
					class="flex h-7 shrink-0 items-center gap-1 rounded-control px-1.5 font-mono text-[12px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink {modelOpen
						? 'bg-hover text-ink'
						: ''}"
				>
					{settings.model || 'Choose model'}
					<IconChevronDown size={11} stroke={2.4} class="text-ink-3" />
				</button>

				{#if modelOpen}
					<!-- model menu: canon's floating listbox above its trigger,
						glide rows reskinned with the shared GlideHighlight. rows
						are shrink-0 so the list scrolls at max-h instead of
						flex-squashing. -->
					<div
						role="listbox"
						tabindex="-1"
						class="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-card bg-surface p-1 shadow-raised"
						style:animation="pop-in 180ms cubic-bezier(0.23,1,0.32,1) both"
						style:transform-origin="bottom left"
					>
						{#if modelsStatus === 'loading' || modelsStatus === 'idle'}
							<p class="px-2 py-2 text-[12.5px] text-ink-3">Loading models…</p>
						{:else if modelsStatus === 'error'}
							<p class="px-2 py-2 text-[12.5px] text-ink-3">
								Couldn't load models — check the endpoint in Settings.
							</p>
						{:else}
							<GlideHighlight
								class="flex max-h-64 flex-col gap-px overflow-y-auto"
								highlightClass="inset-x-0 rounded-chip bg-hover"
							>
								{#each models as id (id)}
									<button
										data-menu-row
										type="button"
										onmousedown={(event) => event.preventDefault()}
										onclick={() => selectModel(id)}
										class="relative z-10 flex h-7.5 w-full shrink-0 items-center gap-2 rounded-chip px-2 text-left"
									>
										<span class="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink"
											>{id}</span
										>
										<span class="shrink-0 text-ink {id === settings.model ? '' : 'invisible'}">
											<svg
												width="13"
												height="13"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2.5"
												stroke-linecap="round"
												stroke-linejoin="round"
												aria-hidden="true"
											>
												<path d="M20 6L9 17l-5-5" />
											</svg>
										</span>
									</button>
								{/each}
							</GlideHighlight>
						{/if}
					</div>
				{/if}
			</div>

			<!-- send (right) — canon's ink send button -->
			<KeyHint
				label="Search"
				keys="Enter"
				side="left"
				class="col-start-3 row-start-1 flex size-7 shrink-0 items-center justify-center rounded-control transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]"
				onclick={send}
			>
				<span
					class="flex size-7 items-center justify-center rounded-control"
					style:background={canSend ? 'var(--ink)' : 'var(--line-strong)'}
					style:color={canSend ? 'var(--surface)' : 'var(--ink-2)'}
				>
					<IconArrowUp size={16} stroke={2.4} />
				</span>
			</KeyHint>
		</div>
	</div>
</div>
