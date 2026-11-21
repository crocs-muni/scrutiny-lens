// axe accessibility summary: turn per-capture violations into one stable,
// scoreboard-sized report.
//
// The capture unit is scene+theme (same as a screenshot), so the summary has
// two groupings: by rule (what is broken, across captures) and by scene
// (where). Counts are node counts, not rule counts: one repeated contrast
// failure must not look like one issue. `blocking` is serious/critical,
// `advisory` is moderate/minor (axe's `null` impact falls into `unknown`,
// which is advisory until a rule is understood).

import type { A11yViolation, SceneResult, Theme } from './capture.ts';

export type Impact = 'critical' | 'serious' | 'moderate' | 'minor' | 'unknown';

/** Severity order: blocking first, then advisory, then unknown. */
const IMPACT_ORDER: readonly Impact[] = ['critical', 'serious', 'moderate', 'minor', 'unknown'];

const THEME_ORDER: readonly Theme[] = ['light', 'dark'];

export interface A11yBucket {
	/** Rule instances: one per capture a rule fires in. */
	violations: number;
	/** Offending DOM nodes. */
	nodes: number;
}

export interface A11yRuleSummary extends A11yBucket {
	id: string;
	/** Highest severity seen for this rule across captures. */
	impact: Impact;
	help: string;
	helpUrl: string;
	/** `<scene>.<theme>` keys where the rule fired, sorted. */
	captures: string[];
}

export interface A11yCaptureSummary extends A11yBucket {
	scene: string;
	theme: Theme;
	/** Node counts per impact for this capture. */
	byImpact: Record<Impact, number>;
}

export interface A11ySummary {
	/** Run label (`--label`), for provenance. */
	run: string;
	/** Scene+theme captures analyzed. */
	captures: number;
	/** Distinct rule ids. */
	rules: number;
	/** Rule instances across captures. */
	violations: number;
	nodes: number;
	/** serious/critical. */
	blocking: A11yBucket & { rules: number };
	/** moderate/minor/unknown. */
	advisory: A11yBucket & { rules: number };
	/** Node counts per impact. */
	byImpact: Record<Impact, number>;
	/** Blocking first, then by node count desc, then id. */
	byRule: A11yRuleSummary[];
	/** Capture order (scene, then theme), so a report is stable. */
	byScene: A11yCaptureSummary[];
	/** Captures where axe itself failed (message per capture), sorted. */
	errors: string[];
}

function impactOf(value: string | null | undefined): Impact {
	return value === 'critical' || value === 'serious' || value === 'moderate' || value === 'minor'
		? value
		: 'unknown';
}

function emptyByImpact(): Record<Impact, number> {
	return { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
}

/** axe gives frame/shadow selectors as `string | string[]` entries; flatten
 * the shadow-DOM tuple to one readable selector per frame. */
function selector(target: unknown): string[] {
	if (!Array.isArray(target)) return [String(target)];
	return target.map((part) =>
		Array.isArray(part) ? part.map((value) => String(value)).join(' >>> ') : String(part)
	);
}

/** Raw axe results are large (checks, messages, related nodes). Keep only the
 * row a scoreboard needs, deterministically ordered. */
export function compactViolations(
	violations: readonly {
		id: string;
		impact?: string | null;
		help: string;
		helpUrl: string;
		nodes: readonly { target: unknown; html: string; failureSummary?: string | null }[];
	}[]
): A11yViolation[] {
	return violations
		.map((violation) => ({
			id: violation.id,
			impact: impactOf(violation.impact),
			help: violation.help,
			helpUrl: violation.helpUrl,
			nodes: violation.nodes
				.map((node) => ({
					target: selector(node.target),
					html: node.html,
					failureSummary: node.failureSummary ?? null
				}))
				.sort(
					(a, b) =>
						a.target.join(' ').localeCompare(b.target.join(' ')) ||
						a.html.localeCompare(b.html)
				)
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
}

function themeRank(theme: Theme): number {
	const at = THEME_ORDER.indexOf(theme);
	return at === -1 ? THEME_ORDER.length : at;
}

export function summarizeA11y(results: readonly SceneResult[], run: string): A11ySummary {
	const byImpact = emptyByImpact();
	const rules = new Map<string, A11yRuleSummary>();
	const byScene: A11yCaptureSummary[] = [];
	const errors: string[] = [];
	let violations = 0;
	let nodes = 0;

	for (const result of results) {
		const capture = `${result.scene}.${result.theme}`;
		if (result.a11yError !== undefined && result.a11yError !== null) {
			errors.push(`${capture}: ${result.a11yError}`);
		}
		const captureImpact = emptyByImpact();
		let captureViolations = 0;
		let captureNodes = 0;
		for (const violation of result.a11yViolations ?? []) {
			const impact = impactOf(violation.impact);
			const count = violation.nodes.length;
			captureViolations += 1;
			captureNodes += count;
			violations += 1;
			nodes += count;
			captureImpact[impact] += count;
			byImpact[impact] += count;

			const rule = rules.get(violation.id);
			if (rule === undefined) {
				rules.set(violation.id, {
					id: violation.id,
					impact,
					help: violation.help,
					helpUrl: violation.helpUrl,
					violations: 1,
					nodes: count,
					captures: [capture]
				});
				continue;
			}
			rule.violations += 1;
			rule.nodes += count;
			if (rule.captures[rule.captures.length - 1] !== capture) rule.captures.push(capture);
			if (IMPACT_ORDER.indexOf(impact) < IMPACT_ORDER.indexOf(rule.impact)) rule.impact = impact;
		}
		byScene.push({
			scene: result.scene,
			theme: result.theme,
			violations: captureViolations,
			nodes: captureNodes,
			byImpact: captureImpact
		});
	}

	const byRule = [...rules.values()]
		.map((rule) => ({ ...rule, captures: [...new Set(rule.captures)].sort() }))
		.sort(
			(a, b) =>
				IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) ||
				b.nodes - a.nodes ||
				a.id.localeCompare(b.id)
		);

	const bucket = (accept: (impact: Impact) => boolean): A11yBucket & { rules: number } => {
		const picked = byRule.filter((rule) => accept(rule.impact));
		return {
			rules: picked.length,
			violations: picked.reduce((total, rule) => total + rule.violations, 0),
			nodes: picked.reduce((total, rule) => total + rule.nodes, 0)
		};
	};

	byScene.sort(
		(a, b) => a.scene.localeCompare(b.scene) || themeRank(a.theme) - themeRank(b.theme)
	);
	errors.sort();

	return {
		run,
		captures: results.length,
		rules: byRule.length,
		violations,
		nodes,
		blocking: bucket((impact) => impact === 'critical' || impact === 'serious'),
		advisory: bucket((impact) => impact !== 'critical' && impact !== 'serious'),
		byImpact,
		byRule,
		byScene,
		errors
	};
}
