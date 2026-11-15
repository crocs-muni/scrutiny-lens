// Dossier drawer scenes (spec §9 DetailDrawer, §2 rule 2 chain states):
// the resolved chain's history, the halted and forked content banners, and a
// retracted subject rendered in full.

import type { Scene } from '../capture.ts';
import { loadFixture } from '../fixtures.ts';
import { CHAINS_TAG } from '../seed/chains.ts';
import { ask, openDossier, waitGraphFrozen } from './common.ts';

const chains = loadFixture('chains');

export function dossierScenes(): Scene[] {
	return [
		{
			// Product A: resolved chain, two applied patches (edited ×2).
			id: 'dossier-a-history',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await openDossier(page, 'Infineon M7794 A12', 'History');
				// The canvas behind the drawer still runs its physics; the shot
				// must wait for the map's own freeze (CanvasToolbar).
				await waitGraphFrozen(page);
			},
			expect: ['#1', '#2', 'applied']
		},
		{
			// Product C: the second patch's base is missing, so the chain halts
			// after the first — Content names the freeze point.
			id: 'dossier-c-halted',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await openDossier(page, 'NXP JCOP4', 'Content');
				await waitGraphFrozen(page);
			},
			expect: ['halted after 1 patch — content frozen at the last good state']
		},
		{
			// Product E: two same-parent branches — content freezes at the
			// shared parent.
			id: 'dossier-e-forked',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await openDossier(page, 'Atmel AT90SC25672RCT', 'Content');
				await waitGraphFrozen(page);
			},
			expect: ['forked — content frozen at the shared parent']
		},
		{
			// Product D was retracted by a kind-5 from its own author: the card
			// and the dossier both state the protocol status, and the dossier
			// renders fully (Show deleted never gates an opened dossier).
			id: 'dossier-retracted',
			relays: [{ host: 'relay-a.test', events: chains }],
			async run({ page, url }) {
				await ask(page, url, CHAINS_TAG);
				await openDossier(page, 'withdrawn release', 'Summary');
				await waitGraphFrozen(page);
			},
			expect: ['retracted', 'cc:HARNESS-RSALIB']
		}
	];
}
