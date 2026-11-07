// Chat live-region announcements (issue #124, #93 W1). The bug: switching
// sessions mid-stream aborts the turn (ADR 0003 — it dies quietly) and empties
// the transcript, but the polite region then spoke "0 messages" — the NEW
// session's not-yet-hydrated count, announced as this turn's outcome.

import { describe, expect, it } from 'vitest';
import { chatAnnouncement } from '../src/lib/components/shell/chat-live';

describe('chatAnnouncement', () => {
	it('names the two live milestones', () => {
		expect(chatAnnouncement({ kind: 'started' })).toBe('Answer streaming');
		expect(chatAnnouncement({ kind: 'failed' })).toBe('Answer failed');
	});

	it('speaks the settled transcript size when the turn landed', () => {
		expect(chatAnnouncement({ kind: 'settled', messagesAtStart: 2, messagesNow: 4 })).toBe(
			'4 messages'
		);
	});

	it('stays silent when a turn never landed — the session-switch abort', () => {
		// abortInFlight() then messages = []: the transcript shrank, so the
		// count is a fact about a different (unhydrated) session, not this turn.
		expect(chatAnnouncement({ kind: 'settled', messagesAtStart: 4, messagesNow: 0 })).toBe('');
		// Unchanged length is the same non-event (a reset that kept the rows).
		expect(chatAnnouncement({ kind: 'settled', messagesAtStart: 4, messagesNow: 4 })).toBe('');
	});
});
