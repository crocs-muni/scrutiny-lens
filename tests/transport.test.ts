import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	createTransport,
	CONNECT_TIMEOUT_MS,
	FETCH_TIMEOUT_MS,
	COUNT_TIMEOUT_MS,
	type PoolLike,
	type RelayLike
} from '$lib/net/transport';
import type { NostrEvent } from 'nostr-tools/core';
import type { Filter } from 'nostr-tools/filter';

type Script =
	| { kind: 'ok'; events?: NostrEvent[]; count?: number }
	| { kind: 'hang-connect' }
	| { kind: 'hang-op'; events?: never; count?: number }// connects fine, but querySync/count never resolve
	| { kind: 'refused' }; // ensureRelay rejects

class FakeRelay implements RelayLike {
	readonly close = vi.fn();
	constructor(
		readonly url: string,
		private readonly script: Script
	) {}

	count(_filters: Filter[], _params?: { id?: string | null }): Promise<number> {
		if (this.script.kind === 'ok') return Promise.resolve(this.script.count ?? 0);
		return new Promise<number>(() => {});
	}
}

class FakePool implements PoolLike {
	readonly relays = new Map<string, FakeRelay>();
	readonly destroy = vi.fn();

	constructor(private readonly scripts: Record<string, Script>) {}

	ensureRelay(url: string): Promise<RelayLike> {
		const script: Script = this.scripts[url] ?? { kind: 'refused' };
		if (script.kind === 'refused') return Promise.reject(new Error(`connection refused by ${url}`));
		if (script.kind === 'hang-connect') return new Promise<RelayLike>(() => {});
		const relay = new FakeRelay(url, script);
		this.relays.set(url, relay);
		return Promise.resolve(relay);
	}

	querySync(urls: string[], _filter: Filter): Promise<NostrEvent[]> {
		const script = this.scripts[urls[0]];
		if (script?.kind === 'ok') return Promise.resolve(script.events ?? []);
		return new Promise<NostrEvent[]>(() => {});
	}
}

function makeEvent(id: string, createdAt = 1_700_000_000): NostrEvent {
	return {
		id,
		pubkey: 'ab'.repeat(32),
		created_at: createdAt,
		kind: 1,
		tags: [],
		content: `event ${id}`,
		sig: 'cd'.repeat(64)
	};
}

