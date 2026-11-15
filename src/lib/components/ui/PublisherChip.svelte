<script lang="ts">
	/* PUBLISHER CHIP — the result surface's author identity cell
	 * (issue #38, spec §9 P3 anatomy; kind-0 = NIP-01). Presents the
	 * pubkey's kind-0 profile (name + picture) when one exists on the
	 * configured relays, else an honest deterministic inline identicon +
	 * npub token. spec §1 forbids third-party image hosts, so the fallback
	 * is derived in $lib/publisher from the pubkey — no external service
	 * ever, and the "never blank" contract is unit-testable outside the DOM.
	 *
	 * Writing rule (spec §9): a profile's own name is human prose → sans;
	 * the npub fallback is a machine-made value → mono.
	 *
	 * Presentational except for the profiles seam it calls on mount — the
	 * page wires the singleton profile store; this chip only reads it.
	 *
	 * Three-way honesty (issue #131 WP7, spec §2 never-lie): the seam answers
	 * found / asked-and-empty / never-asked, and the chip claims exactly that
	 * much. A never-asked lookup (no relays configured) renders the identicon
	 * with no "no profile" claim anywhere in its tooltip or labels. */

	import { fly } from 'svelte/transition';
	import { getProfile, profileClaim, type ProfileLookup } from '$lib/net/profiles';
	import { identiconCells, publisherHue, publisherNpub, publisherToken } from '$lib/publisher';
	import KeyHint from '../shell/KeyHint.svelte';

	interface Props {
		pubkey: string;
		/** A tab stop, for chips that are not inside an interactive parent
		 * (dossier header). Inside a card, graph node or source row the
		 * tooltip stays hover-only: a second tab stop inside an interactive parent
		 * breaks keyboard flow (spec §9 keyboard rule, #39). */
		focusable?: boolean;
	}

	let { pubkey, focusable = false }: Props = $props();

	/** undefined = not asked yet (or nothing to ask) — no claim is rendered. */
	let profile = $state<ProfileLookup>(undefined);
	/** A resolved kind-0 picture that failed to load drops to the identicon. */
	let imgFailed = $state(false);
	/** Gates the arrival fade: content mounts only once the profile settles. */
	let settled = $state(false);

	/** Full npub for the tooltip; the fallback derivations live in
	 * $lib/publisher so "deterministic, never blank" is unit-testable. */
	const npub = $derived(publisherNpub(pubkey));
	/** label token: bech32 npub's first 8 chars + trailing 4 (mono, machine-made) —
	 * sliced from the npub derived above, so one card pays one bech32 encode. */
	const labelToken = $derived(publisherToken(npub));

	const hue = $derived(publisherHue(pubkey));
	const cells = $derived(identiconCells(hue));

	/** What the settled lookup licenses this chip to claim. */
	const claim = $derived(profileClaim(profile));

	/** Tooltip second line: only a real, asked miss may claim "no kind-0
	 * profile on your relays"; an unasked lookup shows the bare npub
	 * (issue #131 WP7). */
	const claimLine = $derived(
		claim === 'found'
			? 'Nostr profile found'
			: claim === 'missing'
				? 'No kind-0 profile on your relays'
				: null
	);

	$effect(() => {
		// Fetch once on mount; the seam caches + dedupes, so re-mounts are free.
		let active = true;
		getProfile(pubkey).then((p) => {
			if (!active) return;
			profile = p;
			imgFailed = false;
			settled = true;
		});
		return () => {
			active = false;
		};
	});
</script>

<KeyHint nameless hoverOnly={!focusable} side="bottom">
	{#snippet content()}
		<span class="block font-mono break-all">{npub}</span>
		{#if claimLine !== null}<span class="mt-0.5 block">{claimLine}</span>{/if}
	{/snippet}
	{#snippet trigger({ props })}
		<span {...props} class="inline-flex max-w-full items-center gap-1.5 align-middle">
			{#if settled}
				<!-- profile resolved: fade up ~160ms into place -->
				<span class="inline-flex max-w-full items-center gap-1.5" transition:fly={{ x: 0, y: 1, duration: 160 }}>
					{#if claim === 'found' && profile?.picture && !imgFailed}
						<!-- kind-0 picture; onerror drops to the identicon -->
						<img
							src={profile.picture}
							alt=""
							loading="lazy"
							class="h-4 w-4 shrink-0 rounded-full bg-inset object-cover outline outline-1 outline-line"
							onerror={() => (imgFailed = true)}
						/>
					{:else}
						<!-- deterministic inline identicon (spec §1: no third-party hosts).
							Covers all three states — found-without-picture, asked-and-empty,
							never-asked — and asserts nothing either way. -->
						<svg
							viewBox="0 0 5 5"
							shape-rendering="crispEdges"
							class="h-4 w-4 shrink-0 rounded-full"
							role="img"
							aria-label="publisher identicon"
						>
							<rect width="5" height="5" fill="oklch(0.955 0.003 264)" />
							{#each cells as row, y}
								{#each row as on, x}
									{#if on}
										<rect
											x={x}
											y={y}
											width="1"
											height="1"
											fill="oklch(0.52 0.025 {hue})"
										/>
									{/if}
								{/each}
							{/each}
						</svg>
					{/if}
					{#if claim === 'found' && profile?.name}
						<!-- human prose → sans; truncate long author names -->
						<!-- line-height 1.3: leading-none clips the "g"/"y" descender under
					truncate's overflow-hidden (owner report 2026-09-09) -->
					<span class="max-w-[140px] truncate font-sans text-[11.5px] leading-[1.3] text-ink">
							{profile.name}
						</span>
					{:else}
						<!-- machine-made npub token → mono (missing and unasked alike: the
							token is the honest cell, the tooltip carries the difference) -->
						<span class="font-mono text-[10.5px] leading-none text-ink-3">{labelToken}</span>
					{/if}
				</span>
			{:else}
				<!-- fetching: neutral tint pulse 16px circle (no canon shimmer in tree) -->
				<span class="h-4 w-4 shrink-0 animate-pulse rounded-full bg-inset" aria-hidden="true"></span>
			{/if}
		</span>
	{/snippet}
</KeyHint>
