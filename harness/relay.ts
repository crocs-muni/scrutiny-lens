// A relay as a pure function of (stored events, frame in) -> frames out, with
// no sockets. The capture layer plugs it into Playwright's routeWebSocket, so
// the app's real nostr-tools SimplePool talks to it unmodified.
//
// It answers what the app asks (src/lib/net/transport.ts): NIP-01 REQ/CLOSE
// with tag filters, NIP-45 COUNT, optional NIP-50 `search`, and the NIP-11
// info document. Chaos knobs make the spec §4 relay states reachable on
// purpose instead of by racing.

import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/core';

export interface RelayChaos {
	/** Delay every reply frame by this many ms. */
	latencyMs?: number;
	/** Never serve events of these kinds (a relay that omits kind-5 deletions). */
	omitKinds?: readonly number[];
	/** Advertise no NIP-50 and ignore `search`, like a relay that lacks it. */
	lacksNip50?: boolean;
	/** Clamp every filter's `limit` to this many events (a truncating relay). */
	capLimit?: number;
	/** Serve these event ids with a corrupted id, so the app's NIP-01 id
	 * recompute rejects them ("N invalid skipped", spec §4). */
	corruptIds?: readonly string[];
}

export interface RelayOptions {
	name: string;
	events: readonly NostrEvent[];
	chaos?: RelayChaos;
}

export type Send = (frame: string) => void;

function corrupt(event: NostrEvent): NostrEvent {
	const flipped = (event.id[0] === '0' ? '1' : '0') + event.id.slice(1);
	return { ...event, id: flipped };
}

export class FakeRelay {
	readonly name: string;
	private readonly events: readonly NostrEvent[];
	private readonly chaos: RelayChaos;
	/** Frames received from the page, for scenes that assert on traffic. */
	readonly received: string[] = [];

	constructor(options: RelayOptions) {
		this.name = options.name;
		this.events = options.events;
		this.chaos = options.chaos ?? {};
	}

	/** The NIP-11 document the transport's capability probe reads. */
	infoDocument(): { name: string; supported_nips: number[] } {
		return {
			name: this.name,
			supported_nips: this.chaos.lacksNip50 ? [1, 11, 45] : [1, 11, 45, 50]
		};
	}

	private select(filter: Filter): NostrEvent[] {
		const search = this.chaos.lacksNip50 ? undefined : filter.search?.toLowerCase();
		const omitted = new Set(this.chaos.omitKinds ?? []);
		const structural: Filter = { ...filter, search: undefined };
		let matched = this.events
			.filter((event) => !omitted.has(event.kind))
			.filter((event) => matchFilter(structural, event))
			.filter(
				(event) =>
					search === undefined ||
					`${event.content}\n${event.tags.map((t) => t.join(' ')).join('\n')}`
						.toLowerCase()
						.includes(search)
			)
			.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
		const limit = Math.min(filter.limit ?? Infinity, this.chaos.capLimit ?? Infinity);
		if (Number.isFinite(limit)) matched = matched.slice(0, limit);
		return matched;
	}

	private reply(send: Send, frames: string[]): void {
		const delay = this.chaos.latencyMs ?? 0;
		if (delay <= 0) {
			for (const frame of frames) send(frame);
			return;
		}
		setTimeout(() => {
			for (const frame of frames) send(frame);
		}, delay);
	}

	/** Handle one client frame; replies go out through `send`. */
	handle(raw: string, send: Send): void {
		this.received.push(raw);
		let frame: unknown;
		try {
			frame = JSON.parse(raw);
		} catch {
			this.reply(send, [JSON.stringify(['NOTICE', 'invalid: unparseable frame'])]);
			return;
		}
		if (!Array.isArray(frame)) return;
		const [verb, id, ...filters] = frame as [string, string, ...Filter[]];
		const corruptIds = new Set(this.chaos.corruptIds ?? []);
		if (verb === 'REQ') {
			const seen = new Set<string>();
			const out: string[] = [];
			for (const filter of filters) {
				for (const event of this.select(filter)) {
					if (seen.has(event.id)) continue;
					seen.add(event.id);
					out.push(
						JSON.stringify(['EVENT', id, corruptIds.has(event.id) ? corrupt(event) : event])
					);
				}
			}
			out.push(JSON.stringify(['EOSE', id]));
			this.reply(send, out);
		} else if (verb === 'COUNT') {
			const ids = new Set<string>();
			for (const filter of filters) for (const event of this.select(filter)) ids.add(event.id);
			this.reply(send, [JSON.stringify(['COUNT', id, { count: ids.size }])]);
		} else if (verb === 'EVENT') {
			const event = id as unknown as NostrEvent;
			this.reply(send, [JSON.stringify(['OK', event.id, false, 'blocked: harness relay is read-only'])]);
		}
		// CLOSE needs no reply.
	}
}
