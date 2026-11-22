// GraphCanvas camera gesture (#102/#103 discipline, Glide transition).
//
// A wheel is a GESTURE: it claims the camera, writes the live k, and nulls any
// in-flight glide target in the same line. The observable proof from outside
// is the `.world` transform: it carries the derived camera scale, so a wheel
// notch must land a k ≠ 1 there immediately (no rubber band, no rAF wait).
//
// jsdom gaps this test fills locally (no production change):
//  - ResizeObserver is absent; the stage measures itself through it, and the
//    zoom math needs non-zero stage dims.
//  - getBoundingClientRect is all zeros, so clientX/clientY ARE stage coords.

import { render, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import GraphCanvas from './GraphCanvasHarness.svelte';

const STAGE_W = 800;
const STAGE_H = 600;

class StageResizeObserver {
	constructor(private readonly cb: ResizeObserverCallback) {}
	observe(): void {
		this.cb(
			[{ contentRect: { width: STAGE_W, height: STAGE_H } } as ResizeObserverEntry],
			this as unknown as ResizeObserver
		);
	}
	unobserve(): void {}
	disconnect(): void {}
}

const originalRO = globalThis.ResizeObserver;
// jsdom has no PointerEvent; MouseEvent carries the init fields the handlers
// read (button, buttons, clientX/Y) and is enough for the latch test.
class TestPointerEvent extends MouseEvent {
	readonly pointerId: number;
	constructor(type: string, init: PointerEventInit = {}) {
		super(type, init);
		this.pointerId = init.pointerId ?? 1;
	}
}
const originalPointerEvent = globalThis.PointerEvent;

beforeEach(() => {
	globalThis.ResizeObserver = StageResizeObserver as unknown as typeof ResizeObserver;
	globalThis.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
});

afterEach(() => {
	globalThis.ResizeObserver = originalRO;
	globalThis.PointerEvent = originalPointerEvent;
});

/** The scale factor inside `translate(...) scale(k)`. */
function scaleOf(el: HTMLElement): number {
	const m = /scale\(([^)]+)\)/.exec(el.style.transform);
	return m ? Number(m[1]) : NaN;
}

describe('GraphCanvas glide (camera gesture)', () => {
	it('zoom gesture claims the camera and updates k', async () => {
		const { container } = render(GraphCanvas, {
			props: {
				events: [],
				cards: [],
				// A non-null root is what renders the stage at all: a null root is
				// the honest empty state (no canvas, nothing to zoom).
				root: 'subject-root',
				selectedEventId: null,
				onSelect: () => {},
				onDeselect: () => {}
			}
		});

		const stage = container.querySelector('.stage') as HTMLElement;
		expect(stage).toBeTruthy();
		const before = scaleOf(container.querySelector('.world') as HTMLElement);
		expect(before).toBe(1);

		// One wheel notch in at the stage centre (clientX/Y == stage coords in
		// jsdom, see header).
		await fireEvent.wheel(stage, { deltaY: -100, clientX: STAGE_W / 2, clientY: STAGE_H / 2 });
		await tick();

		const world = container.querySelector('.world') as HTMLElement;
		expect(world.style.transform).toMatch(/scale\([^)]+\)/);
		const after = scaleOf(world);
		expect(Number.isFinite(after)).toBe(true);
		// Zoomed IN (deltaY < 0) and the gesture wrote k directly — the old
		// glide target is dead, so this is not an intermediate easing frame.
		expect(after).toBeGreaterThan(1);
		expect(after).toBeLessThanOrEqual(1.6);
		// The Glide transition itself: the gesture CLAIMS the camera, so the
		// stage advertises the claimed state (never a rubber-band glide).
		// `data-glide` is the documented test seam; production reads nothing.
		expect(stage.dataset.glide).toBe('claimed');
	});

	it('swallows the first empty-pane click after a pan, then deselects', async () => {
		const onDeselect = vi.fn();
		const { container } = render(GraphCanvas, {
			props: {
				events: [],
				cards: [],
				root: 'subject-root',
				selectedEventId: null,
				onSelect: () => {},
				onDeselect
			}
		});
		const stage = container.querySelector('.stage') as HTMLElement;

		// One pan past the 4px threshold: sets justPanned and claims the camera.
		await fireEvent.pointerDown(stage, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
		await fireEvent.pointerMove(window, { buttons: 1, clientX: 80, clientY: 80, pointerId: 1 });
		await fireEvent.pointerUp(window, { button: 0, clientX: 80, clientY: 80, pointerId: 1 });

		// The release click that lands on the pane must not deselect; the next
		// intentional empty-pane click must.
		await fireEvent.click(stage);
		expect(onDeselect).not.toHaveBeenCalled();
		await fireEvent.click(stage);
		expect(onDeselect).toHaveBeenCalledTimes(1);
	});
});
