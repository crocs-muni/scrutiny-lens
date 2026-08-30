import { describe, it, expect } from 'vitest';
import {
	projectSkeleton,
	bestIdentifier,
	composeMetaSegments,
	tagValues
} from '$lib/ai/projector';
import type { NostrEvent } from '$lib/fabric';

function ev(tags: string[][], content = '', id = 'a'.repeat(64)): NostrEvent {
	return { id, sig: 'b'.repeat(128), pubkey: 'c'.repeat(64), created_at: 1, kind: 1, tags, content };
}

describe('projectSkeleton', () => {
	it('builds a deterministic skeleton with title from best identifier', () => {
		const event = ev([
			['identifier', 'BSI-DSZ-CC-0814-2012'],
			['scheme', 'BSI · Germany'],
			['eal', 'EAL4+']
		], 'some product content');
		const s = projectSkeleton(event, { boundMetadata: 5, attachments: 2, updates: 3 });
		expect(s.entityId).toBe(event.id);
		expect(s.title).toBe('BSI-DSZ-CC-0814-2012');
		expect(s.identifiers).toEqual(['BSI-DSZ-CC-0814-2012']);
		expect(s.status).toBe('unknown');
		expect(s.metaSegments).toEqual(['BSI · Germany', 'EAL4+']);
		expect(s.stats).toEqual({ boundMetadata: 5, attachments: 2, updates: 3 });
	});

	it('prefers ccid over an identifier tag for the title', () => {
		const event = ev([
			['identifier', 'secondary-id'],
			['ccid', 'BSI-DSZ-CC-0814-2012']
		]);
		expect(bestIdentifier(event)).toBe('BSI-DSZ-CC-0814-2012');
		expect(projectSkeleton(event, { boundMetadata: 0, attachments: 0, updates: 0 }).title).toBe(
			'BSI-DSZ-CC-0814-2012'
		);
	});

	it('caps identifiers at two and never duplicates the title', () => {
		const event = ev([
			['identifier', 'id-a'],
			['identifier', 'id-b'],
			['identifier', 'id-c'],
			['ccid', 'ccid-x']
		]);
		const s = projectSkeleton(event, { boundMetadata: 0, attachments: 0, updates: 0 });
		expect(s.identifiers).toHaveLength(2);
		expect(s.title).toBe('ccid-x');
		expect(s.identifiers).not.toContain('ccid-x'); // title (non-identifier tag) not duplicated
	});

	it('omits invalid assurance from metaSegments', () => {
		const event = ev([
			['scheme', 'BSI · Germany'],
			['eal', 'not-an-eal'],
			['identifier', 'i1']
		]);
		expect(composeMetaSegments(event)).toEqual(['BSI · Germany']);
	});

	it('metaSegments follow fixed order: scheme then EAL (status unknown → omitted)', () => {
		const event = ev([
			['eal', 'EAL6'],
			['scheme', 'CC Portal']
		]);
		expect(composeMetaSegments(event)).toEqual(['CC Portal', 'EAL6']);
	});

	it('falls back to the content head and then the event id for title', () => {
		const fromContent = projectSkeleton(ev([], 'FirstWord rest of content'), {} as never);
		expect(fromContent.title).toBe('FirstWord');

		const empty = projectSkeleton(ev([], '', 'f'.repeat(64)), {} as never);
		expect(empty.title).toBe('f'.repeat(64));
	});

	it('is pure: does not mutate the input event or stats', () => {
		const event = ev([
			['identifier', 'i1'],
			['scheme', 'S'],
			['eal', 'EAL1']
		], 'c');
		const stats = { boundMetadata: 1, attachments: 2, updates: 3 };
		const tagsBefore = JSON.stringify(event.tags);
		projectSkeleton(event, stats);
		expect(JSON.stringify(event.tags)).toBe(tagsBefore);
		expect(stats).toEqual({ boundMetadata: 1, attachments: 2, updates: 3 });
	});

	it('reads tagValues only from the named key value slots', () => {
		const event = ev([
			['identifier', 'a', 'b'],
			['other', 'c']
		]);
		expect(tagValues(event, 'identifier')).toEqual(['a', 'b']);
	});
});
