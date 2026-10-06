import type { ExtensionLoadScope } from "./types.js";

export interface ExtensionCommandRow {
	origin: "extension";
	invocation: string;
	extensionId: string;
	scope: ExtensionLoadScope;
	description: string;
	generation: number;
	available: boolean;
	/** A validated bundle alias may own the prompt spelling while its runtime is available. */
	replaces?: "prompt";
	reason?: string;
}
export function extensionInvocation(id: string, command: string): string {
	return `ext:${id}:${command}`;
}
/** Canonical commands, including existing dotted/underscored extension IDs. */
export function isExtensionCommandToken(token: string): boolean {
	return /^ext:[^\s/]+$/u.test(token);
}
/** Same collision projection is consumed by completion, inspection, and submission. */
export function resolveExtensionCommands(
	rows: readonly ExtensionCommandRow[],
	promptNames: readonly string[],
): ExtensionCommandRow[] {
	const prompts = new Set(promptNames.map((name) => name.toLowerCase()));
	return rows.map((row) =>
		prompts.has(row.invocation.toLowerCase()) && row.replaces !== "prompt"
			? { ...row, available: false, reason: "invocation belongs to an existing prompt template" }
			: row,
	);
}
