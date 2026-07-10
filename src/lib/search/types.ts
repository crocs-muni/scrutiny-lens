export type SearchMode = 'browse' | 'identifier' | 'freetext';

export interface DetectedQuery {
	mode: SearchMode;
	identifier?: string;
	search?: string;
}

export interface NDKFilter {
	kinds?: number[];
	'#t'?: string[];
	'#i'?: string[];
	authors?: string[];
	search?: string;
	limit?: number;
	until?: number;
	since?: number;
}

export interface SearchFilter {
	mode: SearchMode;
	identifier?: string;
	search?: string;
	types?: string[];
}
