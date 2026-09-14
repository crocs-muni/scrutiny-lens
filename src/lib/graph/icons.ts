/**
 * Node icon vocabulary (#29b, BIBLE N2): deterministic — kind drives the
 * base icon, the metadata event's first i-prefix refines it. Neutral tile
 * everywhere; the stroke tints ONLY for warn-class content (N2: "tinted
 * stroke only when warn"). Mapped by evidence, not guesswork: prefixes not
 * listed fall back to the plain file icon (extend as the corpus's `i`
 * vocabulary grows — never infer from content, spec §2).
 */

import type { Icon } from '@tabler/icons-svelte';
import { IconBug, IconCpu, IconFile, IconFileText, IconShield, IconTarget } from '@tabler/icons-svelte';
import { tagValues, type NostrEvent } from '$lib/fabric';
import type { NodeKind } from './ego';

export interface NodeIconMapping {
	/** Tabler's (legacy-class) component type — dynamic tags accept it the
	 * same way the static <IconX> usages elsewhere in the app do. */
	icon: Icon;
	/** Warn-class content (N2): the tile stroke/icon picks up the amber hue. */
	warn: boolean;
}

const BY_I_PREFIX: Record<string, Icon> = {
	cve: IconBug,
	cert: IconFileText,
	st: IconTarget,
	'cc-pp': IconShield
};

export function iconForNode(kind: NodeKind, event: NostrEvent): NodeIconMapping {
	if (kind === 'product') return { icon: IconCpu, warn: false };
	for (const value of tagValues(event, 'i')) {
		const prefix = value.split(':', 1)[0];
		const icon = BY_I_PREFIX[prefix];
		if (icon !== undefined) return { icon, warn: prefix === 'cve' };
	}
	return { icon: IconFile, warn: false };
}
