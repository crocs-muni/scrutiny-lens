import type { NostrEvent } from './types.js';
import demo from '../../../fixtures/demo-graph.json' with { type: 'json' };

export async function fetchSessionEvents(_id: string): Promise<NostrEvent[]> {
	// MVP fallback: return the synthetic demo graph for any session.
	// In production this would query configured relays and merge kind:5 retractions client-side.
	return demo.events as NostrEvent[];
}
