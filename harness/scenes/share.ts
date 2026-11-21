// Share-link edge state (spec §4 "Shared link → relays dead", spec §1 L22).
//
// The link is built exactly the way the app builds it (deep-link.ts's
// buildShareLinks): a NIP-19 nevent carrying the root id, its seen-on relay
// hints (≤3), author and kind, mounted at `/event/<nevent>`. neventEncode is
// called directly only because buildShareLinks reads `location`, which does
// not exist in the capture process; the encoded fields and the route shape
// are its own.
//
// BLOCKER — the §4 row's "Error screen, as above" copy is NOT reachable on
// this route. That row points at ResultsError ("No relay answered", each
// receipt's status such as `refused`, Retry + Edit relay list). The real
// share route (src/routes/event/[nevent]/+page.svelte) renders its own
// not-found frame: "Shared record not found", the failed-hint message, every
// failed hint relay labelled "failed", Try again + Go to overview (relay-list
// editing is prose pointing at Settings). `No relay answered` and the
// `refused` status never render here, and this harness slice may not edit
// app source — so `expect` holds the real copy instead of shipping a red
// scene that fakes a spec pass. Swap these strings to ResultsError's the day
// the route adopts that screen.

import { neventEncode } from 'nostr-tools/nip19';
import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';

const chains = loadFixture('chains');

/** The fixture's Infineon product root (the same card the other scenes
 * open). Product roots carry core's `scrutiny-product` type tag. */
const sharedRoot = chains.find((event) =>
	event.tags.some((tag) => tag[0] === 't' && tag[1] === 'scrutiny-product')
);
if (sharedRoot === undefined) throw new Error('chains fixture has no product root');

/** A real share blob: the sharer observed the root on relay-dead.test, so
 * that refused relay is the link's only hint. */
const SHARE_NEVENT = neventEncode({
	id: sharedRoot.id,
	relays: ['ws://relay-dead.test'],
	author: sharedRoot.pubkey,
	kind: sharedRoot.kind
});

export function shareScenes(): Scene[] {
	return [
		{
			// Every relay the link names (and the only configured relay) dies:
			// the share cold open must land on its error frame, never demo data
			// and never a fake record.
			id: 'share-dead-relays',
			relays: [{ host: 'relay-dead.test', events: [], refuse: true }],
			async run({ page, url }) {
				await page.goto(`${url}/event/${SHARE_NEVENT}`);
				await page.getByRole('heading', { name: 'Shared record not found' }).waitFor();
				// The per-relay label, not the message's prose ("failed to
				// answer"): exact match hits the receipt row's verdict span.
				await page.getByText('failed', { exact: true }).waitFor();
			},
			expect: [
				'Shared record not found',
				'the record was not found — these hinted relays failed to answer',
				'ws://relay-dead.test',
				'failed',
				'Try again'
			]
		}
	];
}
