import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioStateDir } from "../../core/xdg.js";
import { INTEROP_AGENT_KINDS } from "./registry.js";
import type { InteropAgentId, InteropAgentRecord, InteropDecision, InteropPresence, InteropReport } from "./types.js";

const KNOWN_IDS = new Set<string>(INTEROP_AGENT_KINDS.map((kind) => kind.id));
const PRESENCES = new Set<string>(["present", "absent", "unknown"]);

export function interopStatePath(): string {
	return path.join(clioStateDir(), "interop.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function countField(raw: Record<string, unknown>, key: string): number {
	const value = raw[key];
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function presenceField(raw: Record<string, unknown>, key: string): InteropPresence | undefined {
	const value = raw[key];
	return typeof value === "string" && PRESENCES.has(value) ? (value as InteropPresence) : undefined;
}

function parseAgent(raw: unknown): InteropAgentRecord | null {
	if (!isRecord(raw)) return null;
	const kind = stringField(raw, "kind");
	const fingerprint = stringField(raw, "fingerprint");
	const presence = presenceField(raw, "presence");
	if (kind === undefined || !KNOWN_IDS.has(kind) || fingerprint === undefined || presence === undefined) return null;
	const decision = stringField(raw, "decision");
	const adapter = presenceField(raw, "adapter");
	const binary = stringField(raw, "binary");
	const version = stringField(raw, "version");
	const installDir = stringField(raw, "installDir");
	const decidedAt = stringField(raw, "decidedAt");
	const decidedFingerprint = stringField(raw, "decidedFingerprint");
	const hintedFingerprint = stringField(raw, "hintedFingerprint");
	return {
		kind: kind as InteropAgentId,
		presence,
		fingerprint,
		skillCount: countField(raw, "skillCount"),
		projectArtifacts: countField(raw, "projectArtifacts"),
		...(binary !== undefined ? { binary } : {}),
		...(version !== undefined ? { version } : {}),
		...(installDir !== undefined ? { installDir } : {}),
		...(adapter !== undefined ? { adapter } : {}),
		...(decision === "accepted" || decision === "declined" ? { decision: decision as InteropDecision } : {}),
		...(decidedAt !== undefined ? { decidedAt } : {}),
		...(decidedFingerprint !== undefined ? { decidedFingerprint } : {}),
		...(hintedFingerprint !== undefined ? { hintedFingerprint } : {}),
	};
}

/**
 * The last recorded report, or null when there is none. A file this version
 * cannot parse is the same answer as no file: interop degrades to proposing
 * nothing rather than acting on a half-read decision record.
 */
export function readInteropReport(): InteropReport | null {
	let filePath: string;
	try {
		filePath = interopStatePath();
	} catch {
		return null;
	}
	if (!existsSync(filePath)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isRecord(parsed) || parsed.version !== 1) return null;
		const detectedAt = stringField(parsed, "detectedAt");
		if (detectedAt === undefined || !Array.isArray(parsed.agents)) return null;
		const agents = parsed.agents.map(parseAgent).filter((agent): agent is InteropAgentRecord => agent !== null);
		return { version: 1, detectedAt, agents };
	} catch {
		return null;
	}
}

export function writeInteropReport(report: InteropReport): void {
	safeResourceWrite(interopStatePath(), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
}
