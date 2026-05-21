import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectType } from "../session/workspace/project-type.js";
import type { AdoptionProvider, AdoptionScope, AdoptionSourceKind, AdoptionSourceSnapshot } from "./adoption.js";
import type { Fingerprint } from "./fingerprint.js";

export interface ClioProjectState {
	version: 1;
	projectType?: ProjectType;
	fingerprint: Fingerprint;
	bootstrapFingerprint?: Fingerprint;
	contextSources?: AdoptionSourceSnapshot[];
	contextSourceHash?: string;
	lastInitAt?: string;
	lastSessionAt?: string;
	lastIndexedAt?: string;
}

const STATE_RELATIVE_PATH = ".clio/state.json";

function isFingerprint(value: unknown): value is Fingerprint {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.treeHash === "string" &&
		/^[0-9a-f]{64}$/.test(obj.treeHash) &&
		(typeof obj.gitHead === "string" || obj.gitHead === null) &&
		typeof obj.loc === "number" &&
		Number.isInteger(obj.loc) &&
		obj.loc >= 0
	);
}

const ADOPTION_SCOPES = new Set<AdoptionScope>(["project", "global"]);
const ADOPTION_PROVIDERS = new Set<AdoptionProvider>(["claude-code", "codex", "gemini", "cursor", "copilot"]);
const ADOPTION_KINDS = new Set<AdoptionSourceKind>(["instructions", "settings", "command", "agent", "skill", "rule"]);

function isContextSourceSnapshot(value: unknown): value is AdoptionSourceSnapshot {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.path === "string" &&
		obj.path.length > 0 &&
		typeof obj.scope === "string" &&
		ADOPTION_SCOPES.has(obj.scope as AdoptionScope) &&
		typeof obj.provider === "string" &&
		ADOPTION_PROVIDERS.has(obj.provider as AdoptionProvider) &&
		typeof obj.kind === "string" &&
		ADOPTION_KINDS.has(obj.kind as AdoptionSourceKind) &&
		typeof obj.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(obj.sha256)
	);
}

function isProjectState(value: unknown): value is ClioProjectState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (obj.version !== 1 || !isFingerprint(obj.fingerprint)) return false;
	if (
		"bootstrapFingerprint" in obj &&
		obj.bootstrapFingerprint !== undefined &&
		!isFingerprint(obj.bootstrapFingerprint)
	) {
		return false;
	}
	if ("contextSources" in obj && obj.contextSources !== undefined) {
		if (!Array.isArray(obj.contextSources) || !obj.contextSources.every(isContextSourceSnapshot)) return false;
	}
	if (
		"contextSourceHash" in obj &&
		obj.contextSourceHash !== undefined &&
		(typeof obj.contextSourceHash !== "string" || !/^[0-9a-f]{64}$/.test(obj.contextSourceHash))
	) {
		return false;
	}
	return true;
}

export function statePath(cwd: string): string {
	return join(cwd, STATE_RELATIVE_PATH);
}

export function readClioState(cwd: string): ClioProjectState | null {
	const filePath = statePath(cwd);
	if (!existsSync(filePath)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
	return isProjectState(parsed) ? parsed : null;
}

export function writeClioState(cwd: string, state: ClioProjectState): void {
	const filePath = statePath(cwd);
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = join(dirname(filePath), `.state-${process.pid}-${randomUUID()}.tmp`);
	writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(tmpPath, filePath);
}
