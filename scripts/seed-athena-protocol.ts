/**
 * Athena / Minerva multi-actor demo corpus (dev-only).
 *
 * Builds the vendor + analyst events that sit on top of the existing CRoCS
 * mirror: the vendor security target, its post-Minerva patch + notice, the
 * analyst finding with two patches, and the comparison note. The retraction
 * beat uses the corpus's own duplicate ALGSUPPORT retraction (kind-5 by
 * CRoCS), not a seeded false positive. The product, certificate, and
 * JCAlgTest runs are existing relay events; this script only references
 * their ids.
 *
 * Output: .smoke/athena/athena-protocol.ndjson (signed events) + manifest.json.
 * The relay import is offline and bypasses the NIP-42 allowlist/freshness:
 *
 *   docker stop root-relay-1
 *   docker run --rm -v scrutiny-relay-data-20261018:/data \
 *     -v /root/athena-protocol.ndjson:/corpus.ndjson:ro \
 *     -e SCRUTINY_DATA_DIR=/data --entrypoint /relay \
 *     scrutiny-fabric-relay:main-2184194 import -in /corpus.ndjson
 *   docker start root-relay-1
 *
 * Keys: VENDOR_NSEC / ANALYST_NSEC override .smoke/athena/keys.json. The
 * keys file is gitignored; the manifest prints npubs only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { finalizeEvent, generateSecretKey, getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { decode, neventEncode, nsecEncode, npubEncode } from 'nostr-tools/nip19';
import {
	buildBinding,
	buildMetadata,
	buildPatch,
	hasError,
	type BuildResult,
	type UnsignedEvent
} from '@scrutiny-fabric/core';

const DIR = '.smoke/athena';
const KEYS_FILE = `${DIR}/keys.json`;
const NDJSON = `${DIR}/athena-protocol.ndjson`;
const MANIFEST = `${DIR}/manifest.json`;
const RELAY = 'wss://relay.scrutiny.cloud';

/* Existing CRoCS mirror events (the corpus this demo builds on). */
const PRODUCT = 'eb978dea1e00c0bffa5ecd8c83c4ec4e65e3f496a37a32d161f01ab2ec53e7a3';
/** Duplicate ALGSUPPORT run the mirror retracted (the real retraction beat). */
const RETRACTED_RUN = 'c786fcc5e58209feadd28733ae164a2c42e940ed4383556191f8edf1125e4ab5';
const CROCS = 'c0df886f934aad0c1e62f08b04bd54b44bdd1b5cb0b2ab250cbed25cf64c8a27';

const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

interface StoredKey {
	nsec: string;
	npub: string;
}
type StoredKeys = Record<string, StoredKey>;

mkdirSync(DIR, { recursive: true });
const stored: StoredKeys = existsSync(KEYS_FILE)
	? (JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as StoredKeys)
	: {};

function decodeSecret(nsec: string, label: string): Uint8Array {
	const decoded = decode(nsec);
	if (decoded.type !== 'nsec') throw new Error(`${label}: expected an nsec`);
	return decoded.data;
}

function keyFor(role: 'vendor' | 'analyst', envName: string): { sk: Uint8Array; npub: string } {
	const fromEnv = process.env[envName];
	if (fromEnv !== undefined && fromEnv !== '') {
		const sk = decodeSecret(fromEnv, envName);
		return { sk, npub: npubEncode(getPublicKey(sk)) };
	}
	const existing = stored[role];
	if (existing !== undefined) {
		const sk = decodeSecret(existing.nsec, role);
		return { sk, npub: existing.npub };
	}
	const sk = generateSecretKey();
	const npub = npubEncode(getPublicKey(sk));
	stored[role] = { nsec: nsecEncode(sk), npub };
	writeFileSync(KEYS_FILE, `${JSON.stringify(stored, null, 2)}\n`);
	return { sk, npub };
}

const vendor = keyFor('vendor', 'VENDOR_NSEC');
const analyst = keyFor('analyst', 'ANALYST_NSEC');

/* ------------------------------------------------------------------ *
 * Signing + builders
 * ------------------------------------------------------------------ */

