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
	/** Declared tool policy per successfully loaded skill, recorded by read_skill. */
	loadedSkillPolicies: Map<string, SkillDeclaredToolPolicy>;
	/** Set once the harness has widened the run's tool surface after activation. */
	toolsExpanded: boolean;
}

/**
 * Per-run skill policy for a dispatched worker whose agent recipe declares
 * skills. The worker may read_skill exactly these names; anything else gets
 * the same deterministic rejection an unrequested skill gets interactively.
 * Workers resolve their tool surface once at admission, so `toolsExpanded`
 * starts true and no post-activation widening occurs.
 */
export function agentSkillToolPolicy(skillNames: ReadonlyArray<string>): PendingSkillToolPolicy | undefined {
	const allowedSkillNames = [...new Set(skillNames.map((name) => name.trim()).filter((name) => name.length > 0))];
	if (allowedSkillNames.length === 0) return undefined;
	return {
		allowedSkillNames,
		requests: allowedSkillNames.map((name) => ({ name, args: "", source: "recipe" as const, installed: true })),
		loadedSkillNames: new Set<string>(),
		loadedSkillPolicies: new Map<string, SkillDeclaredToolPolicy>(),
		toolsExpanded: true,
	};
}

/**
 * Tool surface for the remainder of a pending-skill turn after at least one
 * requested skill loaded successfully. Pure merge with host-wins semantics:
 *
 *  - The result is always a subset of `hostTools`; a skill can narrow its
 *    surface via `allowed-tools` but never grant beyond host policy.
 *  - A loaded skill with no `allowed-tools` declaration requests the full host
 *    surface. When several skills loaded, their declared sets union.
 *  - `disallowed-tools` subtracts after the allowed union (self-restriction).
 *  - `read_skill` stays active while requested skills remain unloaded, and is
 *    dropped once every request has loaded.
 *  - `ask_user` survives `allowed-tools` narrowing when the host offers it
 *    (the pending skill contract promises the interview channel to loaded
 *    workflows), but an explicit `disallowed-tools` entry still removes it.
 *
 * Returns null when no skill has loaded yet (no expansion).
 */
export function mergePendingSkillToolSurface(
	hostTools: ReadonlyArray<string>,
	policy: Pick<PendingSkillToolPolicy, "allowedSkillNames" | "loadedSkillNames" | "loadedSkillPolicies">,
): string[] | null {
	if (policy.loadedSkillNames.size === 0) return null;
	const loaded = [...policy.loadedSkillNames];
	const declarations = loaded.map((name) => policy.loadedSkillPolicies.get(name) ?? {});
	const everyLoadedDeclares = declarations.every((decl) => (decl.allowedTools?.length ?? 0) > 0);
	const allowedUnion = new Set(declarations.flatMap((decl) => decl.allowedTools ?? []));
	const disallowedUnion = new Set(declarations.flatMap((decl) => decl.disallowedTools ?? []));
	const remainingRequests = policy.allowedSkillNames.some((name) => !policy.loadedSkillNames.has(name));
	const out: string[] = [];
	for (const tool of hostTools) {
		if (out.includes(tool)) continue;
		if (tool === "read_skill") {
			if (remainingRequests) out.push(tool);
			continue;
		}
		if (tool === "ask_user") {
			if (!disallowedUnion.has(tool)) out.push(tool);
			continue;
		}
		if (everyLoadedDeclares && !allowedUnion.has(tool)) continue;
		if (disallowedUnion.has(tool)) continue;
		out.push(tool);
	}
	return out;
}

export interface SkillActivation {
	name: string;
	filePath: string;
	hash: string;
	source: string;
	/** Precise root provenance, for example extension:user:<id> or codex-project. */
	sourceOrigin?: string;
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
	return skillActivationFromSource(
		{ name, filePath, hash, source, ...(sourceOrigin ? { sourceOrigin } : {}) },
		"tool",
		turnId,
	);
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
