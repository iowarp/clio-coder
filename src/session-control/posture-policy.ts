import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import { isAutonomyLevel } from "../domains/safety/autonomy.js";
import type { SessionEntry } from "../domains/session/entries.js";

export const POSTURE_GENERATION = "clio_coder_posture_generation";
export const POSTURE_UPDATE = "clio_coder_posture_update";

export interface PostureGeneration {
	version: 1;
	origin: "host";
	id: string;
	checkpointId: string | null;
	routeKey: string;
	compiledAutonomy: AutonomyLevel;
	memorySection: string;
	promptHash: string;
}

export interface PostureUpdate {
	version: 1;
	origin: "host";
	generationId: string;
	userTurnId: string;
	autonomy: AutonomyLevel;
	text: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readPostureUpdate(entry: SessionEntry): PostureUpdate | null {
	if (entry.kind !== "custom" || entry.customType !== POSTURE_UPDATE) return null;
	const data = entry.data;
	return record(data) &&
		data.version === 1 &&
		data.origin === "host" &&
		typeof data.generationId === "string" &&
		typeof data.userTurnId === "string" &&
		isAutonomyLevel(data.autonomy) &&
		typeof data.text === "string"
		? (data as unknown as PostureUpdate)
		: null;
}

export function postureCheckpoint(entries: ReadonlyArray<SessionEntry>): string | null {
	return [...entries].reverse().find((entry) => entry.kind === "compactionSummary")?.turnId ?? null;
}

/** Only posture and memory are frozen; source changes still invalidate the prompt hash (#423). */
export function readPostureGeneration(entries: ReadonlyArray<SessionEntry>): PostureGeneration | null {
	const checkpointId = postureCheckpoint(entries);
	for (const entry of [...entries].reverse()) {
		if (entry.kind !== "custom" || entry.customType !== POSTURE_GENERATION) continue;
		const data = entry.data;
		if (
			!record(data) ||
			data.version !== 1 ||
			data.origin !== "host" ||
			typeof data.id !== "string" ||
			data.checkpointId !== checkpointId ||
			typeof data.routeKey !== "string" ||
			!isAutonomyLevel(data.compiledAutonomy) ||
			typeof data.memorySection !== "string" ||
			typeof data.promptHash !== "string" ||
			!/^[a-f0-9]{64}$/u.test(data.promptHash)
		)
			continue;
		return data as unknown as PostureGeneration;
	}
	return null;
}

export function effectivePosture(entries: ReadonlyArray<SessionEntry>, generation: PostureGeneration): AutonomyLevel {
	let level = generation.compiledAutonomy;
	for (const entry of entries) {
		const update = readPostureUpdate(entry);
		if (update?.generationId === generation.id) level = update.autonomy;
	}
	return level;
}
