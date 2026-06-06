export type SkillActivationTrigger = "slash-command" | "tool";

export interface SkillActivation {
	name: string;
	filePath: string;
	hash: string;
	source: string;
	triggeredBy: SkillActivationTrigger;
	turnId?: string;
}

export interface SkillActivationSource {
	name: string;
	filePath: string;
	hash: string;
	source: string;
}

function trimmedString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function skillActivationFromSource(
	source: SkillActivationSource,
	triggeredBy: SkillActivationTrigger,
	turnId?: string,
): SkillActivation {
	return {
		name: source.name,
		filePath: source.filePath,
		hash: source.hash,
		source: source.source,
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
	if (!name || !filePath || !hash || !source) return null;
	return skillActivationFromSource({ name, filePath, hash, source }, "tool", turnId);
}

export function isSkillActivation(value: unknown): value is SkillActivation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.name === "string" &&
		typeof record.filePath === "string" &&
		typeof record.hash === "string" &&
		typeof record.source === "string" &&
		(record.triggeredBy === "slash-command" || record.triggeredBy === "tool") &&
		(record.turnId === undefined || typeof record.turnId === "string")
	);
}
