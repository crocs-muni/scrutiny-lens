import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NostrEvent } from 'nostr-tools/core';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixturePath(name: string): string {
	return join(DIR, `${name}.ndjson`);
}

export function loadFixture(name: string): NostrEvent[] {
	return readFileSync(fixturePath(name), 'utf8')
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line) as NostrEvent);
}
