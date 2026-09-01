import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { type ExecutionRole, isExecutionRole } from "./execution-role.js";
import { type RouteCandidate, routeCapabilityKey, routeDriftGuard, routeDriftInvalidates } from "./route-decision.js";
import type { RouteQualityLabel } from "./route-quality.js";
import type { RunPhaseDurations } from "./types.js";

export type RouteReliabilityOutcome = "success" | "failure" | "neutral";

/** One reconstructable, terminal observation for a concrete route identity. */
export interface RouteHistoryRecord {
	version: 3;
	receiptDigest: string;
	assignmentId: string;
	route: RouteCandidate;
	executionRole: ExecutionRole;
	qualityLabel: RouteQualityLabel;
	reliability: RouteReliabilityOutcome;
	/** Assignment-level observation; retries are never independent first-pass work. */
	firstPass: boolean;
	/** Only completed, non-quality-failed work may contribute timing or cost. */
	completedCostUsd: number | null;
	completedPhaseTiming: RunPhaseDurations | null;
	/** Whether the completed route consumed cache tokens for this exact identity. */
	cacheRead: boolean;
	sourceDigests: string[];
	settledAt: string;
}

export interface RouteHistoryStore {
	recordsFor(route: RouteCandidate): ReadonlyArray<RouteHistoryRecord>;
	all(): ReadonlyArray<RouteHistoryRecord>;
	upsert(record: RouteHistoryRecord): "inserted" | "updated" | "duplicate";
}

export interface CreateRouteHistoryStoreOptions {
	stateDir?: string;
	maxRecords?: number;
}

/** The one supported durable format. Earlier files are retired, never read. */
export const ROUTE_HISTORY_VERSION = 3;

const DEFAULT_MAX_RECORDS = 4096;

function historyPath(stateDir: string): string {
	return join(stateDir, "route-history.json");
}

function clone(record: RouteHistoryRecord): RouteHistoryRecord {
	return structuredClone(record);
}

function compareRecords(left: RouteHistoryRecord, right: RouteHistoryRecord): number {
	return left.settledAt.localeCompare(right.settledAt) || left.receiptDigest.localeCompare(right.receiptDigest);
}

function validateRecord(value: unknown): RouteHistoryRecord {
	if (!isRecord(value) || value.version !== ROUTE_HISTORY_VERSION)
		throw new Error("route history record has unsupported version");
	if (!isDigest(value.receiptDigest)) throw new Error("route history receipt digest invalid");
	if (typeof value.assignmentId !== "string" || value.assignmentId.length === 0)
		throw new Error("route history assignment id invalid");
	if (!isRouteCandidate(value.route)) throw new Error("route history route invalid");
	if (!isExecutionRole(value.executionRole)) throw new Error("route history execution role invalid");
	if (value.qualityLabel !== "pass" && value.qualityLabel !== "fail" && value.qualityLabel !== "unmeasured") {
		throw new Error("route history quality label invalid");
	}
	if (value.reliability !== "success" && value.reliability !== "failure" && value.reliability !== "neutral") {
		throw new Error("route history reliability invalid");
	}
	if (typeof value.firstPass !== "boolean") throw new Error("route history first-pass state invalid");
	if (
		value.completedCostUsd !== null &&
		(typeof value.completedCostUsd !== "number" || !Number.isFinite(value.completedCostUsd))
	) {
		throw new Error("route history completed cost invalid");
	}
	if (value.completedPhaseTiming !== null && !isPhaseTiming(value.completedPhaseTiming)) {
		throw new Error("route history phase timing invalid");
	}
	if (typeof value.cacheRead !== "boolean") throw new Error("route history cache affinity invalid");
	if (!Array.isArray(value.sourceDigests) || !value.sourceDigests.every(isDigest)) {
		throw new Error("route history source digests invalid");
	}
	if (typeof value.settledAt !== "string" || !Number.isFinite(Date.parse(value.settledAt))) {
		throw new Error("route history settlement timestamp invalid");
	}
	return {
		version: 3,
		receiptDigest: value.receiptDigest,
		assignmentId: value.assignmentId,
		route: { ...value.route },
		executionRole: value.executionRole,
		qualityLabel: value.qualityLabel,
		reliability: value.reliability,
		firstPass: value.firstPass,
		completedCostUsd: value.completedCostUsd,
		completedPhaseTiming: value.completedPhaseTiming === null ? null : { ...value.completedPhaseTiming },
		cacheRead: value.cacheRead,
		sourceDigests: [...value.sourceDigests].sort(),
		settledAt: value.settledAt,
	};
}

