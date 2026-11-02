// Term tooltips (heuristic R4.H, R5.W, R7.L, R11.H, R14.W): count icons and
// the drawer header explain themselves on hover. Source-level pins, like
// relay-conformance.test.ts — the repo has no component-render harness.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPONENTS = join(__dirname, '..', 'src/lib/components');
const read = (rel: string) => readFileSync(join(COMPONENTS, rel), 'utf8');

describe('term tooltips', () => {
	it('ResultCard count titles match the GraphNode footer wording (spec §9: one icon pair)', () => {
		const card = read('ui/ResultCard.svelte');
		const node = read('graph/GraphNode.svelte');
		for (const wording of [
			'bound records (metadata)',
			'artifacts (pdf/csv/…) named by this record or its bound records'
		]) {
			expect(card, `ResultCard lost "${wording}"`).toContain(`title="${wording}"`);
			expect(node, `GraphNode lost "${wording}"`).toContain(`title="${wording}"`);
		}
	});

	it('ResultCard explains the updates count as patches', () => {
		expect(read('ui/ResultCard.svelte')).toContain(
			`title="patches: edits to this record's content"`
		);
	});

	it('the DetailDrawer header says every record is an event', () => {
		expect(read('shell/DetailDrawer.svelte')).toContain(
			'in SCRUTINY every record (product, metadata, binding, patch) is an event'
		);
	});
});
