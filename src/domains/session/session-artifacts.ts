import { isAbsolute, relative, resolve } from "node:path";

export type SessionArtifactTool = "artifact" | "write" | "edit";
export type SessionArtifactKind = "plan" | "review" | "report";

export interface SessionArtifact {
	/** Path exactly as the successful tool result recorded it. */
	path: string;
	tool: SessionArtifactTool;
	artifactKind?: SessionArtifactKind;
	turnId: string;
	timestamp: string;
	/** Number of earlier successful writes to this normalized path. */
	overwrites: number;
}

export interface FoldSessionArtifactsOptions {
	/** Recorded session cwd. Paths outside this root are rejected. */
	workspace?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSessionArtifactTool(value: unknown): value is SessionArtifactTool {
	return value === "artifact" || value === "write" || value === "edit";
}

function isSessionArtifactKind(value: unknown): value is SessionArtifactKind {
	return value === "plan" || value === "review" || value === "report";
}

function normalizedWorkspacePath(path: string, workspace: string): string | null {
	const root = resolve(workspace);
	const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
	const rel = relative(root, target);
	if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return target;
	return null;
}

interface IndexedArtifact extends SessionArtifact {
	index: number;
}

/**
 * Fold durable tool-result facts into the files produced in one active-path
 * session. This function never stats or reads a path; missing files remain
 * visible facts and are handled by the `/view workspace` loader.
 */
export function foldSessionArtifacts(
	entries: ReadonlyArray<unknown>,
	options: FoldSessionArtifactsOptions = {},
): SessionArtifact[] {
	const workspace = resolve(options.workspace ?? process.cwd());
	const lastByPath = new Map<string, IndexedArtifact>();
	const writeCounts = new Map<string, number>();
	let writeIndex = 0;

	for (const raw of entries) {
		if (!isRecord(raw) || raw.kind !== "message" || raw.role !== "tool_result") continue;
		if (typeof raw.turnId !== "string" || typeof raw.timestamp !== "string") continue;
		const payload = raw.payload;
		if (!isRecord(payload) || !isSessionArtifactTool(payload.toolName)) continue;
		if (
			payload.isError === true ||
			payload.outcome === "error" ||
			payload.outcome === "blocked" ||
			payload.outcome === "aborted" ||
			payload.outcome === "orphaned"
		) {
			continue;
		}
		const result = payload.result;
		if (!isRecord(result) || !isRecord(result.details) || !Array.isArray(result.details.paths)) continue;
		const artifactKind =
			payload.toolName === "artifact" && isSessionArtifactKind(result.details.kind) ? result.details.kind : undefined;
		const pathsSeenInResult = new Set<string>();
		for (const recordedPath of result.details.paths) {
			if (typeof recordedPath !== "string" || recordedPath.trim().length === 0) continue;
			const normalized = normalizedWorkspacePath(recordedPath, workspace);
			if (normalized === null || pathsSeenInResult.has(normalized)) continue;
			pathsSeenInResult.add(normalized);
			const priorWrites = writeCounts.get(normalized) ?? 0;
			writeCounts.set(normalized, priorWrites + 1);
			writeIndex += 1;
			lastByPath.set(normalized, {
				path: recordedPath,
				tool: payload.toolName,
				...(artifactKind ? { artifactKind } : {}),
				turnId: raw.turnId,
				timestamp: raw.timestamp,
				overwrites: priorWrites,
				index: writeIndex,
			});
		}
	}

	return [...lastByPath.values()]
		.sort((left, right) => right.index - left.index)
		.map(({ index: _index, ...artifact }) => artifact);
}

/** Resolve a recorded, already-validated artifact path for loading. */
export function resolveSessionArtifactPath(path: string, workspace: string): string | null {
	return normalizedWorkspacePath(path, workspace);
}
