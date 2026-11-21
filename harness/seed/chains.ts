// Deterministic fixture: one ego graph covering the patch-chain states and a
// retraction. Mirrors scripts/seed-lens29.ts but with a fixed key and a fixed
// epoch, so event ids (a hash of pubkey, created_at, tags, content) never
// change between runs. Signatures do vary (BIP-340 uses random aux) but ids,
// not signatures, are what the UI shows.
//
// Run: node harness/cli.ts seed

import { hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/core';
import {
	buildBinding,
	buildMetadata,
	buildPatch,
	buildProduct,
	type UnsignedEvent
} from '@scrutiny-fabric/core';
import { T0 } from '../time.ts';

// A test key, not a secret: it only signs fixtures that live in this repo.
const SECRET = hexToBytes('9f3a6c1e5b7d2a48c0e1f4b8d6a2793c5e0b1d4f7a8c3e6921b5d0f4a7c8e3b1');
export const FIXTURE_PUBKEY = getPublicKey(SECRET);

/** Every event carries this i-tag, so a single identifier question admits the set. */
export const CHAINS_TAG = 'cc:HARNESS-CHAINS';

const DAY = 86_400;

function sign(template: UnsignedEvent): NostrEvent {
	return finalizeEvent(
		{
			kind: template.kind,
			created_at: template.created_at,
			tags: template.tags as string[][],
			content: template.content
		},
		SECRET
	) as NostrEvent;
}

export function buildChains(): NostrEvent[] {
	const at = (daysAgo: number): number => T0 - daysAgo * DAY;

	const A_V1 = 'Infineon M7794 A12 smartcard — RSA keygen via vulnerable library.\n';
	const A_V2 = 'Infineon M7794 A12 / A22 smartcard — RSA keygen via vulnerable library.\n';
	const A_V3 = `${A_V2}Certificate maintained — validity extended to 2027.\n`;

	const pA = sign(buildProduct(A_V1, at(14), [CHAINS_TAG, 'cve:CVE-2017-15361']).template);
	const m1 = sign(
		buildMetadata(
			'CVE-2017-15361 advisory — RSA key generation is performed by a certified third-party library, which is affected by the ROCA key-generation flaw. https://x.test/roca.pdf',
			at(13),
			['cve:CVE-2017-15361', CHAINS_TAG]
		).template
	);
	const m3 = sign(
		buildMetadata(
			'Security Target — Common Criteria evaluation evidence for the M7794 family.',
			at(12),
			['cert:BSI-DSZ-CC-0814-2012', CHAINS_TAG]
		).template
	);
	const pC = sign(
		buildProduct('NXP JCOP4 SmartMX3 — JavaCard platform.\n', at(11), [
			'cc:HARNESS-JCOP4',
			CHAINS_TAG,
			'cve:CVE-2017-15361'
		]).template
	);
	const m4 = sign(
		buildMetadata('JCOP4 maintenance report — third-party algorithm-support measurement.', at(10), [
			'cert:JC-MAINT-9931',
			CHAINS_TAG
		]).template
	);
	const pE = sign(
		buildProduct('Atmel AT90SC25672RCT — secure microcontroller.\n', at(9), [CHAINS_TAG]).template
	);
	const pD = sign(
		buildProduct('Infineon RSA Library 1.02.013 — withdrawn release.\n', at(60), [
			'cc:HARNESS-RSALIB',
			CHAINS_TAG
		]).template
	);

	const bindings = [
		sign(buildBinding({ id: pA.id }, { id: m1.id }, 'affected by', at(12)).template),
		sign(buildBinding({ id: pA.id }, { id: m3.id }, 'documents', at(12)).template),
		sign(buildBinding({ id: pC.id }, { id: m1.id }, 'affects', at(11)).template),
		sign(buildBinding({ id: pC.id }, { id: m4.id }, 'documents', at(9)).template),
		sign(buildBinding({ id: pD.id }, { id: m1.id }, 'affected by', at(55)).template),
		sign(buildBinding({ id: pE.id }, { id: m1.id }, 'affects', at(8)).template)
	];

	// Resolved chain: two clean patches.
	const pa1 = sign(
		buildPatch({
			root: { id: pA.id },
			reply: { id: pA.id },
			before: A_V1,
			after: A_V2,
			createdAt: at(8)
		}).template
	);
	const pa2 = sign(
		buildPatch({
			root: { id: pA.id },
			reply: { id: pa1.id },
			before: A_V2,
			after: A_V3,
			createdAt: at(7)
		}).template
	);

	// Halted chain: q2's diff is built against a base the chain never contained.
	const C_V1 = pC.content;
	const C_V2 = 'NXP JCOP4 SmartMX3 (P60 rev. D4) — JavaCard platform.\n';
	const q1 = sign(
		buildPatch({
			root: { id: pC.id },
			reply: { id: pC.id },
			before: C_V1,
			after: C_V2,
			createdAt: at(6)
		}).template
	);
	const q2 = sign(
		buildPatch({
			root: { id: pC.id },
			reply: { id: q1.id },
			before: 'a base the chain never contained\n',
			after: 'NXP JCOP4 SmartMX3 (P60 rev. D5)\n',
			createdAt: at(5)
		}).template
	);

	// Forked chain: two same-parent branches.
	const E_V1 = pE.content;
	const f1 = sign(
		buildPatch({
			root: { id: pE.id },
			reply: { id: pE.id },
			before: E_V1,
			after: 'Atmel AT90SC25672RCT (rev C)\n',
			createdAt: at(4)
		}).template
	);
	const f2 = sign(
		buildPatch({
			root: { id: pE.id },
			reply: { id: pE.id },
			before: E_V1,
			after: 'Atmel AT90SC25672RCT — 72 kB EEPROM variant\n',
			createdAt: at(3)
		}).template
	);

	// Honoured retraction: same author, e-tag (DEL-1).
	const del = finalizeEvent(
		{ kind: 5, created_at: at(2), tags: [['e', pD.id]], content: '' },
		SECRET
	) as NostrEvent;

	const profile = finalizeEvent(
		{
			kind: 0,
			created_at: at(14),
			tags: [],
			content: JSON.stringify({
				name: 'sec-certs index',
				about: 'Common Criteria corpus publisher (fixture)'
			})
		},
		SECRET
	) as NostrEvent;

	return [pA, m1, m3, pC, m4, pE, pD, ...bindings, pa1, pa2, q1, q2, f1, f2, del, profile];
}

/** A product whose one patch has 65 hunks: the resolver's default ceiling is
 * 64, so the chain aborts before applying. Kept out of `buildChains` so the
 * extra product does not move every other scene's result set. */
export function buildAbortedChain(): NostrEvent[] {
	const before =
		[
			'Product G — aborted chain',
			...Array.from(
				{ length: 65 },
				(_, i) =>
					`block ${i} line a\nblock ${i} line b\nblock ${i} line c\nblock ${i} line d\nblock ${i} line e\nblock ${i} line f\nblock ${i} line g\nblock ${i} line h`
			)
		].join('\n') + '\n';
	const after = before.replace(/line d/g, 'line D');
	const product = sign(buildProduct(before, T0 - 6 * DAY, [CHAINS_TAG]).template);
	const patch = sign(
		buildPatch({
			root: { id: product.id },
			reply: { id: product.id },
			before,
			after,
			createdAt: T0 - 5 * DAY
		}).template
	);
	return [product, patch];
}
