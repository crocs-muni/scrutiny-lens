import { describe, expect, it } from 'vitest';
import { buildTurnMeta, countsLine } from '$lib/chat/turnMeta';
import type { NostrEvent } from '$lib/fabric';
import type { PersistedChatCitation } from '$lib/db';

/* Turn metadata gates (issue #185). Every number here is computed — spec §2
 * rule 5. The point of the suite is that nothing renderable can be a
 * tautology: "N verified" was one, and it shipped. */

const PUB = 'a'.repeat(64);

function ev(id: string, kind: number, tags: string[][], createdAt = 1_700_000_000): NostrEvent {
	return { id, pubkey: PUB, created_at: createdAt, kind, tags, content: `content of ${id}`, sig: 's'.repeat(128) };
}

const cite = (n: number, eventId: string, extra: Partial<PersistedChatCitation> = {}): PersistedChatCitation => ({
	n,
	eventId,
	quote: `quote ${n}`,
	colorIndex: (n - 1) % 6,
	...extra
});

/** A settled message; `content` defaults to one marker per citation so the
 * dropped-claim arithmetic starts at zero. */
function msg(
	citations: PersistedChatCitation[],
	claimsSummary?: { total: number; verbatim: number; partial: number; extrapolatory: number },
	content?: string
) {
	return {
		content: content ?? citations.map((c) => `claim [${c.n}]`).join('. ') + '.',
		citations,
		...(claimsSummary === undefined ? {} : { claimsSummary })
	};
}

describe('buildTurnMeta — record partition', () => {
	it('counts a cited record as current when no honoured deletion targets it', () => {
		const meta = buildTurnMeta(msg([cite(1, 'ev1')]), [ev('ev1', 30023, [])]);
		expect(meta.sources).toEqual([expect.objectContaining({ n: 1, eventId: 'ev1', status: 'current' })]);
		expect(meta.counts).toEqual({ current: 1, retracted: 0, unknown: 0 });
		expect(meta.statusComplete).toBe(true);
	});

	it('marks a cited record retracted only on a same-pubkey kind-5 deletion that e-tags it', () => {
		const target = ev('ev2', 30023, []);
		const deletion = ev('del1', 5, [['e', 'ev2']]);
		const foreign = ev('del2', 5, [['e', 'ev2']]);
		foreign.pubkey = 'b'.repeat(64);

		expect(buildTurnMeta(msg([cite(1, 'ev2')]), [target, deletion]).sources[0].status).toBe('retracted');
		// A deletion by another author is not honoured (NIP-09 authorship).
		expect(buildTurnMeta(msg([cite(1, 'ev2')]), [target, foreign]).sources[0].status).toBe('current');
	});

	it('leaves the status unknown when the cited record is not in memory, and drops the partition', () => {
		const meta = buildTurnMeta(msg([cite(1, 'gone'), cite(2, 'ev2')]), [ev('ev2', 30023, [])]);
		expect(meta.counts).toEqual({ current: 1, retracted: 0, unknown: 1 });
		expect(meta.statusComplete).toBe(false);
		// A partial partition would read as a lie, so only the count prints.
		expect(countsLine(meta)).toBe('2 sources');
	});

	it('dedupes by citation number: two claims on one source are one row', () => {
		const meta = buildTurnMeta(msg([cite(1, 'ev1'), cite(1, 'ev1'), cite(2, 'ev2')]), [
			ev('ev1', 30023, []),
			ev('ev2', 30023, [])
		]);
		expect(meta.sources.map((s) => s.n)).toEqual([1, 2]);
		expect(countsLine(meta)).toBe('2 sources · 2 current');
	});

	it('prefers the verified span over the model quote, and the node title over the fallback', () => {
		const meta = buildTurnMeta(msg([cite(1, 'ev1', { span: 'verbatim span', nodeTitle: 'ANSSI-CC-2024/19' })]), [
			ev('ev1', 30023, [])
		]);
		expect(meta.sources[0].quote).toBe('verbatim span');
		expect(meta.sources[0].title).toBe('ANSSI-CC-2024/19');
	});

	it('falls back to the honest label when a citation carries no title', () => {
		const meta = buildTurnMeta(msg([cite(1, 'ev1')]), [ev('ev1', 30023, [])]);
		expect(meta.sources[0].title).toBe('Cited event');
		expect(meta.sources[0].quote).toBe('quote 1');
	});
});

describe('buildTurnMeta — dropped claims', () => {
	it('counts markers the verifier resolved that produced no marker on screen', () => {
		const meta = buildTurnMeta(
			msg([cite(1, 'ev1')], { total: 3, verbatim: 1, partial: 0, extrapolatory: 2 }, 'Only [1] survived.'),
			[ev('ev1', 30023, [])]
		);
		expect(meta.dropped).toBe(2);
	});

	it('reports zero when every resolved marker is still in the text', () => {
		const meta = buildTurnMeta(
			msg([cite(1, 'ev1'), cite(2, 'ev2')], { total: 2, verbatim: 2, partial: 0, extrapolatory: 0 }),
			[ev('ev1', 30023, []), ev('ev2', 30023, [])]
		);
		expect(meta.dropped).toBe(0);
	});

	it('does not claim a drop when two claims share one source number and both still render', () => {
		// scrubAnswer keys its verified set by citation NUMBER, so an
		// extrapolatory claim that renumbered onto a verified number survives
		// on screen. Saying "1 dropped" would assert a removal that did not
		// happen — the exact lie this surface exists to avoid.
		const meta = buildTurnMeta(
			msg(
				[cite(1, 'ev1')],
				{ total: 2, verbatim: 1, partial: 0, extrapolatory: 1 },
				'First claim [1]. Second claim [1].'
			),
			[ev('ev1', 30023, [])]
		);
		expect(meta.dropped).toBe(0);
	});

	it('reports zero when the turn carried no summary (hydrated, pre-#177 rows)', () => {
		expect(buildTurnMeta(msg([cite(1, 'ev1')], undefined, 'No markers here.'), []).dropped).toBe(0);
	});
});

describe('countsLine', () => {
	it('never says "verified" — a rendered citation is verified by construction', () => {
		const meta = buildTurnMeta(msg([cite(1, 'ev1')]), [ev('ev1', 30023, [])]);
		expect(countsLine(meta)).not.toMatch(/verified/);
	});

	it('singularises one source', () => {
		const meta = buildTurnMeta(msg([cite(1, 'ev1')]), [ev('ev1', 30023, [])]);
		expect(countsLine(meta)).toBe('1 source · 1 current');
	});

	it('omits a zero bucket: three records never print "0 retracted"', () => {
		const meta = buildTurnMeta(msg([cite(1, 'a'), cite(2, 'b')]), [ev('a', 30023, []), ev('b', 30023, [])]);
		expect(countsLine(meta)).toBe('2 sources · 2 current');
	});

	it('prints nothing when the answer cites nothing', () => {
		const meta = buildTurnMeta(msg([], undefined, 'No citations here.'), []);
		expect(countsLine(meta)).toBe('');
	});
});
