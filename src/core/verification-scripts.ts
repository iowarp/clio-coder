export const VERIFICATION_SCRIPT_FAMILY_HINT = "test*/lint*/build*/typecheck*/check*/format*/ci*";

const VERIFICATION_SCRIPT_PATTERN = /^(?:test|lint|build|typecheck|check|format|ci)(?:[:.-].*)?$/;
const PROJECT_VERIFIER_CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;

export function isVerificationScriptName(name: string): boolean {
	return VERIFICATION_SCRIPT_PATTERN.test(name);
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
