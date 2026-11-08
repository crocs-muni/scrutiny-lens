import { describe, expect, it } from 'vitest';
import { isTruncated } from '../src/lib/truncation';

describe('isTruncated', () => {
	it('treats only width beyond the one-pixel guard as clipped', () => {
		expect(isTruncated({ scrollWidth: 122, clientWidth: 120 } as HTMLElement)).toBe(true);
		expect(isTruncated({ scrollWidth: 121, clientWidth: 120 } as HTMLElement)).toBe(false);
		expect(isTruncated({ scrollWidth: 120, clientWidth: 120 } as HTMLElement)).toBe(false);
	});
});
