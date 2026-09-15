/**
 * Node icon vocabulary (#29b, BIBLE N2): deterministic — kind drives the
 * base icon, the metadata event's first i-prefix refines it. Neutral tile
 * everywhere; the stroke tints ONLY for warn-class content (N2: "tinted
 * stroke only when warn"). Mapped by evidence, not guesswork: prefixes not
 * listed fall back to the plain file icon (extend as the corpus's `i`
 * vocabulary grows — never infer from content, spec §2).
 */

import type { Icon } from '@tabler/icons-svelte';
import {
	IconBandage,
	IconBooks,
	IconBug,
	IconBuilding,
	IconCertificate,
	IconCpu,
	IconFile,
	IconFileText,
	IconFingerprint,
	IconHelp,
	IconHexagon,
	IconLock,
	IconRouter,
	IconShield,
	IconStack2,
	IconTarget,
	IconTool,
	IconWorld
} from '@tabler/icons-svelte';
import { tagValues, type NostrEvent } from '$lib/fabric';
import type { NodeKind } from './subject-graph';

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

/** Interpreted icons: the model picks a TOKEN from the card agent's closed
 * IconToken vocabulary; the token→glyph map is ours (spec §2: icons are
 * machine-made — the model never names an icon). Keys not present fall
 * through to the deterministic i-prefix path. */
const BY_TOKEN: Record<string, Icon> = {
	certificate: IconCertificate,
	vulnerability: IconBug,
	report: IconFileText,
	target: IconTarget,
	maintenance: IconTool,
	patch: IconBandage,
	smartcard: IconCpu,
	biometric: IconFingerprint,
	'network-device': IconRouter,
	software: IconStack2,
	hsm: IconLock,
	tpm: IconShield,
	scheme: IconWorld,
	vendor: IconBuilding,
	document: IconFile,
	corpus: IconBooks,
	generic: IconHexagon,
	unknown: IconHelp
};

/** Resolution order: interpretation token (AI-chosen, machine-mapped) → i-prefix
 * heuristics → kind default. The warn tint stays i-prefix-driven — an amber
 * stroke is a deterministic signal, never an AI opinion (N2). */
export function iconForNode(kind: NodeKind, event: NostrEvent, token?: string): NodeIconMapping {
	if (token !== undefined) {
		const icon = BY_TOKEN[token];
		if (icon !== undefined) return { icon, warn: false };
	}
	if (kind === 'product') return { icon: IconCpu, warn: false };
	for (const value of tagValues(event, 'i')) {
		const prefix = value.split(':', 1)[0];
		const icon = BY_I_PREFIX[prefix];
		if (icon !== undefined) return { icon, warn: prefix === 'cve' };
	}
	return { icon: IconFile, warn: false };
}
