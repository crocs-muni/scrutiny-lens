// One pure derivation for the results surface's spec §4 edge states, so the
// page and its tests cannot drift.

import { showsStageWait } from '$lib/trace';
import { aggregatePerRelay, degradedBannerText, type RelayReceipt } from '$lib/relay-readout';
import { fillNote } from '$lib/fill-note';
import type { AIKind } from '$lib/ai/output';
import type { Phase } from '$lib/pipeline';
import type { SearchRequest } from '$lib/ai/agents/query';
import type { SkeletonCard } from '$lib/pipeline';
import type { RelayState } from '$lib/net/transport';
import type { PipelineNotice } from '$lib/pipeline';
import type { ProductCard } from '$lib/pipeline/cards';

export interface RunStateInput {
    phase: Phase | 'idle';
    running: boolean;
    result: unknown | null;
    error: string | null;
    searches: SearchRequest[];
    skeletons: SkeletonCard[];
    slices: {
        url: string;
        received: number;
        route: string;
        rejected: number;
        status: RelayState;
    }[];
    restoredEvicted: number | null;
    fillStats: { interpreted: number; total: number };
    fillFailure: AIKind | null;
    fillErrorMessage: string | null;
    rateLimitedCount: number;
    failed: Set<string>;
    viewCards: ProductCard[];
    notices: PipelineNotice[];
    hasShareHints?: boolean;
    shareHints?: string[];
    apiKey?: string;
    filling?: boolean;
}

export interface RunState {
    noTerms: boolean;
    emptyDone: boolean;
    stageWait: boolean;
    relayDead: boolean;
    degradedNote: string;
    relayReceipts: RelayReceipt[];
    footerNotes: string[];
    capabilityNote: string;
    traversalNote: string;
    shareNote: string;
    fillSettleNote: string;
    aiNote: string;
    noKey: boolean;
}

/** One banner per notice class; per-notice facts stay in the trace ticks. */
function noticeRollup(
    notices: PipelineNotice[],
    kind: PipelineNotice['kind'],
    plural: string
): string {
    const items = notices.filter((n) => n.kind === kind);
    if (items.length === 0) return '';
    if (items.length === 1) return items[0].message;
    return `${items.length} ${plural} — details in the trace`;
}

export function deriveRunState(input: RunStateInput): RunState {
    const {
        phase,
        running,
        result,
        error,
        searches,
        skeletons,
        slices,
        restoredEvicted,
        fillStats,
        fillFailure,
        fillErrorMessage,
        rateLimitedCount,
        failed,
        viewCards,
        notices,
        hasShareHints = false,
        shareHints = [],
        apiKey = '',
        filling = false,
    } = input;

    // #164: zero searches means nothing was asked — "Nothing matched" would be
    // a false claim about the corpus (spec §2).
    const noTerms = result !== null && error === null && running === false && searches.length === 0;

    // #82: zero-results is a SETTLED fact, never an in-flight guess — the
    // settle traversal runs while `running` and can turn 0 cards into N.
    // Spec §4 conflation: a restored session with evicted products is data
    // loss, not a zero-result search.
    const emptyDone =
        result !== null &&
        error === null &&
        (searches.length > 0 || noTerms) &&
        running === false &&
        (restoredEvicted === null || restoredEvicted === 0) &&
        viewCards.length === 0;

    // #91: translate and pre-first-event fetch have nothing to show yet; the
    // skeleton cards take over from the first admitted event.
    const stageWait = showsStageWait(phase, running, skeletons.length);

    // Spec §4: all relays dead → error screen, never "no matches". Either the
    // run settled with a transport error before any relay answered, or every
    // leg settled refused/timed out with zero events.
    const anyRelayOk = slices.some((s) => s.status === 'ok') || result !== null;
    const allRefused = slices.length > 0 && !slices.some((s) => s.status === 'ok');
    const relayDead =
        (error !== null && !anyRelayOk) ||
        (phase === 'done' && allRefused && skeletons.length === 0);

    // #132: fold per LEG slices to ONE receipt per relay before any surface
    // reads them; the pipeline emits one slice per (search, relay) leg.
    const relayReceipts = aggregatePerRelay(slices);
    const degradedRelays = relayReceipts.filter((r) => r.status !== 'ok');
    const degradedNote = degradedBannerText(relayReceipts);

    // #83 (spec §2 never-lie): a restored session reads as fetched from local
    // storage, never as a fresh network replay; evicted ids got no bytes at
    // all and are counted honestly.
    const footerNotes: string[] = [];
    if (restoredEvicted !== null) {
        if (restoredEvicted === 0) {
            footerNotes.push('restored from local storage');
        } else {
            footerNotes.push('restored from local storage');
            footerNotes.push(`${restoredEvicted} evicted from local storage`);
        }
    }
    degradedRelays.forEach((r) => footerNotes.push(`relay ${r.url} ${r.status}`));

    const capabilityNote = noticeRollup(notices, 'capability', 'relays report no or unverifiable search support');
    const traversalNote = noticeRollup(notices, 'traversal', 'context-fetch warnings');

    // #31 (spec §4): a cold-open share link carried hints and some failed —
    // the record still opened, so it's a degradation notice, not a block.
    // Gated on hasShareHints (F2): a hintless link must not be blamed for
    // "failed hints" it never carried (spec §2 never-lie).
    const shareNote =
        !hasShareHints || shareHints.length === 0
            ? ''
            : shareHints.length === 1
                ? `hinted relay ${shareHints[0]} failed — record opened from the rest`
                : `${shareHints.length} hinted relays failed (${shareHints.join(' · ')}) — record opened from the rest`;

    // #106: `interpreted < total` alone is not a failure — beyond-window cards
    // were never asked; fillNote says so honestly (numeric, never "broken").
    const fillSettleNote = fillNote(
        fillStats.interpreted,
        fillStats.total,
        fillFailure,
        fillErrorMessage,
        rateLimitedCount,
    );

    // The banner fires only when a lane actually lost something: amber ids
    // (asked and lost) or a pinned fill kind (an AIResult failure escaped the
    // retries). Never-asked raw cards stay neutral (spec §2).
    const aiNote =
        result !== null &&
        !filling &&
        fillStats.total > 0 &&
        fillStats.interpreted < fillStats.total &&
        (failed.size > 0 || fillFailure !== null)
            ? fillSettleNote
            : '';

    // Spec §4: no AI key set — everything still works; the hint belongs on the
    // RESULTS surface too (the hero's NoKeyBanner is invisible post-submit).
    const noKey = apiKey === '' && result !== null;

    return {
        noTerms,
        emptyDone,
        stageWait,
        relayDead,
        degradedNote,
        relayReceipts,
        footerNotes,
        capabilityNote,
        traversalNote,
        shareNote,
        fillSettleNote,
        aiNote,
        noKey,
    };
}
