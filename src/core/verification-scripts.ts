export const VERIFICATION_SCRIPT_FAMILY_HINT = "test*/lint*/build*/typecheck*/check*/format*/ci*";

const VERIFICATION_SCRIPT_PATTERN = /^(?:test|lint|build|typecheck|check|format|ci)(?:[:.-].*)?$/;

export function isVerificationScriptName(name: string): boolean {
	return VERIFICATION_SCRIPT_PATTERN.test(name);
}

export function declaredVerificationScripts(scripts: Record<string, unknown>): string[] {
	return Object.keys(scripts)
		.filter((name) => isVerificationScriptName(name))
		.sort((a, b) => a.localeCompare(b));
}
