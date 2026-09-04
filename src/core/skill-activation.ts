export type SkillActivationTrigger = "slash-command" | "tool";
export type PendingSkillRequestSource = "slash-command" | "selector" | "marketplace" | "recipe";

/**
 * The one reply shape every surface teaches for skill suggestions: the
 * context(scope="skills") listing footer, the first-turn middleware
 * reminder, and the operator-gate denial all cite this exact line so the
 * model learns a single protocol.
 */
export const SKILL_SUGGESTION_ANCHOR = "Suggested skill: /skill <name>";

/**
 * The part of the anchor a real reply keeps once `<name>` is substituted.
 *
 * Surfaces that recognize a suggestion in live output must match this, not the
 * template: no model ever writes the literal `<name>`, so a full-anchor test is
 * always false. The chat panel's glyph guard was exactly that, and the
 * suggestion held the turn's ✦ while the answer beneath it hung plain.
 */
export const SKILL_SUGGESTION_PREFIX = SKILL_SUGGESTION_ANCHOR.slice(0, SKILL_SUGGESTION_ANCHOR.indexOf("<name>"));

/**
 * The four fixed answer labels of a marketplace install offer. Every surface
 * that teaches or reads the offer (the marketplace-offer middleware, the
 * skills fragment, the context listing footer) cites these exact strings, so
 * the after_tool observer that records declines and runs consented installs
 * recognizes the operator's choice by label identity, never by paraphrase.
 */
export const SKILL_INSTALL_OFFER_OPTION_PROJECT = "Install for this project";
export const SKILL_INSTALL_OFFER_OPTION_USER = "Install globally";
export const SKILL_INSTALL_OFFER_OPTION_NOT_NOW = "Not now";
export const SKILL_INSTALL_OFFER_OPTION_NEVER = "Never offer this skill";
export const SKILL_INSTALL_OFFER_OPTIONS = [
	SKILL_INSTALL_OFFER_OPTION_PROJECT,
	SKILL_INSTALL_OFFER_OPTION_USER,
	SKILL_INSTALL_OFFER_OPTION_NOT_NOW,
	SKILL_INSTALL_OFFER_OPTION_NEVER,
] as const;

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
	/**
	 * True once this policy is a surface that outlived the turn that armed it.
	 * The narrowing is identical; the flag exists so a load request the policy
	 * does not cover reads as "only the operator activates skills" rather than
	 * claiming a pending request that no longer exists.
	 */
	carriedSurface?: boolean;
}

/**
 * The surface that stays armed after an interactive turn ends.
 *
 * A skill an operator loaded narrows the tools for the workflow it started,
 * and a multi-turn workflow (an interview skill asking a question per turn)
 * is still inside that workflow on the operator's next message. Dropping the
 * narrowing at turn end handed the workflow back the full surface partway
 * through, which is how a `bash` call correctly refused in turn one ran in
 * turn six. Returns undefined when nothing declared a narrowing, which is the
 * signal to clear whatever surface was armed before.
 */
export function armedSkillSurface(policy: PendingSkillToolPolicy | undefined): PendingSkillToolPolicy | undefined {
	if (!policy) return undefined;
	const declared = [...policy.loadedSkillPolicies.entries()].filter(
		([, declaration]) => (declaration.allowedTools?.length ?? 0) > 0 || (declaration.disallowedTools?.length ?? 0) > 0,
	);
	if (declared.length === 0) return undefined;
	return {
		allowedSkillNames: [...policy.allowedSkillNames],
		requests: [...policy.requests],
		loadedSkillNames: new Set(policy.loadedSkillNames),
		loadedSkillPolicies: new Map(declared),
		carriedSurface: true,
	};
}

/** Skill names contributing a declaration to an armed surface, for the operator notice. */
export function skillSurfaceNames(policy: PendingSkillToolPolicy | undefined): ReadonlyArray<string> {
	return policy ? [...policy.loadedSkillPolicies.keys()] : [];
}

/**
 * Tools admitted regardless of any active skill narrowing: context so the
 * remaining requested skills of the same turn can still load, and ask_user as
 * the escape hatch the block message points at when a workflow genuinely
 * needs a tool its skill did not declare.
 */
const SKILL_SURFACE_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["context", "ask_user"]);

export interface SkillToolSurfaceViolation {
	/** Every loaded skill that contributed a declaration to the merged surface. */
	skills: ReadonlyArray<string>;
	/** Merged allowed-tools union when allow-narrowing applies; null for a disallow hit. */
	mergedAllowedTools: ReadonlyArray<string> | null;
	/** Skills whose disallowed-tools name the tool directly. */
	disallowedBy: ReadonlyArray<string>;
	/** True when the surface outlived the turn that armed it, which changes the lifetime the block message states. */
	carriedSurface: boolean;
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
	const carriedSurface = policy.carriedSurface === true;
	const disallowedBy = entries
		.filter(([, declared]) => declared.disallowedTools?.includes(tool) === true)
		.map(([name]) => name);
	if (disallowedBy.length > 0) return { skills, mergedAllowedTools: null, disallowedBy, carriedSurface };
	const allowLists = entries.map(([, declared]) => declared.allowedTools);
	if (allowLists.some((list) => list === undefined || list.length === 0)) return null;
	const merged = [...new Set(allowLists.flatMap((list) => [...(list ?? [])]))];
	if (merged.includes(tool)) return null;
	return { skills, mergedAllowedTools: merged, disallowedBy: [], carriedSurface };
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
	/**
	 * Dispatch run whose worker performed this activation. Absent on
	 * main-agent activations; set when a dispatch completion folds a worker
	 * receipt's activations into the session ledger.
	 */
	runId?: string;
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

function skillActivationFromSource(
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
		(record.turnId === undefined || typeof record.turnId === "string") &&
		(record.runId === undefined || typeof record.runId === "string")
	);
}