function sign(template: UnsignedEvent, sk: Uint8Array) {
	return finalizeEvent(
		{
			kind: template.kind,
			created_at: template.created_at,
			tags: template.tags.map((tag) => [...tag]),
			content: template.content
		},
		sk
	);
}

function check(built: BuildResult, label: string): UnsignedEvent {
	for (const issue of built.issues) {
		console.warn(`[${label}] ${issue.severity} ${issue.code}: ${issue.message}`);
	}
	if (hasError(built.issues)) throw new Error(`${label}: builder returned an error issue`);
	return built.template;
}

function meta(
	label: string,
	content: string,
	createdAt: number,
	indexers: string[],
	extraTags: string[][],
	sk: Uint8Array
) {
	const template = check(buildMetadata(content, createdAt, indexers), label);
	return sign({ ...template, tags: [...template.tags, ...extraTags] }, sk);
}

function bind(
	label: string,
	rootId: string,
	linkId: string,
	verb: string,
	createdAt: number,
	sk: Uint8Array
) {
	const template = check(buildBinding({ id: rootId }, { id: linkId }, verb, createdAt), label);
	return sign(template, sk);
}

function patch(
	label: string,
	rootId: string,
	replyId: string,
	before: string,
	after: string,
	createdAt: number,
	sk: Uint8Array
) {
	const template = check(
		buildPatch({
			root: { id: rootId },
			reply: { id: replyId },
			before,
			after,
			createdAt
		}),
		label
	);
	return sign(template, sk);
}

function profile(name: string, about: string, createdAt: number, sk: Uint8Array) {
	return finalizeEvent(
		{ kind: 0, created_at: createdAt, tags: [], content: JSON.stringify({ name, about }) },
		sk
	);
}

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

const ST_URL =
	'https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/ANSSI-CC-cible_2012-23en.pdf';
const ST_SHA = 'b385e0758cbe861420547ab397eade4e0f00f995b21db7dcf546d0e0453ae130';
const ST_SIZE = 1_295_370;
const CERT_URL =
	'https://www.commoncriteriaportal.org/nfs/ccpfiles/files/epfiles/ANSSI-CC_2012-23fr.pdf';
const CERT_SHA = '440c4add452876a15632eb0cec6ad48cd28453087065fa4f5c384ec796076ba9';
const CERT_SIZE = 223_934;

const VENDOR_ST_V1 = `Athena OS755/IDProtect v6 — Security Target v1.2 (2012-03-22).

Vendor claims for the card in this demo:
- Java Card 2.2.2 and GlobalPlatform 2.1.1 compliant operating system.
- SSCD types 2 and 3 (Directive 1999/93/EC); RSA up to 2048 bits.
- TOE: Athena IDProtect/OS755 v6 Java Card on Inside Secure AT90SC28872RCU, with the Athena IAS-ECC applet.
- Assurance: EAL4+ with AVA_VAN.5 under ANSSI-CC-2012/23.

Source: ANSSI-CC-cible_2012-23en.pdf (Athena Smartcard / Inside Secure).
`;

const SECURITY_NOTICE = `Security notice (2019-10): CVE-2019-15809 (Minerva) affects the fast ECDSA path in the AT90SC Toolbox 00.03.11.05. No firmware update is available for deployed AT90SC cards; replacement is recommended. Newer products use updated hardware and libraries.`;

const VENDOR_ST_V2 = `${VENDOR_ST_V1}\n${SECURITY_NOTICE}\n`;

const VENDOR_NOTICE = `Vendor security notice — CVE-2019-15809 (Minerva).

The legacy Athena IDProtect on AT90SC (Atmel Toolbox 00.03.11.05) is affected by the fast-ECDSA timing side channel. No firmware update is available for deployed AT90SC cards; replacement is recommended. Newer products use updated hardware and cryptographic libraries.

This is a demo vendor record; the public NXP/Minerva statement is the source.
`;

const FINDING_V1 = `CVE-2019-15809 — Minerva finding note (2019-10-03).

The AT90SC Toolbox 00.03.11.05 fast ECDSA path leaks nonce bit-length through timing. About 2100 signatures are enough to recover a secp256r1 private key in about 30 minutes on a laptop.

The measured card ATR 3bd518ff8191fe1fc38073c8211309 matches the Minerva-tested Athena IDProtect (CPLC 010b.0352.0005).

Source: https://minerva.crocs.fi.muni.cz/
`;

