export const VERIFICATION_SCRIPT_FAMILY_HINT = "test*/lint*/build*/typecheck*/check*/format*/ci*";

const VERIFICATION_SCRIPT_PATTERN = /^(?:test|lint|build|typecheck|check|format|ci)(?:[:.-].*)?$/;
const PROJECT_VERIFIER_CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

export function isVerificationScriptName(name: string): boolean {
	return VERIFICATION_SCRIPT_PATTERN.test(name);
}

/**
 * Whether a check script or target name says it rewrites the tree (`format`, `lint:fix`, `prettier:write`): a `fix` or
 * `write` part, or a `format` part with no `check` part beside it, so `format:check` stays a check.
 */
export function isWriteCapableScriptName(name: string): boolean {
	const parts = name.split(/[:.-]/u);
	return parts.includes("fix") || parts.includes("write") || (parts.includes("format") && !parts.includes("check"));
}

/** Stable identifier grammar for project-declared verifier catalog checks. */
export function isProjectVerifierCheckId(name: string): boolean {
	return PROJECT_VERIFIER_CHECK_ID_PATTERN.test(name);
}

export function declaredVerificationScripts(scripts: Record<string, unknown>): string[] {
	return Object.keys(scripts)
		.filter((name) => isVerificationScriptName(name))
		.sort((a, b) => a.localeCompare(b));
}
