import type { SessionPromptInputs } from "../domains/prompts/compiler.js";
import { canonicalJson, sha256 } from "../domains/prompts/hash.js";
import type { ContextWindowSource } from "../domains/providers/index.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";

/** The exact schema bytes pi attaches to a provider request for one tool. */
export interface AttachedToolSchema {
	name: string;
	description: string;
	parameters: unknown;
}

/**
 * Project the live agent tools onto the schema fields sent to the provider.
 * Array order is preserved because providers serialize the attached tools in
 * that order, so reordering them changes prompt-prefix bytes too.
 */
export function attachedToolSchemasFromState(tools: ReadonlyArray<unknown>): AttachedToolSchema[] {
	const schemas: AttachedToolSchema[] = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
		const record = tool as Record<string, unknown>;
		schemas.push({
			name: typeof record.name === "string" ? record.name : "",
			description: typeof record.description === "string" ? record.description : "",
			parameters: record.parameters ?? null,
		});
	}
	return schemas;
}

export interface MainPromptCacheIdentityInput {
	targetId: string;
	runtimeId: string;
	wireModelId: string;
	autonomy: AutonomyLevel;
	sessionId: string;
	cwd: string;
	workingContextPaths: ReadonlyArray<string>;
	contextWindowSource: ContextWindowSource | null;
	sessionInputs: SessionPromptInputs;
	attachedToolSchemas: ReadonlyArray<AttachedToolSchema>;
}

/**
 * Canonical identity for the interactive session-prompt compile cache.
 * Config hot reload explicitly invalidates compiler-owned fragments and
 * rosters; this identity covers every live/caller input resolved per turn.
 */
export function mainPromptCacheIdentity(input: MainPromptCacheIdentityInput): string {
	return sha256(
		canonicalJson({
			version: 1,
			targetId: input.targetId,
			runtimeId: input.runtimeId,
			wireModelId: input.wireModelId,
			autonomy: input.autonomy,
			sessionId: input.sessionId,
			cwd: input.cwd,
			workingContextPaths: [...input.workingContextPaths].sort((a, b) => a.localeCompare(b)),
			contextWindowSource: input.contextWindowSource,
			sessionInputs: input.sessionInputs,
			attachedToolSchemas: input.attachedToolSchemas,
		}),
	);
}
