export type SkillActivationTrigger = "slash-command" | "tool";
export type PendingSkillRequestSource = "slash-command" | "selector" | "marketplace" | "recipe";

export interface PendingSkillRequest {
	name: string;
	args: string;
	source: PendingSkillRequestSource;
	installed: boolean;
	filePath?: string;
	marketplaceRef?: string;
}

/** Tool surface a loaded SKILL.md declares for its own workflow. */
export interface SkillDeclaredToolPolicy {
	allowedTools?: ReadonlyArray<string>;
	disallowedTools?: ReadonlyArray<string>;
}

export interface PendingSkillToolPolicy {
	allowedSkillNames: ReadonlyArray<string>;
	requests: ReadonlyArray<PendingSkillRequest>;
	loadedSkillNames: Set<string>;
	/** Declared tool policy per successfully loaded skill, recorded by context(scope=skills). */
	loadedSkillPolicies: Map<string, SkillDeclaredToolPolicy>;
}

/**
 * Tools admitted regardless of any active skill narrowing: context so the
 * remaining requested skills of the same turn can still load, and ask_user as
 * the escape hatch the block message points at when a workflow genuinely
 * needs a tool its skill did not declare.
 */
export const SKILL_SURFACE_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["context", "ask_user"]);

export interface SkillToolSurfaceViolation {
	/** Every loaded skill that contributed a declaration to the merged surface. */
	skills: ReadonlyArray<string>;
	/** Merged allowed-tools union when allow-narrowing applies; null for a disallow hit. */
	mergedAllowedTools: ReadonlyArray<string> | null;
	/** Skills whose disallowed-tools name the tool directly. */
	disallowedBy: ReadonlyArray<string>;
}

/**
 * Evaluate a tool call against the tool surface declared by the skills loaded
 * so far under `policy`. Narrowing only ever blocks; it never grants anything
 * the safety net or autonomy mapping would refuse. Merge semantics:
 *
 * - Denials win: a tool named in any loaded skill's disallowed-tools is out.
 * - Allow-narrowing applies only while every loaded skill declares
 *   allowed-tools; the merged surface is their union. A loaded skill with no
 *   allowed-tools keeps the full surface for its own workflow, so it lifts
 *   the allow-narrowing (but not the denials) for the turn.
 *
 * Returns null when the call is inside the surface or no narrowing is active.
 */
export function evaluateSkillToolSurface(
	policy: PendingSkillToolPolicy | undefined,
	tool: string,
): SkillToolSurfaceViolation | null {
	if (!policy || policy.loadedSkillPolicies.size === 0) return null;
	if (SKILL_SURFACE_EXEMPT_TOOLS.has(tool)) return null;
	const entries = [...policy.loadedSkillPolicies.entries()];
	const skills = entries.map(([name]) => name);
	const disallowedBy = entries
		.filter(([, declared]) => declared.disallowedTools?.includes(tool) === true)
		.map(([name]) => name);
	if (disallowedBy.length > 0) return { skills, mergedAllowedTools: null, disallowedBy };
	const allowLists = entries.map(([, declared]) => declared.allowedTools);
	if (allowLists.some((list) => list === undefined || list.length === 0)) return null;
	const merged = [...new Set(allowLists.flatMap((list) => [...(list ?? [])]))];
	if (merged.includes(tool)) return null;
	return { skills, mergedAllowedTools: merged, disallowedBy: [] };
}

/**
 * Per-run skill policy for a dispatched worker whose agent recipe declares
 * skills. The worker may load exactly these skill names; anything else gets
 * the same deterministic rejection an unrequested skill gets interactively.
 */
export function agentSkillToolPolicy(skillNames: ReadonlyArray<string>): PendingSkillToolPolicy | undefined {
	const allowedSkillNames = [...new Set(skillNames.map((name) => name.trim()).filter((name) => name.length > 0))];
	if (allowedSkillNames.length === 0) return undefined;
	return {
		allowedSkillNames,
		requests: allowedSkillNames.map((name) => ({ name, args: "", source: "recipe" as const, installed: true })),
		loadedSkillNames: new Set<string>(),
		loadedSkillPolicies: new Map<string, SkillDeclaredToolPolicy>(),
	};
}

export interface SkillActivation {
	name: string;
	filePath: string;
	hash: string;
	source: string;
	/** Precise root provenance, for example extension:user:<id> or codex-project. */
	sourceOrigin?: string;
	/** Pinned-manifest comparison verdict; "mismatch" records skill_drift. */
	drift?: "match" | "mismatch";
	triggeredBy: SkillActivationTrigger;
	turnId?: string;
}

export interface SkillActivationSource {
	name: string;
	filePath: string;
	hash: string;
	source: string;
	sourceOrigin?: string;
	sourceInfo?: { source?: string };
}

function trimmedString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function skillActivationFromSource(
	source: SkillActivationSource,
	triggeredBy: SkillActivationTrigger,
	turnId?: string,
): SkillActivation {
	const sourceOrigin = trimmedString(source.sourceOrigin) ?? trimmedString(source.sourceInfo?.source);
	return {
		name: source.name,
		filePath: source.filePath,
		hash: source.hash,
		source: source.source,
		...(sourceOrigin ? { sourceOrigin } : {}),
		triggeredBy,
		...(turnId ? { turnId } : {}),
	};
}

export function skillActivationFromToolDetails(details: unknown, turnId?: string): SkillActivation | null {
	if (!details || typeof details !== "object" || Array.isArray(details)) return null;
	const record = details as Record<string, unknown>;
	const name = trimmedString(record.name);
	const filePath = trimmedString(record.filePath) ?? trimmedString(record.path);
	const hash = trimmedString(record.hash);
	const source = trimmedString(record.source);
	const sourceOrigin = trimmedString(record.sourceOrigin) ?? trimmedString(record.origin);
	if (!name || !filePath || !hash || !source) return null;
	const activation = skillActivationFromSource(
		{ name, filePath, hash, source, ...(sourceOrigin ? { sourceOrigin } : {}) },
		"tool",
		turnId,
	);
	if (record.drift === "match" || record.drift === "mismatch") activation.drift = record.drift;
	return activation;
}

export function isSkillActivation(value: unknown): value is SkillActivation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.name === "string" &&
		typeof record.filePath === "string" &&
		typeof record.hash === "string" &&
		typeof record.source === "string" &&
		(record.sourceOrigin === undefined || typeof record.sourceOrigin === "string") &&
		(record.triggeredBy === "slash-command" || record.triggeredBy === "tool") &&
		(record.turnId === undefined || typeof record.turnId === "string")
	);
}
