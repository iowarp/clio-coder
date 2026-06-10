export type SkillActivationTrigger = "slash-command" | "tool";
export type PendingSkillRequestSource = "slash-command" | "selector" | "marketplace";

export interface PendingSkillRequest {
	name: string;
	args: string;
	source: PendingSkillRequestSource;
	installed: boolean;
	filePath?: string;
	marketplaceRef?: string;
}

export interface PendingSkillToolPolicy {
	allowedSkillNames: ReadonlyArray<string>;
	requests: ReadonlyArray<PendingSkillRequest>;
	loadedSkillNames: Set<string>;
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
