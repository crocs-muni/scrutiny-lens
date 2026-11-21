<script lang="ts">
	/* SEARCH COMPOSER — the J1 hero input (issue #37, spec §9; issue #139).
	 *
	 * VENDORED MUTATION of canon PromptBar
	 * (beautiful-ui-svelte/src/components/PromptBar/PromptBar.svelte). The
	 * tall variant's chat chrome (22px bubble, two-line field, up-arrow send,
	 * "Question" label) made the hero read as the chat column: readers typed
	 * meta questions into a relay search and got nothing (#139's UX review).
	 * This is the QUERY BAR mutation: one line, a visible "Search" label, a
	 * search glyph, and the model picker demoted to a small inline control.
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
	import { IconChevronDown, IconSearch } from '@tabler/icons-svelte';
	import { fetchModels } from '$lib/ai/models';
	import { settings } from '$lib/settings.svelte';
	import { isCapabilityQuestion } from '$lib/chat/capability';
	import { detectIdentifiers } from '$lib/ai/agents/query';
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
	/** Why the draft was held instead of searched (#139's guidance). */
	let guard = $state<'meta' | 'trivial' | null>(null);
	let inputEl: HTMLInputElement | null = null;

	let models = $state<string[]>([]);
	let modelsStatus = $state<'idle' | 'loading' | 'ok' | 'error'>('idle');

	const canSend = $derived(draft.trim() !== '');

	function submit(question: string): void {
		onSubmit(question);
		draft = '';
		guard = null;
		modelOpen = false;
	}

	/** A draft with no searchable content at all — `?`, `…`, punctuation. */
	const TRIVIAL = /^[\s?!.…]*$/;

	function send(): void {
		if (!canSend) return;
		const question = draft.trim();
		// #139 acceptance: a bare `?` shows guidance and runs NO search.
		if (TRIVIAL.test(question)) {
			guard = 'trivial';
			return;
		}
		// A question that names an identifier is a content question: it routes
		// to a tag search (spec §1) and never enters the meta lane.
		if (detectIdentifiers(question).length === 0 && isCapabilityQuestion(question)) {
			guard = 'meta';
			return;
		}
		submit(question);
	}

	function searchAnyway(): void {
		if (canSend) submit(draft.trim());
	}

	/* Enter sends, Escape closes the open menu first. The field is one line,
	 * so Shift+Enter has no newline to insert. */
	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && modelOpen) {
			modelOpen = false;
			return;
		}
		if (event.key === 'Escape' && guard !== null) {
			guard = null;
			return;
		}
		if (event.key === 'Enter' && !event.isComposing) {
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
		// canon parity (PromptBar.svelte:489): focus returns to the input —
		// otherwise the next Enter re-opens the menu instead of sending.
		inputEl?.focus();
	}

	/* Canon's outside-click close, scoped to this composer. */
	function onWindowPointerDown(event: PointerEvent): void {
		if (!modelOpen) return;
		if (!(event.target as Element).closest('[data-search-composer]')) modelOpen = false;
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div data-search-composer class="relative">
	<!-- The label is the affordance: the field says what it is before the
		reader types (spec §9 keyboard/label rule; #139). -->
	<label for="hero-search" class="mb-2 block text-[12px] font-semibold tracking-wide text-ink-3 uppercase">
		Search
	</label>

	<div
		class="flex items-center gap-1.5 rounded-[10px] border border-line bg-surface py-1.5 pr-1.5 pl-3 shadow-card transition-[border-color] duration-150 focus-within:border-line-strong"
	>
		<!-- svelte-ignore a11y_autofocus — the hero composer IS the page's
			purpose (spotlight pattern); focus lands where the only action is. -->
		<input
			id="hero-search"
			bind:this={inputEl}
			bind:value={draft}
			oninput={() => (guard = null)}
			{onkeydown}
			autofocus
			type="text"
			autocomplete="off"
			spellcheck="false"
			placeholder="Product, identifier (CVE, cert id, package URL), or plain English"
			class="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] leading-5 text-ink outline-none placeholder:text-ink-2"
		/>

		<!-- model picker, demoted: a quiet inline control, not the field's
			left-hand anchor. -->
		<div class="relative shrink-0">
			<button
				type="button"
				aria-expanded={modelOpen}
				aria-label="Choose model"
				onclick={toggleModels}
				class="flex h-7 shrink-0 items-center gap-1 rounded-control px-1.5 text-[11.5px] font-medium text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink {modelOpen
					? 'bg-hover text-ink'
					: ''}"
			>
				<span class={settings.model ? 'font-mono' : ''}>{settings.model || 'model'}</span>
				<IconChevronDown size={11} stroke={2.4} class="text-ink-3" />
			</button>

			{#if modelOpen}
				<!-- model menu: canon's floating listbox above its trigger,
					glide rows reskinned with the shared GlideHighlight. rows
					are shrink-0 so the list scrolls at max-h instead of
					flex-squashing. -->
				<div
					role="listbox"
					aria-label="Models"
					tabindex="-1"
					class="absolute right-0 bottom-full z-10 mb-2 w-72 rounded-card bg-surface p-1 shadow-raised"
					style:animation="pop-in 180ms cubic-bezier(0.23,1,0.32,1) both"
					style:transform-origin="bottom right"
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
									<span class="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{id}</span>
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

		<!-- send: a search glyph, not the chat up-arrow (the arrow was half of
			what made this read as chat, #139). The tooltip carries the three
			input shapes the placeholder only lists — one identifier, one prose
			question, one prefix:value (#139's "placeholder + tooltip examples").
			Native `title=` is banned here (tests/no-native-title.test.ts). -->
		<KeyHint
			label="Search"
			keys="Enter"
			side="left"
			class="flex size-8 shrink-0 items-center justify-center rounded-control transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]"
			onclick={send}
		>
			{#snippet content()}
				<span class="flex flex-col gap-1 text-[11px] leading-tight">
					<span class="font-mono">CVE-2017-15361</span>
					<span class="text-ink-2">card dossier for Infineon SLE78</span>
					<span class="font-mono">cc:ANSSI-CC-2015/12</span>
				</span>
			{/snippet}
			<span
				class="flex size-8 items-center justify-center rounded-control"
				style:background={canSend ? 'var(--ink)' : 'var(--line-strong)'}
				style:color={canSend ? 'var(--surface)' : 'var(--ink-2)'}
			>
				<IconSearch size={15} stroke={2.4} />
			</span>
		</KeyHint>
	</div>

	<!-- Announce the guidance, not just paint it: focus stays in the field, so
		a silent insertion reads as a broken button. One persistent region. -->
	<div aria-live="polite">
		{#if guard !== null}
			<div class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-2">
				<span>
					{guard === 'trivial'
						? 'A search needs a product name, an identifier, or a question — a bare symbol finds nothing.'
						: 'That reads like a question about this app — a relay search usually matches nothing for it.'}
				</span>
				<button
					type="button"
					onclick={searchAnyway}
					class="rounded-full border border-line-strong px-2.5 py-1 text-[11.5px] font-medium text-ink hover:bg-inset"
				>
					Search anyway
				</button>
			</div>
		{/if}
	</div>
</div>
