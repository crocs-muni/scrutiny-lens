// Determinism ledger: capture every scene several times and measure how much
// the same commit disagrees with itself. The result is the per-scene noise
// floor `compare` must clear before it calls a difference real.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureScenes, type Scene, type Theme } from './capture.ts';
import { diffPngs } from './diff.ts';

export interface NoiseEntry {
	scene: string;
	theme: Theme;
	runs: number;
	/** Distinct screenshots seen across the runs (1 = fully deterministic). */
	distinct: number;
	/** Largest differing-pixel count of any run against run 0. */
	maxPixels: number;
	/** Largest differing fraction of any run against run 0. */
	maxRatio: number;
}

export type NoiseFloor = Record<string, NoiseEntry>;

export const NOISE_FILE = join('.harness', 'noise.json');

export async function runLedger(
	scenes: readonly Scene[],
	buildDir: string,
	runs: number
): Promise<NoiseFloor> {
	const dirs: string[] = [];
	for (let i = 0; i < runs; i++) {
		const outDir = join('.harness', 'ledger', String(i));
		await captureScenes(scenes, { buildDir, outDir });
		dirs.push(outDir);
	}
	const floor: NoiseFloor = {};
	for (const scene of scenes) {
		for (const theme of scene.themes ?? (['light', 'dark'] as const)) {
			const name = `${scene.id}.${theme}.png`;
			const shots = dirs.map((dir) => readFileSync(join(dir, name)));
			const base = shots[0];
			let maxPixels = 0;
			let maxRatio = 0;
			for (const shot of shots.slice(1)) {
				const { pixels, ratio } = diffPngs(base, shot);
				maxPixels = Math.max(maxPixels, pixels);
				maxRatio = Math.max(maxRatio, ratio);
			}
			floor[`${scene.id}.${theme}`] = {
				scene: scene.id,
				theme,
				runs,
				distinct: new Set(shots.map((s) => createHash('sha256').update(s).digest('hex'))).size,
				maxPixels,
				maxRatio
			};
		}
	}
	mkdirSync('.harness', { recursive: true });
	writeFileSync(NOISE_FILE, `${JSON.stringify(floor, null, 2)}\n`);
	return floor;
}
