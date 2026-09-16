<script lang="ts">
	/* COLD OPEN — issue #31 share links (spec §1 L22, §8): a share URL
	 * lands here (the SPA fallback serves the app for /event/<nevent>).
	 * The nevent is decoded, the shared root is resolved from its hinted
	 * relays and adopted into the investigation, then this page hands over
	 * to the root surface — the full card-inspection screen with the drawer
	 * open on the shared subject, uninterpreted first (spec §8, the
	 * existing progressive fill interprets it from there).
	 *
	 * Failures render HERE, honestly (spec §2 never-lie): a malformed link
	 * names what was pasted (deep-link.ts's message, verbatim); a not-found
	 * names which hinted relays failed (spec §4); a rejected record names
	 * the admission reason. The shell only exists on the root route, so
	 * this page is its own minimal frame — no fake chrome.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { base } from '$app/paths';
	import { decodeShareLink, type SharePointer } from '$lib/share/deep-link';
	import {
		openSharedRecord,
		ShareNotFoundError,
		ShareRejectedError
	} from '$lib/pipeline/share-open';
	import { getEvent } from '$lib/db';
	import { investigation } from '$lib/investigation.svelte';

	let { params } = $props();

	type Stage =
		| { kind: 'resolving' }
		| {
				kind: 'error';
				title: string;
				message: string;
				relays: string[];
				answeredOk: boolean;
			};
	let stage = $state<Stage>({ kind: 'resolving' });

	async function goHome(): Promise<void> {
		await goto(base + '/');
	}

	async function resolve(nevent: string): Promise<void> {
		// Retry re-enters here, so the frame flips back to the honest
		// "opening…" line before the relay round-trip starts again.
		stage = { kind: 'resolving' };
		// 1. Decode — the parse error's message names what was actually
		// pasted so the recipient isn't told a lie about their own link.
		let pointer: SharePointer;
		try {
			pointer = decodeShareLink(nevent);
		} catch (err) {
			stage = {
				kind: 'error',
				title: "That link isn't a shareable record",
				message: err instanceof Error ? err.message : String(err),
				relays: [],
				answeredOk: false
			};
			return;
		}
		// 2. Resolve — cache-first, then the hinted relays, then NIP-65 and
		// the configured pool (share-open.ts); admission was gated there.
		try {
			const resolved = await openSharedRecord(pointer);
			// The resolver reports the id (contract) and cached the gated
			// root; re-read the bytes to adopt into the investigation.
			const cached = await getEvent(resolved.subjectId);
			if (cached === null) {
				stage = {
					kind: 'error',
					title: "Couldn't open the shared record",
					message: "the app's local storage is unavailable — reopen the link in a normal window",
					relays: [],
					answeredOk: false
				};
				return;
			}
			await investigation.openShared(cached, resolved.failedHints, pointer.relays.length > 0);
			// The shell lives on the root route; hand over there. replaceState
			// keeps the share URL out of the back/forward loop — back from the
			// opened record must not re-run the cold open.
			await goto(base + '/', { replaceState: true });
		} catch (err) {
			if (err instanceof ShareNotFoundError) {
				// never-lie (spec §2/§4): when answeredOk is true, some relay
				// WAS reachable and said it holds no copy — the failure is
				// absence, not silence, so the copy blames no relay; when
				// false, nothing answered and the dead hints are named.
				stage = {
					kind: 'error',
					title: 'Shared record not found',
					message: err.answeredOk
						? 'the relays that answered were reachable, but none held this record — it may have been deleted or never reached them'
						: err.triedRelays.length === 0
							? 'no relay held it and the link carried no working relay hints'
							: 'the record was not found — these hinted relays failed to answer',
					relays: err.triedRelays,
					answeredOk: err.answeredOk
				};
			} else if (err instanceof ShareRejectedError) {
				stage = {
					kind: 'error',
					title: 'Shared record rejected',
					message: err.message,
					relays: [],
					answeredOk: false
				};
			} else {
				stage = {
					kind: 'error',
					title: "Couldn't open the shared record",
					message: err instanceof Error ? err.message : String(err),
					relays: [],
					answeredOk: false
				};
			}
		}
	}

	onMount(() => {
		// The page only cold-opens links it mounts for; retry re-invokes
		// resolve with the CURRENT param, so the closure reads it per call.
		void resolve(params.nevent);
	});
</script>

<svelte:head>
	<title>Shared record — scrutiny lens</title>
</svelte:head>

<div class="flex min-h-dvh w-full items-center justify-center p-4">
	{#if stage.kind === 'resolving'}
		<!-- honest tiny frame while the relay round-trip runs — no skeleton
			fake chrome, just the mono line (spec §2). -->
		<p class="font-mono text-[12px] text-ink-2">opening shared record…</p>
	{:else}
		<div class="flex w-full max-w-[440px] flex-col gap-3 p-2">
			<h3 class="font-sans text-[15px] font-bold text-ink">{stage.title}</h3>
			<p class="font-mono text-[12px] text-ink-2">{stage.message}</p>

			{#if stage.relays.length > 0}
				<!-- spec §4: name the hinted relays that failed, verbatim —
					the receipt list, mono, orange, same honesty lane as the
					results surface's all-relays-dead error. -->
				<div class="rounded-[10px] border border-line bg-surface p-3">
					<ul class="flex flex-col gap-1.5">
						{#each stage.relays as url (url)}
							<li class="flex items-baseline gap-2 font-mono text-[11.5px]">
								<span class="truncate text-ink">{url}</span>
								<span class="ml-auto shrink-0 tabular-nums text-orange">failed</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="mt-1 flex flex-wrap items-center gap-2">
				<button
					type="button"
					class="rounded-full bg-ink px-4 py-1.5 text-[12px] font-medium text-surface hover:opacity-90"
					onclick={() => void resolve(params.nevent)}
				>
					Try again
				</button>
				<button
					type="button"
					class="rounded-full border border-line px-4 py-1.5 text-[12px] font-medium text-ink hover:bg-inset"
					onclick={goHome}
				>
					Go to overview
				</button>
				<button
					type="button"
					class="rounded-full px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-inset"
					title="Settings lives on the overview — edit your relay list there"
					onclick={goHome}
				>
					Edit relay list in Settings
				</button>
			</div>
		</div>
	{/if}
</div>
