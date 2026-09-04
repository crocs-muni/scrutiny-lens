<script lang="ts">
	/* PUBLISHER CHIP — the result surface's author identity cell
	 * (issue #38, spec §9 P3 anatomy; kind-0 = NIP-01). Presents the
	 * pubkey's kind-0 profile (name + picture) when one exists on the
	 * configured relays, else an honest deterministic inline identicon +
	 * npub token. spec §1 forbids third-party image hosts, so the fallback
	 * is drawn in-component from the pubkey — no external service ever.
	 *
	 * Writing rule (spec §9): a profile's own name is human prose → sans;
	 * the npub fallback is a machine-made value → mono.
	 *
	 * Presentational except for the profiles seam it calls on mount — the
	 * page wires the singleton profile store; this chip only reads it. */

	import { fly } from 'svelte/transition';
	import { npubEncode } from 'nostr-tools/nip19';
	import { getProfile, type PublisherProfile } from '$lib/net/profiles';

	interface Props {
		pubkey: string;
	}

	let { pubkey }: Props = $props();

	let profile: PublisherProfile | null = $state(null);
	/** A resolved kind-0 picture that failed to load drops to the identicon. */
	let imgFailed = $state(false);
	/** Gates the arrival fade: content mounts only once the profile settles. */
	let settled = $state(false);

	/** Full npub for the title; falls back to the raw hex if bech32 encode fails. */
	const npub = $derived(encodeNpub(pubkey));
	/** label token: bech32 npub's first 8 chars + trailing 4 (mono, machine-made). */
	const labelToken = $derived(`${npub.slice(0, 8)}…${npub.slice(-4)}`);

	const hue = $derived(hashHue(pubkey));
	const cells = $derived(mirroredCells(pubkey));

	const title = $derived(
		profile
			? `${npub} · kind-0 profile found`
			: `${npub} · no kind-0 profile on your relays`
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

	/** npubEncode throws on malformed hex — degrade to the raw 8:4 slice. */
	function encodeNpub(hex: string): string {
		try {
			return npubEncode(hex);
		} catch {
			return hex;
		}
	}

	/** FNV-1a over the pubkey → a stable 0–359° hue for both identicon tones. */
	function hashHue(key: string): number {
		let hash = 0x811c9dc5;
		for (const ch of key) {
			hash ^= ch.charCodeAt(0);
			hash = Math.imul(hash, 0x01000193);
		}
		return hash >>> 0;
	}

	/** Deterministic 5×5 two-tone pattern from the pubkey: the left-top 3×3
	 * region is mirrored both ways so the icon reads symmetric at 16px. Bit i
	 * of a per-cell keyed mix picks each cell's tone — no random state. */
	function mirroredCells(key: string): boolean[][] {
		const seed = hashHue(key);
		const grid: boolean[][] = [];
		for (let y = 0; y < 5; y++) {
			const row: boolean[] = [];
			for (let x = 0; x < 5; x++) {
				const sy = y <= 2 ? y : 4 - y;
				const sx = x <= 2 ? x : 4 - x;
				const i = sy * 3 + sx;
				const bit = Math.imul(seed, i + 1) + 0x9e3779b9 + sx * 37 + sy * 91;
				row.push(((bit >>> i) & 1) === 1);
			}
			grid.push(row);
		}
		return grid;
	}
</script>

<span title={title} class="inline-flex max-w-full items-center gap-1.5 align-middle">
	{#if settled}
		<!-- profile resolved: fade up ~160ms into place -->
		<span class="inline-flex max-w-full items-center gap-1.5" transition:fly={{ x: 0, y: 1, duration: 160 }}>
			{#if profile?.picture && !imgFailed}
				<!-- kind-0 picture; onerror drops to the identicon -->
				<img
					src={profile.picture}
					alt=""
					loading="lazy"
					class="h-4 w-4 shrink-0 rounded-full bg-inset object-cover outline outline-1 outline-line"
					onerror={() => (imgFailed = true)}
				/>
			{:else}
				<!-- deterministic inline identicon (spec §1: no third-party hosts) -->
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
			{#if profile?.name}
				<!-- human prose → sans; truncate long author names -->
				<span class="max-w-[140px] truncate font-sans text-[11.5px] leading-none text-ink">
					{profile.name}
				</span>
			{:else}
				<!-- machine-made npub token → mono -->
				<span class="font-mono text-[10.5px] leading-none text-ink-3">{labelToken}</span>
			{/if}
		</span>
	{:else}
		<!-- fetching: neutral tint pulse 16px circle (no canon shimmer in tree) -->
		<span class="h-4 w-4 shrink-0 animate-pulse rounded-full bg-inset" aria-hidden="true"></span>
	{/if}
</span>