const FINDING_V2 = `${FINDING_V1}
Timeline: ANSSI-CC-2012/23 expired 2019-09-01; CVE-2019-15809 was published 2019-10-03.
`;

const FINDING_V3 = `${FINDING_V2}
Scope: the certificate/ST describes an RSA SSCD (Java Card 2.2.2, GP 2.1.1, RSA up to 2048, EAL4+); the measured card also supports ECDSA/AES/3DES/ECDH/SHA-2. The certification did not require side-channel testing of the fast ECDSA path.
`;

function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length))
	);
	const line = (cells: string[]): string =>
		cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
	const divider = widths.map((width) => '─'.repeat(width)).join('  ');
	return [line(headers), divider, ...rows.map(line)].join('\n');
}

const COMPARISON = `Athena IDProtect ICFabDate 2015 — claims vs measurements (2019-10-06).

${table(
	['CLAIM (source)', 'OBSERVED (JCAlgTest)', 'VERDICT'],
	[
		['Java Card 2.2.2 (vendor ST v1.2)', 'Java Card 2.2.2', 'match'],
		['GlobalPlatform 2.1.1 (vendor ST v1.2)', 'not measured', 'not observed'],
		['RSA up to 2048 (vendor ST v1.2)', 'RSA supported (API)', 'match; key size not measured'],
		['ECDSA (not in vendor ST)', 'ECDSA supported', 'extra measured'],
		['AES (not in vendor ST)', 'AES supported', 'extra measured'],
		['3DES / ECDH / SHA-2 (cert tags)', '3DES / ECDH / SHA-2 supported', 'match'],
		['SHA-3 (cert tags)', 'not observed in any run', 'not observed'],
		['EAL4+ AVA_VAN.5 (cert)', 'no side-channel test', 'scope gap'],
		['CVE-2019-15809 (Minerva project)', 'ATR 3bd518ff... matches', 'affected']
	]
)}

Sources: vendor ST v1.2; ANSSI-CC-2012/23; JCAlgTest ALGSUPPORT 2019-04-19; Minerva project.
`;

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

const events: VerifiedEvent[] = [];
const labels = new Map<string, string>();
function add(label: string, event: VerifiedEvent) {
	events.push(event);
	labels.set(event.id, label);
	return event;
}

add('vendor profile', profile(
	'Athena SCS (demo)',
	'Demo publisher for the Athena OS755/IDProtect vendor claims. Not the real vendor.',
	at('2012-03-21T00:00:00Z'),
	vendor.sk
));

add('analyst profile', profile(
	'Independent analyst (demo)',
	'Demo analyst for the Athena IDProtect / Minerva evidence. Not the card vendor or certifier.',
	at('2019-10-01T00:00:00Z'),
	analyst.sk
));

const vendorSt = add('vendor security target v1.2', meta(
	'vendor security target',
	VENDOR_ST_V1,
	at('2012-03-22T00:00:00Z'),
	[
		'cc:ANSSI-CC-2012/23',
		'scheme:fr',
		'vendor:athena-smartcard-solutions-inc-inside-secure-s-a',
		'eal:EAL4+'
	],
	[
		['m', 'target'],
		[
			'imeta',
			`url ${ST_URL}`,
			'm application/pdf',
			`size ${ST_SIZE}`,
			`x ${ST_SHA}`,
			'alt Athena OS755/IDProtect v6 Security Target v1.2'
		],
		[
			'imeta',
			`url ${CERT_URL}`,
			'm application/pdf',
			`size ${CERT_SIZE}`,
			`x ${CERT_SHA}`,
			'alt ANSSI-CC-2012/23 certification report'
		]
	],
	vendor.sk
));

const vendorPatch = add('vendor security target patch', patch(
	'vendor security target patch',
	vendorSt.id,
	vendorSt.id,
	VENDOR_ST_V1,
	VENDOR_ST_V2,
	at('2019-10-05T00:00:00Z'),
	vendor.sk
));

