import Dexie, { type EntityTable } from 'dexie';
import type { NostrEvent, Session } from './types.js';

export interface SessionRecord extends Omit<Session, 'events'> {
	eventIds: string[];
}

export interface SessionEventRecord {
	id: string;
	sessionId: string;
	event: NostrEvent;
}

class ScrutinyDb extends Dexie {
	sessions!: EntityTable<SessionRecord, 'id'>;
	events!: EntityTable<SessionEventRecord, 'id'>;

	constructor() {
		super('scrutiny-session-explorer');
		this.version(1).stores({
			sessions: 'id, updatedAt',
			events: 'id, sessionId'
		});
	}
}

export const db = new ScrutinyDb();

export async function getSessionRecord(id: string): Promise<SessionRecord | undefined> {
	return db.sessions.get(id);
}

export async function getSessionEvents(sessionId: string): Promise<NostrEvent[]> {
	const records = await db.events.where('sessionId').equals(sessionId).toArray();
	return records.map((r) => r.event);
}

export async function getAllSessions(): Promise<SessionRecord[]> {
	return db.sessions.orderBy('updatedAt').reverse().toArray();
}

export async function saveSession(session: Session): Promise<void> {
	const { events, ...rest } = session;
	const record: SessionRecord = { ...rest, eventIds: events.map((e) => e.id) };
	await db.sessions.put(record);

	const eventRecords: SessionEventRecord[] = events.map((event) => ({
		id: event.id,
		sessionId: session.id,
		event
	}));
	await db.events.bulkPut(eventRecords);
}

export async function deleteSession(id: string): Promise<void> {
	await db.sessions.delete(id);
	await db.events.where('sessionId').equals(id).delete();
}

export async function hydrateSession(id: string): Promise<Session | undefined> {
	const record = await getSessionRecord(id);
	if (!record) return undefined;
	const events = await getSessionEvents(id);
	return { ...record, events };
}