describe('relay transport', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('fans out to all relays and dedupes events by id, keeping the first occurrence', async () => {
		const shared = makeEvent('aa'.repeat(32));
		const onlyA = makeEvent('bb'.repeat(32), 1_700_000_001);
		const onlyB = makeEvent('cc'.repeat(32), 1_700_000_002);
		const pool = new FakePool({
			'wss://a': { kind: 'ok', events: [shared, onlyA] },
			'wss://b': { kind: 'ok', events: [shared, onlyB] }
		});
		const transport = createTransport({ urls: ['wss://a', 'wss://b'] }, () => pool);

		const res = await transport.fetch([{ kinds: [1] }]);

		expect(res.events.map((e) => e.id)).toEqual([shared.id, onlyA.id, onlyB.id]);
		expect(res.relays).toEqual([
			{ url: 'wss://a', status: 'ok', count: 2 },
			{ url: 'wss://b', status: 'ok', count: 2 }
		]);
	});

	it('classifies a hanging fetch as timeout without blocking other relays', async () => {
		vi.useFakeTimers();
		const fast = makeEvent('dd'.repeat(32));
		const pool = new FakePool({
			'wss://fast': { kind: 'ok', events: [fast] },
			'wss://slow': { kind: 'hang-op' }
		});
		const transport = createTransport({ urls: ['wss://fast', 'wss://slow'] }, () => pool);

		const pending = transport.fetch([{ kinds: [1] }]);
		await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS + 1);
		const res = await pending;

		expect(res.events.map((e) => e.id)).toEqual([fast.id]);
		expect(res.relays[0]).toMatchObject({ url: 'wss://fast', status: 'ok', count: 1 });
		expect(res.relays[1]).toMatchObject({ url: 'wss://slow', status: 'timeout', count: 0 });
		expect(res.relays[1].lastError).toContain('fetch');
	});

	it('applies the connect timeout when a relay never connects', async () => {
		vi.useFakeTimers();
		const pool = new FakePool({ 'wss://dead': { kind: 'hang-connect' } });
		const transport = createTransport({ urls: ['wss://dead'] }, () => pool);

		const pending = transport.fetch([{}]);
		await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
		const res = await pending;

		expect(res.events).toEqual([]);
		expect(res.relays[0]).toMatchObject({ url: 'wss://dead', status: 'timeout', count: 0 });
		expect(res.relays[0].lastError).toContain('connect');
	});

	it('classifies a refused relay without failing the whole fetch', async () => {
		const ev = makeEvent('ee'.repeat(32));
		const pool = new FakePool({
			'wss://up': { kind: 'ok', events: [ev] },
			'wss://down': { kind: 'refused' }
		});
		const transport = createTransport({ urls: ['wss://up', 'wss://down'] }, () => pool);

		const res = await transport.fetch([{}]);

		expect(res.events.map((e) => e.id)).toEqual([ev.id]);
		expect(res.relays[0]).toMatchObject({ url: 'wss://up', status: 'ok', count: 1 });
		expect(res.relays[1]).toMatchObject({ url: 'wss://down', status: 'refused', count: 0 });
		expect(res.relays[1].lastError).toContain('connection refused');
	});

	it('returns all relays in failure states and no events when every connect fails', async () => {
		const pool = new FakePool({
			'wss://r1': { kind: 'refused' },
			'wss://r2': { kind: 'refused' },
			'wss://r3': { kind: 'refused' }
		});
		const transport = createTransport(
			{ urls: ['wss://r1', 'wss://r2', 'wss://r3'] },
			() => pool
		);

		const res = await transport.fetch([{}]);

		expect(res.events).toEqual([]);
		expect(res.relays.map((r) => r.status)).toEqual(['refused', 'refused', 'refused']);
		expect(res.relays.every((r) => r.count === 0 && r.lastError)).toBe(true);
	});

	it('sums COUNTs across ok relays only', async () => {
		vi.useFakeTimers();
		const pool = new FakePool({
			'wss://a': { kind: 'ok', count: 12 },
			'wss://b': { kind: 'ok', count: 7 },
			'wss://c': { kind: 'refused' },
			'wss://d': { kind: 'hang-op', count: 99 } // count hangs -> timeout, excluded
		});
		const transport = createTransport(
			{ urls: ['wss://a', 'wss://b', 'wss://c', 'wss://d'] },
			() => pool
		);

		const pending = transport.count([{ kinds: [1] }]);
		await vi.advanceTimersByTimeAsync(COUNT_TIMEOUT_MS + 1);
		const res = await pending;

		expect(res.total).toBe(19);
		expect(res.relays.map((r) => r.status)).toEqual(['ok', 'ok', 'refused', 'timeout']);
		expect(res.relays.map((r) => r.count)).toEqual([12, 7, 0, 0]);
	});

	it('close() closes each underlying relay exactly once and destroys the pool', async () => {
		const pool = new FakePool({
			'wss://a': { kind: 'ok', events: [makeEvent('ff'.repeat(32))], count: 1 },
			'wss://b': { kind: 'ok', count: 3 }
		});
		const transport = createTransport({ urls: ['wss://a', 'wss://b'] }, () => pool);
		await transport.fetch([{}]);
		await transport.count([{}]);

		await transport.close();
		await transport.close(); // idempotent

		expect(pool.relays.size).toBe(2);
		for (const relay of pool.relays.values()) {
			expect(relay.close).toHaveBeenCalledTimes(1);
		}
		expect(pool.destroy).toHaveBeenCalledTimes(1);
	});
});
