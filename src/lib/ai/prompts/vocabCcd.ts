/**
 * CC-vocab appendix (verbatim from docs/profiles.md "Shared CC-vocab appendix")
 * plus profile lens deltas and a system-prompt builder for the cards agent.
 */

export const CC_VOCAB_APPENDIX = [
	'Common Criteria vocabulary:',
	"- Scheme names: BSI (Germany), ANSSI (France), NIAP (USA). NIAP certs show Protection-Profile conformance, NOT EAL levels (NIAP has not assigned EALs since ~2014).",
	'- Certificate-ID formats: `BSI-DSZ-CC-\\d{4}-\\d{4}` and `ANSSI-CC-\\d{4}/\\d{2}`.',
	'- Assurance strings match `^EAL[1-7]\\+?$` (`EAL4+` = "EAL4 augmented", not a level).',
	'- Canonical category strings come from the CC portal, e.g. `ICs, Smart Cards and Smart Card-Related Devices and Systems`.',
	'- Indexer prefixes: `cc`, `cve`, `cwe`, `cpe`, `vendor`, `pp` (Protection Profile).',
	'Lifecycle: protocol status is ONLY `active` or `retracted` (kind-5). No other status value exists; spec §2 rule 2 is explicit: \'archived\' is NOT a protocol status and does not exist. `Maintenance` is a metadata kind, never a status.',
].join('\n');

/** Named profile lens deltas copied from the profiles in docs/profiles.md. */
export const PROFILE_DELTAS: Record<string, string> = {
	smartcard:
		'Lens: smartcard/secure-element analyst. Emphasize chip family, interface (contact/contactless), crypto library, side-channel vectors (ROCA, power analysis, timing), certified platform version, and maintenance path.',
	certificate:
		'Lens: CC-certificate analyst. Emphasize validity dates, assurance continuity (maintenance reports), re-certification history, and cross-scheme comparison. Note maintained-vs-reissued and gaps in assurance.',
	generic:
		'Lens: general security-product analyst. Coverage-oriented; emphasize product type, vendor, and associated vulnerabilities.',
};

export const DEFAULT_PROFILE = 'generic';

export interface BuildSystemPromptOptions {
	profile?: string;
	extra?: string;
}

/**
 * Build the system prompt for card interpretation:
 * the shared CC-vocab appendix, then the profile lens delta (defaulting to
 * the generic lens), then any extra instructions.
 */
export function buildSystemPrompt({ profile, extra }: BuildSystemPromptOptions = {}): string {
	const parts = [CC_VOCAB_APPENDIX];
	const lens = (profile && PROFILE_DELTAS[profile] ? PROFILE_DELTAS[profile] : PROFILE_DELTAS[DEFAULT_PROFILE]);
	parts.push(`\n${lens}`);
	if (extra && extra.length > 0) parts.push(`\n${extra}`);
	return parts.join('\n');
}