const vendorNotice = add('vendor security notice', meta(
	'vendor security notice',
	VENDOR_NOTICE,
	at('2019-10-05T00:00:01Z'),
	['cve:CVE-2019-15809', 'vendor:athena-smartcard-solutions-inc-inside-secure-s-a'],
	[['m', 'advisory']],
	vendor.sk
));

const finding = add('analyst Minerva finding v1', meta(
	'analyst finding v1',
	FINDING_V1,
	at('2019-10-03T00:00:00Z'),
	['cve:CVE-2019-15809', 'cc:ANSSI-CC-2012/23'],
	[
		['m', 'advisory'],
		['imeta', 'url https://minerva.crocs.fi.muni.cz/', 'm text/html', 'alt Minerva project']
	],
	analyst.sk
));

const findingPatch1 = add('analyst finding patch 1', patch(
	'analyst finding patch 1',
	finding.id,
	finding.id,
	FINDING_V1,
	FINDING_V2,
	at('2019-10-04T00:00:00Z'),
	analyst.sk
));

const findingPatch2 = add('analyst finding patch 2', patch(
	'analyst finding patch 2',
	finding.id,
	findingPatch1.id,
	FINDING_V2,
	FINDING_V3,
	at('2019-10-05T00:00:02Z'),
	analyst.sk
));

const comparison = add('analyst comparison note', meta(
	'analyst comparison note',
	COMPARISON,
	at('2019-10-06T00:00:00Z'),
	['cve:CVE-2019-15809', 'cc:ANSSI-CC-2012/23'],
	[['m', 'report']],
	analyst.sk
));

add('binding vendor ST', bind(
	'binding vendor ST',
	PRODUCT,
	vendorSt.id,
	'documents',
	at('2012-03-22T00:00:01Z'),
	vendor.sk
));
add('binding vendor notice', bind(
	'binding vendor notice',
	PRODUCT,
	vendorNotice.id,
	'notifies',
	at('2019-10-05T00:00:02Z'),
	vendor.sk
));
add('binding analyst finding', bind(
	'binding analyst finding',
	PRODUCT,
	finding.id,
	'reports on',
	at('2019-10-03T00:00:01Z'),
	analyst.sk
));
add('binding analyst comparison', bind(
	'binding analyst comparison',
	PRODUCT,
	comparison.id,
	'compares',
	at('2019-10-06T00:00:01Z'),
	analyst.sk
));

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

const byId = new Map(events.map((event) => [event.id, event]));
const nevent = (id: string, author: string, kind = 1): string =>
	neventEncode({ id, relays: [RELAY], author, kind });

const manifest = {
	generatedAt: new Date().toISOString(),
	relayHint: RELAY,
	product: PRODUCT,
	keys: { vendor: vendor.npub, analyst: analyst.npub },
	events: events.map((event) => ({
		id: event.id,
		kind: event.kind,
		author: event.pubkey,
		createdAt: event.created_at,
		label: labels.get(event.id) ?? ''
	})),
	nevents: {
		product: nevent(PRODUCT, CROCS),
		vendorSt: nevent(vendorSt.id, vendorSt.pubkey),
		vendorNotice: nevent(vendorNotice.id, vendorNotice.pubkey),
		finding: nevent(finding.id, finding.pubkey),
		comparison: nevent(comparison.id, comparison.pubkey),
		retraction: nevent(RETRACTED_RUN, CROCS)
	},
	ndjson: NDJSON
};

writeFileSync(NDJSON, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

const known = [vendorSt.id, vendorPatch.id, finding.id, findingPatch1.id, findingPatch2.id];
for (const id of known) {
	if (!byId.has(id)) throw new Error(`missing event ${id}`);
}

console.log(`vendor npub:  ${vendor.npub}`);
console.log(`analyst npub: ${analyst.npub}`);
console.log(`wrote ${events.length} events to ${NDJSON}`);
console.log(`manifest: ${MANIFEST}`);
console.log(`product nevent: ${manifest.nevents.product}`);
console.log(`import: docker run --rm -v scrutiny-relay-data-20261018:/data -v ${NDJSON}:/corpus.ndjson:ro -e SCRUTINY_DATA_DIR=/data --entrypoint /relay scrutiny-fabric-relay:main-2184194 import -in /corpus.ndjson`);
