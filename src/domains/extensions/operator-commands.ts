import type { ExtensionLoadScope } from "./types.js";

export interface ExtensionCommandRow {
	origin: "extension";
	invocation: string;
	extensionId: string;
	scope: ExtensionLoadScope;
	description: string;
	generation: number;
	available: boolean;
	/** The served plugin's prompt name, owned by this command while its runtime is available. */
	replaces?: "prompt";
	reason?: string;
	/** Unavailable only until a reload settles; a takeover refuses meanwhile instead of handing its prompt to the model. */
	transient?: true;
}
export function extensionInvocation(id: string, command: string): string {
	return `ext:${id}:${command}`;
}
/** Canonical commands, including existing dotted/underscored extension IDs. */
export function isExtensionCommandToken(token: string): boolean {
	return /^ext:[^\s/]+$/u.test(token);
}
/**
 * A loaded prompt template as extension commands see it: its name and the
 * source that won the name (`plugin:<scope>:<id>` for a plugin, `config` or
 * `project` for an operator file). A bare string proves no ownership, so it
 * never qualifies a takeover.
 */
export interface PromptRef {
	name: string;
	source?: string;
}

export function promptRefName(ref: string | PromptRef): string {
	return typeof ref === "string" ? ref : ref.name;
}

/** The prompt list a caller holds, as the ownership refs command resolution takes. */
export function promptRefs(items: ReadonlyArray<{ name: string; sourceInfo: { source?: string } }>): PromptRef[] {
	return items.map((item) => ({
		name: item.name,
		...(item.sourceInfo.source ? { source: item.sourceInfo.source } : {}),
	}));
}

/** Same collision projection is consumed by completion, inspection, and submission. */
export function resolveExtensionCommands(
	rows: readonly ExtensionCommandRow[],
	promptNames: ReadonlyArray<string | PromptRef>,
): ExtensionCommandRow[] {
	const prompts = new Set(promptNames.map((ref) => promptRefName(ref).toLowerCase()));
	return rows.map((row) =>
		prompts.has(row.invocation.toLowerCase()) && row.replaces !== "prompt"
			? { ...row, available: false, reason: "invocation belongs to an existing prompt template" }
			: row,
	);
}
