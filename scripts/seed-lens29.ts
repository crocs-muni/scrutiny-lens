/**
 * #29b verification fixture seeder (dev-only).
 *
 * Publishes one self-contained ego-graph scenario to the local scrutiny
 * relay (`docker run -d -p 8080:8080 scrutiny-relay-demo:latest`), all under
 * ONE fresh key per run (author-matched kind-5, DEL-1). Search the app for
 * `cc:LENS29-ROCA` — every fixture event carries that i-tag, so the
 * deterministic identifier route admits the set; the settle traversal then
 * pulls bindings, and dossier opens pull chains/deletions (#68 flow).
 *
 * What the fixture exercises on the canvas (in-app, after the search):
 *
 *   hub A "Infineon M7794"      — 2 applied patches  → `edited ×2`
 *   advise M1 (CVE, http link)  — warn icon + files=1; bridges A, C, D
 *   shadow hub C "NXP JCOP4"    — +1 badge (M4 hidden), halted chain (after
 *                                 its dossier opens) → `halted`
 *   forked E "Atmel AT90SC"     — two same-parent patches → `forked`
 *   retracted D                 — kind-5 honoured; hidden until Show deleted
 *
 * Run:  bun run scripts/seed-lens29.ts [ws://127.0.0.1:8080]
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import {
	buildBinding,
	buildMetadata,
	buildPatch,
	buildProduct,
	type UnsignedEvent
} from '@scrutiny-fabric/core';

const RELAY = process.argv[2] ?? 'ws://127.0.0.1:8080';
const TAG = 'cc:LENS29-ROCA';
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const sk = generateSecretKey();
const pk = getPublicKey(sk);

function sign(template: UnsignedEvent) {
	return finalizeEvent(
		{
			kind: template.kind,
			created_at: template.created_at,
			tags: template.tags as string[][],
			content: template.content
		},
		sk
	);
}

const A_CONTENT = 'Infineon M7794 A12 smartcard — RSA keygen via vulnerable library.\n';
const A_V2 = 'Infineon M7794 A12 / A22 smartcard — RSA keygen via vulnerable library.\n';
const A_V3 = A_V2 + 'Certificate maintained — validity extended to 2027.\n';

const pA = sign(buildProduct(A_CONTENT, NOW - 14 * DAY, [TAG, 'cve:CVE-2017-15361']).template);
const m1 = sign(
	buildMetadata(
		'CVE-2017-15361 advisory — RSA key generation is performed by a certified third-party library, which is affected by the ROCA key-generation flaw. https://x.test/roca.pdf',
		NOW - 13 * DAY,
		['cve:CVE-2017-15361', TAG]
	).template
);
const m3 = sign(
	buildMetadata(
		'Security Target — Common Criteria evaluation evidence for the M7794 family.',
		NOW - 12 * DAY,
		['cert:BSI-DSZ-CC-0814-2012', TAG]
	).template
);
const pC = sign(
	buildProduct('NXP JCOP4 SmartMX3 — JavaCard platform.\n', NOW - 11 * DAY, [
		'cc:LENS29-JCOP4',
		TAG,
		'cve:CVE-2017-15361'
	]).template
);
const m4 = sign(
	buildMetadata(
		'JCOP4 maintenance report — third-party algorithm-support measurement.',
		NOW - 10 * DAY,
		['cert:JC-MAINT-9931', TAG]
	).template
);
const pE = sign(
	buildProduct('Atmel AT90SC25672RCT — secure microcontroller.\n', NOW - 9 * DAY, [TAG]).template
);
const pD = sign(
	buildProduct('Infineon RSA Library 1.02.013 — withdrawn release.\n', NOW - 60 * DAY, [
		'cc:LENS29-RSALIB',
		TAG
	]).template
);

const bindings = [
	sign(buildBinding({ id: pA.id }, { id: m1.id }, 'affected by', NOW - 12 * DAY).template),
	sign(buildBinding({ id: pA.id }, { id: m3.id }, 'documents', NOW - 12 * DAY).template),
	sign(buildBinding({ id: pC.id }, { id: m1.id }, 'affects', NOW - 11 * DAY).template),
	sign(buildBinding({ id: pC.id }, { id: m4.id }, 'documents', NOW - 9 * DAY).template),
	sign(buildBinding({ id: pD.id }, { id: m1.id }, 'affected by', NOW - 55 * DAY).template),
	// E joins the ego net behind m1 — a second shadow hub whose fork surfaces
	// (amber `forked`) once its dossier-open traversal admits the branch pair.
	sign(buildBinding({ id: pE.id }, { id: m1.id }, 'affects', NOW - 8 * DAY).template)
];

const pa1 = sign(
	buildPatch({ root: { id: pA.id }, reply: { id: pA.id }, before: A_CONTENT, after: A_V2, createdAt: NOW - 8 * DAY }).template
);
const pa2 = sign(
	buildPatch({ root: { id: pA.id }, reply: { id: pa1.id }, before: A_V2, after: A_V3, createdAt: NOW - 7 * DAY }).template
);

// Halt: q2's diff is built against a base the chain never contains (H1/T1
// no-match against the frozen state left by q1).
const C_V1 = pC.content;
const C_V2 = 'NXP JCOP4 SmartMX3 (P60 rev. D4) — JavaCard platform.\n';
const q1 = sign(
	buildPatch({ root: { id: pC.id }, reply: { id: pC.id }, before: C_V1, after: C_V2, createdAt: NOW - 6 * DAY }).template
);
const q2 = sign(
	buildPatch({
		root: { id: pC.id },
		reply: { id: q1.id },
		before: 'a base the chain never contained\n',
		after: 'NXP JCOP4 SmartMX3 (P60 rev. D5)\n',
		createdAt: NOW - 5 * DAY
	}).template
);

// Fork: two same-parent branches on E.
const E_V1 = pE.content;
const f1 = sign(
	buildPatch({ root: { id: pE.id }, reply: { id: pE.id }, before: E_V1, after: 'Atmel AT90SC25672RCT (rev C)\n', createdAt: NOW - 4 * DAY }).template
);
const f2 = sign(
	buildPatch({ root: { id: pE.id }, reply: { id: pE.id }, before: E_V1, after: 'Atmel AT90SC25672RCT — 72 kB EEPROM variant\n', createdAt: NOW - 3 * DAY }).template
);

// Honoured retraction (DEL-1: same author, e-tag) — store-only relay keeps
// it inert; the client computes the state (resolveGraph/deriveEgo).
const del = finalizeEvent({ kind: 5, created_at: NOW - 2 * DAY, tags: [['e', pD.id]], content: '' }, sk);

const profile = finalizeEvent(
	{
		kind: 0,
		created_at: NOW - 14 * DAY,
		tags: [],
		content: JSON.stringify({ name: 'sec-certs index', about: 'Common Criteria corpus publisher (fixture)' })
	},
	sk
);

const events = [pA, m1, m3, pC, m4, pE, pD, ...bindings, pa1, pa2, q1, q2, f1, f2, del, profile];

console.log(`fixture author npub key: ${pk}`);
console.log(`publishing ${events.length} events to ${RELAY} …`);

const pool = new SimplePool();
try {
	const results = await Promise.allSettled(events.map((e) => pool.publish([RELAY], e)));
	for (const [i, r] of results.entries()) {
		if (r.status === 'rejected') console.log(`  ✗ ${events[i].kind} ${events[i].id.slice(0, 12)}… ${r.reason}`);
	}
	const acked = results.filter((r) => r.status === 'fulfilled').length;
	console.log(`acknowledged ${acked}/${events.length}`);

	// The fixture has exactly 7 i-tagged events (products ×4, metadata ×3);
	// bindings/patches/deletions carry no i tags by design (§8.1 — traversal
	// fetches them). Anything else means a polluted store — a timed-out
	// publish CAN be a stored one; reset the container and reseed ONCE.
	await new Promise((r) => setTimeout(r, 1500)); // let the store flush
	const EXPECTED = 7;
	const back = await pool.querySync([RELAY], { kinds: [1], '#i': [TAG] });
	console.log(`relay now serves ${back.length}/${EXPECTED} kind-1 events for i=${TAG}`);
	if (back.length !== EXPECTED) {
		console.error(
			'✗ polluted or partial store — docker rm -f lens-relay, fresh run, ONE seed pass'
		);
		process.exit(1);
	}
	console.log(`root hub: ${pA.id}`);
	console.log(`search ${TAG} in the app → click the Infineon card`);
} finally {
	// Bun's WebSocket teardown races nostr-tools' close-all — cosmetic only
	// (publishes already acked above), so swallow and exit explicitly.
	try { pool.close([RELAY]); } catch { /* bun teardown race */ }
	process.exit(0);
}
