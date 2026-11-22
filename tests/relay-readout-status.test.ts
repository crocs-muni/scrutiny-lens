import { describe, expect, it } from 'vitest';
import { parseRelayReceiptStatus } from '$lib/relay-readout';

// Issue #212: the IndexedDB restore boundary parses the receipt status; a
// drifted string must not reach RANK[] or the degraded banner.
describe('parseRelayReceiptStatus', () => {
	it.each(['ok', 'timeout', 'refused', 'unasked'] as const)('keeps %s', (value) => {
		expect(parseRelayReceiptStatus(value)).toBe(value);
	});

	it.each(['error', 'OK', '', ' ok', 'unknown'])('drops %j', (value) => {
		expect(parseRelayReceiptStatus(value)).toBeNull();
	});
});
