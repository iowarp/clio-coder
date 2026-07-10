import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { ProjectType } from "../session/workspace/project-type.js";
import type { AdoptionProvider, AdoptionScope, AdoptionSourceKind, AdoptionSourceSnapshot } from "./adoption.js";
import type { Fingerprint } from "./fingerprint.js";

export type BootstrapGenerationMode = "scout" | "heuristic" | "existing";

export type BootstrapParserOutcome = "parsed" | "rejected" | "not-run";

export interface BootstrapGenerationState {
	mode: BootstrapGenerationMode;
	parserOutcome: BootstrapParserOutcome;
	fallbackReason?: string;
	runId?: string;
	targetId?: string;
	wireModelId?: string;
	runtimeId?: string;
	runtimeKind?: string;
	tokenCount?: number;
	toolCalls?: number;
	durationMs?: number;
	promptBytes?: number;
	outputBytes?: number;
}

export interface ClioProjectState {
	version: 1;
	projectType?: ProjectType;
	fingerprint: Fingerprint;
	bootstrapFingerprint?: Fingerprint;
	lastBootstrap?: BootstrapGenerationState;
	codewikiVersion?: number;
	contextSources?: AdoptionSourceSnapshot[];
	contextSourceHash?: string;
	lastInitAt?: string;
	lastSessionAt?: string;
	lastIndexedAt?: string;
}

const STATE_RELATIVE_PATH = ".clio/state.json";

const BOOTSTRAP_GENERATION_MODES = new Set<BootstrapGenerationMode>(["scout", "heuristic", "existing"]);
const BOOTSTRAP_PARSER_OUTCOMES = new Set<BootstrapParserOutcome>(["parsed", "rejected", "not-run"]);
const BOOTSTRAP_FALLBACK_REASON_MAX_LENGTH = 4096;
const BOOTSTRAP_GENERATION_KEYS = new Set([
	"mode",
	"parserOutcome",
	"fallbackReason",
	"runId",
	"targetId",
	"wireModelId",
	"runtimeId",
	"runtimeKind",
	"tokenCount",
	"toolCalls",
	"durationMs",
	"promptBytes",
	"outputBytes",
]);
const BOOTSTRAP_ID_KEYS = ["runId", "targetId", "wireModelId", "runtimeId", "runtimeKind"] as const;
const BOOTSTRAP_COUNTER_KEYS = ["tokenCount", "toolCalls", "durationMs", "promptBytes", "outputBytes"] as const;

function isBoundedNonemptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isBootstrapGenerationState(value: unknown): value is BootstrapGenerationState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (!Object.keys(obj).every((key) => BOOTSTRAP_GENERATION_KEYS.has(key))) return false;
	if (typeof obj.mode !== "string" || !BOOTSTRAP_GENERATION_MODES.has(obj.mode as BootstrapGenerationMode)) {
		return false;
	}
	if (
		typeof obj.parserOutcome !== "string" ||
		!BOOTSTRAP_PARSER_OUTCOMES.has(obj.parserOutcome as BootstrapParserOutcome)
	) {
		return false;
	}
	if (
		obj.fallbackReason !== undefined &&
		!isBoundedNonemptyString(obj.fallbackReason, BOOTSTRAP_FALLBACK_REASON_MAX_LENGTH)
	) {
		return false;
	}
	for (const key of BOOTSTRAP_ID_KEYS) {
		if (obj[key] !== undefined && !isNonemptyString(obj[key])) return false;
	}
	for (const key of BOOTSTRAP_COUNTER_KEYS) {
		if (obj[key] !== undefined && (!Number.isSafeInteger(obj[key]) || (obj[key] as number) < 0)) return false;
	}
	return true;
}

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
const ADOPTION_PROVIDERS = new Set<AdoptionProvider>([
	"claude-code",
	"agents",
	"codex",
	"gemini",
	"cursor",
	"copilot",
	"opencode",
]);
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
		/^[0-9a-f]{64}$/.test(obj.sha256) &&
		(obj.status === undefined || obj.status === "accepted" || obj.status === "rejected") &&
		(obj.reason === undefined || isBoundedNonemptyString(obj.reason, 256)) &&
		(obj.status !== "rejected" || typeof obj.reason === "string")
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
	if ("lastBootstrap" in obj && obj.lastBootstrap !== undefined && !isBootstrapGenerationState(obj.lastBootstrap)) {
		return false;
	}
	if (
		"codewikiVersion" in obj &&
		obj.codewikiVersion !== undefined &&
		(typeof obj.codewikiVersion !== "number" || !Number.isInteger(obj.codewikiVersion) || obj.codewikiVersion < 1)
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
	safeResourceWrite(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8" });
}
