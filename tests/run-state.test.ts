import { describe, expect, it } from 'vitest';
import { deriveRunState } from '$lib/run-state';
import type { RunStateInput } from '$lib/run-state';

// Helper to create minimal input
function baseInput(): RunStateInput {
    return {
        phase: 'idle',
        running: false,
        result: null,
        error: null,
        searches: [],
        skeletons: [],
        slices: [],
        restoredEvicted: null,
        fillStats: { interpreted: 0, total: 0 },
        fillFailure: null,
        fillErrorMessage: null,
        rateLimitedCount: 0,
        failed: new Set(),
        viewCards: [],
        notices: [],
        hasShareHints: false,
        shareHints: [],
        apiKey: '',
        filling: false,
    };
}

// Helper to create one relay leg slice
function slice(url: string, status: 'ok' | 'timeout' | 'refused') {
    return { url, received: 0, route: 'search', rejected: 0, status };
}

describe('deriveRunState – §4 edge states', () => {
    it('noTerms when settled with zero searches', () => {
        const input = baseInput();
        input.result = {};
        const state = deriveRunState(input);
        expect(state.noTerms).toBe(true);
    });

    it('emptyDone when settled with searches or noTerms and no cards', () => {
        const input = baseInput();
        input.result = {};
        input.searches = [
            { kind: 'text', value: 'roca', source: 'fallback' },
            { kind: 'tag', value: 'p:roca', source: 'ai' },
        ];
        const state = deriveRunState(input);
        expect(state.emptyDone).toBe(true);
    });

    it('stageWait during translate or fetch while running', () => {
        const input = baseInput();
        input.phase = 'translate';
        input.running = true;
        const state = deriveRunState(input);
        expect(state.stageWait).toBe(true);
    });

    it('relayDead when error and no ok relay', () => {
        const input = baseInput();
        input.error = 'boom';
        input.slices = [slice('wss://dead.example', 'refused')];
        const state = deriveRunState(input);
        expect(state.relayDead).toBe(true);
    });

    it('degradedNote and degradedRelays when some relays not ok', () => {
        const input = baseInput();
        input.slices = [slice('wss://ok.example', 'ok'), slice('wss://dead.example', 'refused')];
        const state = deriveRunState(input);
        expect(state.degradedNote).toContain('relay');
        expect(state.degradedRelays.length).toBe(1);
    });

    it('footerNotes include restored and evicted info', () => {
        const input = baseInput();
        input.restoredEvicted = 3;
        const state = deriveRunState(input);
        expect(state.footerNotes).toContain('restored from local storage');
        expect(state.footerNotes).toContain('3 evicted from local storage');
    });

    it('capability and traversal notes roll‑up', () => {
        const input = baseInput();
        input.notices = [
            { kind: 'capability', message: 'no search' },
            { kind: 'traversal', message: 'warn' },
        ];
        const state = deriveRunState(input);
        expect(state.capabilityNote).toBe('no search');
        expect(state.traversalNote).toBe('warn');
    });

    it('shareNote when hints present', () => {
        const input = baseInput();
        input.hasShareHints = true;
        input.shareHints = ['relay1'];
        const state = deriveRunState(input);
        expect(state.shareNote).toContain('hinted relay relay1 failed');
    });

    it('fillSettleNote and aiNote for fill failures', () => {
        const input = baseInput();
        input.result = {};
        input.fillStats = { interpreted: 0, total: 5 };
        input.fillFailure = 'schema_failure';
        input.fillErrorMessage = 'bad';
        input.rateLimitedCount = 0;
        input.failed = new Set(['x']);
        const state = deriveRunState(input);
        expect(state.fillSettleNote).toContain('Output didn\'t conform');
        expect(state.aiNote).toBe(state.fillSettleNote);
    });

    it('partial fill keeps the numeric slow sentence, not the failure verdict', () => {
        const input = baseInput();
        input.result = {};
        input.fillStats = { interpreted: 2, total: 5 };
        input.fillFailure = 'schema_failure';
        input.failed = new Set(['x']);
        const state = deriveRunState(input);
        expect(state.fillSettleNote).toContain('2 of 5 cards filled');
        expect(state.aiNote).toBe(state.fillSettleNote);
    });

    it('noKey when API key empty and result present', () => {
        const input = baseInput();
        input.apiKey = '';
        input.result = {};
        const state = deriveRunState(input);
        expect(state.noKey).toBe(true);
    });
});
