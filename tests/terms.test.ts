// Tooltip wording rules (spec §9 writing rule, #39): sentence case, no trailing period,
// B-kind terms within two lines (about 90 chars). The strings live in one
// module so card, node and dossier cannot drift apart (spec §9).

import { describe, expect, it } from 'vitest';
import { TERM_ARTIFACTS, TERM_BOUND_RECORDS, TERM_PATCHES, recordTypeTerm } from '$lib/terms';

const terms = {
	TERM_BOUND_RECORDS,
	TERM_ARTIFACTS,
	TERM_PATCHES,
	product: recordTypeTerm('product'),
	metadata: recordTypeTerm('metadata')
};

describe('term wording', () => {
	for (const [name, text] of Object.entries(terms)) {
		it(`${name}: sentence case, no trailing period, at most 90 chars`, () => {
			expect(text).toMatch(/^[A-Z]/);
			expect(text).not.toMatch(/[.…]$/);
			expect(text.length).toBeLessThanOrEqual(90);
		});
	}

	it('uses the CONTEXT.md word "Artifacts", not a type list', () => {
		expect(TERM_ARTIFACTS).toMatch(/^Artifacts /);
		expect(TERM_ARTIFACTS).not.toMatch(/pdf|csv/);
	});

	it('the record-type line leads with the type and says every record is an event', () => {
		expect(recordTypeTerm('product')).toMatch(/^Product record: /);
		expect(recordTypeTerm('metadata')).toMatch(/^Metadata record: /);
		expect(recordTypeTerm('product')).toContain('signed Nostr event');
	});
});
