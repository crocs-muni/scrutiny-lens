import type { Scene } from '../capture.ts';
import { chaosScenes } from './chaos.ts';
import { chatScenes } from './chat.ts';
import { dossierScenes } from './dossier.ts';
import { graphScenes } from './graph.ts';
import { resultsScenes } from './results.ts';
import { settingsScenes } from './settings.ts';

/** The one entry `harness/cli.ts` calls; order is the capture order, so the
 * plain result set runs first (it is the reference surface). */
export function buildScenes(): readonly Scene[] {
	return [
		...resultsScenes(),
		...chaosScenes(),
		...dossierScenes(),
		...graphScenes(),
		...chatScenes(),
		...settingsScenes()
	];
}
