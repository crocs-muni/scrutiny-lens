import { readFileSync } from 'node:fs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface Bounds {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export interface DiffResult {
	/** Differing pixels (0 means byte-for-byte equal pixels). */
	pixels: number;
	/** Fraction of the image that differs, 0..1. */
	ratio: number;
	/** Bounding box of the differing pixels, null when identical. */
	bounds: Bounds | null;
	/** Set when the images cannot be compared pixel-wise. */
	sizeMismatch: { a: [number, number]; b: [number, number] } | null;
	/** The diff image as PNG bytes (changed pixels red), null when identical. */
	image: Buffer | null;
}

/** Exact comparison (threshold 0): the harness wants any change visible, then
 * decides what counts. Different sizes are reported, not padded. */
export function diffPngs(a: Buffer | string, b: Buffer | string): DiffResult {
	const left = PNG.sync.read(typeof a === 'string' ? readFileSync(a) : a);
	const right = PNG.sync.read(typeof b === 'string' ? readFileSync(b) : b);
	if (left.width !== right.width || left.height !== right.height) {
		return {
			pixels: Math.max(left.width * left.height, right.width * right.height),
			ratio: 1,
			bounds: null,
			sizeMismatch: { a: [left.width, left.height], b: [right.width, right.height] },
			image: null
		};
	}
	const out = new PNG({ width: left.width, height: left.height });
	const pixels = pixelmatch(left.data, right.data, out.data, left.width, left.height, {
		threshold: 0,
		includeAA: true
	});
	if (pixels === 0) return { pixels, ratio: 0, bounds: null, sizeMismatch: null, image: null };
	let bounds: Bounds = { x0: left.width, y0: left.height, x1: -1, y1: -1 };
	for (let y = 0; y < left.height; y++) {
		for (let x = 0; x < left.width; x++) {
			const at = (y * left.width + x) * 4;
			// pixelmatch paints differing pixels pure red.
			if (out.data[at] === 255 && out.data[at + 1] === 0 && out.data[at + 2] === 0) {
				bounds = {
					x0: Math.min(bounds.x0, x),
					y0: Math.min(bounds.y0, y),
					x1: Math.max(bounds.x1, x),
					y1: Math.max(bounds.y1, y)
				};
			}
		}
	}
	return {
		pixels,
		ratio: pixels / (left.width * left.height),
		bounds,
		sizeMismatch: null,
		image: PNG.sync.write(out)
	};
}