function readHistory(path: string): RouteHistoryRecord[] {
	if (!existsSync(path)) return [];
	const raw = readFileSync(path, "utf8").trim();
	if (raw.length === 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(`route history unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.records)) throw new Error("route history has unsupported format");
	if (parsed.version !== ROUTE_HISTORY_VERSION) {
		// Reject rather than migrate, per the plan's durable-format rule. A
		// retired file is renamed aside instead of crashing every dispatch until
		// an operator clears it by hand: nothing is read from it, and the
		// evidence it holds was gathered under semantics this version does not
		// share, so carrying it forward would be the actual data loss.
		retireHistory(path, parsed.version);
		return [];
	}
	return parsed.records.map(validateRecord).sort(compareRecords);
}

function retireHistory(path: string, version: unknown): void {
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d+Z$/u, "Z");
	const retired = `${path}.v${String(version)}.${stamp}.retired`;
	renameSync(path, retired);
	process.stderr.write(
		`[clio-coder:dispatch] route history v${String(version)} is retired; starting empty at v${ROUTE_HISTORY_VERSION}. Prior observations: ${retired}\n`,
	);
}

function writeHistory(path: string, records: ReadonlyArray<RouteHistoryRecord>): void {
	atomicWrite(
		path,
		JSON.stringify({ version: ROUTE_HISTORY_VERSION, records: [...records].sort(compareRecords) }, null, 2),
	);
}

/**
 * Durable bounded history. Upserts are keyed by terminal receipt digest, so a
 * later authenticated gate/eval source refines the same sample instead of
 * double-counting it. Replaying an unchanged source set is idempotent.
 */
export function createRouteHistoryStore(options: CreateRouteHistoryStoreOptions = {}): RouteHistoryStore {
	const path = historyPath(options.stateDir ?? clioStateDir());
	const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
	let records = readHistory(path);

	const reload = (): void => {
		records = readHistory(path);
	};

	return {
		recordsFor(route) {
			const key = routeCapabilityKey(route);
			const current = routeDriftGuard(route);
			return records
				.filter(
					(record) =>
						routeCapabilityKey(record.route) === key && !routeDriftInvalidates(routeDriftGuard(record.route), current),
				)
				.map(clone);
		},
		all() {
			return records.map(clone);
		},
		upsert(input) {
			const record = validateRecord(input);
			return withStateFileLockSync(path, () => {
				reload();
				const index = records.findIndex((entry) => entry.receiptDigest === record.receiptDigest);
				if (index >= 0) {
					const existing = records[index];
					if (JSON.stringify(existing) === JSON.stringify(record)) return "duplicate";
					records[index] = record;
					writeHistory(path, records.slice(-maxRecords));
					records = records.slice(-maxRecords);
					return "updated";
				}
				records = [...records, record].sort(compareRecords).slice(-maxRecords);
				writeHistory(path, records);
				return "inserted";
			});
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isRouteCandidate(value: unknown): value is RouteCandidate {
	if (!isRecord(value)) return false;
	if (!isExecutionRole(value.executionRole)) return false;
	return [
		value.agentId,
		value.specFingerprint,
		value.targetId,
		value.modelId,
		value.runtimeId,
		value.nodeId,
		value.toolSignature,
		value.promptCompositionHash,
		value.endpointIdentityHash,
		value.settingsFingerprint,
	].every((field) => typeof field === "string");
}

function isPhaseTiming(value: unknown): value is RunPhaseDurations {
	if (!isRecord(value)) return false;
	return [
		"requestToDecisionMs",
		"decisionMs",
		"admissionWaitMs",
		"queueWaitMs",
		"spawnSetupMs",
		"timeToFirstModelTokenMs",
		"timeToFirstToolMs",
		"executionMs",
		"totalEndToEndMs",
	].every((field) => value[field] === null || (typeof value[field] === "number" && Number.isFinite(value[field])));
}
