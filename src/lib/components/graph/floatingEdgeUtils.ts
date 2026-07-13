import { Position, type InternalNode, type Node, type XYPosition } from '@xyflow/svelte';

/**
 * Ported from xyflow's own floating-edges example (react/svelte share the same
 * geometry). Our layout is d3-force, not a fixed hierarchy like the mockup's,
 * so neighbors can land in any direction relative to each other -- a fixed
 * Handle position would make edges bend at visibly wrong angles the moment a
 * neighbor isn't directly above/below. This computes where a straight line
 * between two node centers actually crosses each node's rectangle, so the
 * edge always meets the card cleanly regardless of relative position.
 */
function getNodeIntersection(intersectionNode: InternalNode, targetNode: InternalNode): XYPosition {
	const { width: intersectionNodeWidth, height: intersectionNodeHeight } =
		intersectionNode.measured ?? { width: 0, height: 0 };
	const intersectionNodePosition = intersectionNode.internals.positionAbsolute;
	const targetPosition = targetNode.internals.positionAbsolute;

	const w = (intersectionNodeWidth ?? 0) / 2;
	const h = (intersectionNodeHeight ?? 0) / 2;

	const x2 = intersectionNodePosition.x + w;
	const y2 = intersectionNodePosition.y + h;
	const x1 = targetPosition.x + (targetNode.measured?.width ?? 0) / 2;
	const y1 = targetPosition.y + (targetNode.measured?.height ?? 0) / 2;

	const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
	const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
	const a = 1 / (Math.abs(xx1) + Math.abs(yy1));
	const xx3 = a * xx1;
	const yy3 = a * yy1;
	const x = w * (xx3 + yy3) + x2;
	const y = h * (-xx3 + yy3) + y2;

	return { x, y };
}

function getEdgePosition(node: Node, intersectionPoint: XYPosition): Position {
	const nx = Math.round(node.position.x);
	const ny = Math.round(node.position.y);
	const px = Math.round(intersectionPoint.x);
	const py = Math.round(intersectionPoint.y);

	if (px <= nx + 1) return Position.Left;
	if (px >= nx + (node.measured?.width ?? 0) - 1) return Position.Right;
	if (py <= ny + 1) return Position.Top;
	if (py >= ny + (node.measured?.height ?? 0) - 1) return Position.Bottom;
	return Position.Top;
}

export interface FloatingEdgeParams {
	sx: number;
	sy: number;
	tx: number;
	ty: number;
	sourcePos: Position;
	targetPos: Position;
}

/** The parameters (sx, sy, tx, ty, sourcePos, targetPos) needed to draw a floating edge. */
export function getEdgeParams(source: InternalNode, target: InternalNode): FloatingEdgeParams {
	const sourceIntersectionPoint = getNodeIntersection(source, target);
	const targetIntersectionPoint = getNodeIntersection(target, source);

	const sourcePos = getEdgePosition(source, sourceIntersectionPoint);
	const targetPos = getEdgePosition(target, targetIntersectionPoint);

	return {
		sx: sourceIntersectionPoint.x,
		sy: sourceIntersectionPoint.y,
		tx: targetIntersectionPoint.x,
		ty: targetIntersectionPoint.y,
		sourcePos,
		targetPos
	};
}
