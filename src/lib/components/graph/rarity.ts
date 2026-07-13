// Single source of truth for "rarity" -- how unusual a Metadata node's global
// binding degree is. Used for BOTH the node's color saturation (MetadataNode.svelte)
// and the physics (forceLink distance in FlowInner.svelte), so it must not be
// computed independently in two places. Higher rarity = more unique/interesting
// (e.g. this certificate's own Security Target) = should look more vivid AND sit
// closer to its Product in the layout. Lower rarity = boilerplate/shared (e.g. a
// common CC SAR component bound to hundreds of certificates) = washed-out AND
// pushed farther out.
const MAX_EXPECTED_DEGREE = 250; // rough observed ceiling for the most common shared SAR components on this relay

export function rarityScore(globalDegree: number): number {
	const clamped = Math.max(1, globalDegree);
	const raw = 1 - Math.log10(clamped) / Math.log10(MAX_EXPECTED_DEGREE);
	return Math.min(1, Math.max(0.15, raw)); // floor at 0.15 so even the most common node is never fully invisible/erased
}
