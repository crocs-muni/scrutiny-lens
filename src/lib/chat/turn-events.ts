/** The wire events a chat turn can receive. Kept separate from the state so the store's frame mapping can stay a catch-all for anything the pump invents. */
export type TurnEvent =
	| { type: 'send'; question: string }
	| { type: 'delta'; text: string }
	| { type: 'error'; message: string }
	| { type: 'final' }
	| { type: 'abort' };
