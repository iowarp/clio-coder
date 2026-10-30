import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeDiagnostic } from "../../core/diagnostics.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { type ExecutionRole, isExecutionRole } from "./execution-role.js";
import { type RouteCandidate, routeCapabilityKey, routeDriftGuard, routeDriftInvalidates } from "./route-decision.js";
import type { RouteQualityLabel } from "./route-quality.js";
import type { RunReceipt } from "./types.js";

export type RouteReliabilityOutcome = "success" | "failure" | "neutral";

/**
 * The run's settled outcome as its receipt states it: `success`, or the most
 * specific failure class the receipt carries (an outcome code such as
 * `worker_tool_call_cap_exhausted`, `permission_required`, a non-generic
 * outcome such as `timed_out`), else `failure`. Quality labels stay reserved
 * for independent evidence; this label is what every settled route carries.
 */
export function routeSettledLabel(receipt: Pick<RunReceipt, "outcome" | "outcomeCode" | "outcomeDetail">): string {
	if (receipt.outcome === "succeeded") return "success";
	if (receipt.outcomeCode !== undefined && receipt.outcomeCode !== null) return receipt.outcomeCode;
	if (/^permission_required(?:;|$)/u.test(receipt.outcomeDetail ?? "")) return "permission_required";
	return receipt.outcome === "failed" ? "failure" : receipt.outcome;
}

/** One reconstructable, terminal observation for a concrete route identity. */
/**
 * The persisted phase-timing shape of a version 3 route history record. Route
 * policy reads `queueWaitMs` and `totalEndToEndMs`; the other seven keys are
 * written as null so records stay valid for readers that require all nine.
 */
export interface RouteHistoryPhaseTiming {
	requestToDecisionMs: number | null;
	decisionMs: number | null;
	admissionWaitMs: number | null;
	queueWaitMs: number | null;
	spawnSetupMs: number | null;
	timeToFirstModelTokenMs: number | null;
	timeToFirstToolMs: number | null;
	executionMs: number | null;
	totalEndToEndMs: number | null;
}

export interface RouteHistoryRecord {
	version: 4;
	receiptDigest: string;
	assignmentId: string;
	route: RouteCandidate;
	executionRole: ExecutionRole;
	qualityLabel: RouteQualityLabel;
	reliability: RouteReliabilityOutcome;
	/** `routeSettledLabel` of the settling receipt; absent only on records written before it existed. */
	settled?: string;
	/** Assignment-level observation; retries are never independent first-pass work. */
	firstPass: boolean;
	/** Only completed, non-quality-failed work may contribute timing or cost. */
	completedCostUsd: number | null;
	completedPhaseTiming: RouteHistoryPhaseTiming | null;
	/** Whether the completed route consumed cache tokens for this exact identity. */
	cacheRead: boolean | null;
	/** Whether pricing covers the whole run, only a known subtotal, or cannot be established (#434). */
	pricedCoverage: "complete" | "partial" | "unknown";
	sourceDigests: string[];
	settledAt: string;
}

export type LegacyRouteHistoryRecord = Omit<RouteHistoryRecord, "version" | "cacheRead" | "pricedCoverage"> & {
	version: 3;
	cacheRead: boolean;
};

export interface RouteHistoryStore {
	recordsFor(route: RouteCandidate): ReadonlyArray<RouteHistoryRecord>;
	all(): ReadonlyArray<RouteHistoryRecord>;
	health(): { skipped: number; writable: boolean };
	upsert(record: RouteHistoryRecord): "inserted" | "updated" | "duplicate";
}

export interface CreateRouteHistoryStoreOptions {
	stateDir?: string;
	maxRecords?: number;
}

/** New writes use v4; v3 is read conservatively and unsupported stores stay untouched (#434). */
export const ROUTE_HISTORY_VERSION = 4;

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

function validateRecord(value: unknown, allowLegacy = false): RouteHistoryRecord {
	if (!isRecord(value) || (value.version !== ROUTE_HISTORY_VERSION && !(allowLegacy && value.version === 3)))
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
	if (value.settled !== undefined && (typeof value.settled !== "string" || !/^[a-z][a-z_-]*$/u.test(value.settled))) {
		throw new Error("route history settled label invalid");
	}
	if (typeof value.firstPass !== "boolean") throw new Error("route history first-pass state invalid");
	if (
		value.completedCostUsd !== null &&
		(typeof value.completedCostUsd !== "number" || !Number.isFinite(value.completedCostUsd) || value.completedCostUsd < 0)
	) {
		throw new Error("route history completed cost invalid");
	}
	if (value.completedPhaseTiming !== null && !isPhaseTiming(value.completedPhaseTiming)) {
		throw new Error("route history phase timing invalid");
	}
	if (typeof value.cacheRead !== "boolean" && !(value.version === 4 && value.cacheRead === null))
		throw new Error("route history cache affinity invalid");
	if (
		value.version === 4 &&
		value.pricedCoverage !== "complete" &&
		value.pricedCoverage !== "partial" &&
		value.pricedCoverage !== "unknown"
	)
		throw new Error("route history pricing coverage invalid");
	if (!Array.isArray(value.sourceDigests) || !value.sourceDigests.every(isDigest)) {
		throw new Error("route history source digests invalid");
	}
	if (typeof value.settledAt !== "string" || !Number.isFinite(Date.parse(value.settledAt))) {
		throw new Error("route history settlement timestamp invalid");
	}
	return {
		version: 4,
		receiptDigest: value.receiptDigest,
		assignmentId: value.assignmentId,
		route: { ...value.route },
		executionRole: value.executionRole,
		qualityLabel: value.qualityLabel,
		reliability: value.reliability,
		...(typeof value.settled === "string" ? { settled: value.settled } : {}),
		firstPass: value.firstPass,
		// Old zero costs could be adapter placeholders. An authenticated receipt can restore measured zero (#434).
		completedCostUsd: value.version === 3 && value.completedCostUsd === 0 ? null : value.completedCostUsd,
		completedPhaseTiming: value.completedPhaseTiming === null ? null : { ...value.completedPhaseTiming },
		cacheRead: value.version === 3 ? (value.cacheRead === true ? true : null) : value.cacheRead,
		pricedCoverage: value.version === 3 ? "unknown" : (value.pricedCoverage as RouteHistoryRecord["pricedCoverage"]),
		sourceDigests: [...value.sourceDigests].sort(),
		settledAt: value.settledAt,
	};
}

interface HistoryRead {
	records: RouteHistoryRecord[];
	writable: boolean;
	skipped: number;
	/** Why an older file is still in place: it could not be set aside (#434). */
	retireError?: string;
}

function readHistory(path: string): HistoryRead {
	const empty = { records: [], writable: true, skipped: 0 };
	if (!existsSync(path)) return empty;
	const raw = readFileSync(path, "utf8").trim();
	if (raw.length === 0) return empty;
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed) || !Array.isArray(parsed.records)) throw new Error("route history has unsupported format");
	// An older format was retired by 0.6.5 too: set it aside and keep learning. A newer file belongs to another
	// installation, so it is preserved and this version writes nothing over it (R12, #434).
	if (typeof parsed.version === "number" && parsed.version < 3) {
		const retireError = retireHistory(path, parsed.version);
		return retireError === null
			? empty
			: { records: [], writable: false, skipped: Math.max(1, parsed.records.length), retireError };
	}
	if (parsed.version !== 3 && parsed.version !== ROUTE_HISTORY_VERSION)
		return { records: [], writable: false, skipped: Math.max(1, parsed.records.length) };
	const records: RouteHistoryRecord[] = [];
	let skipped = 0;
	for (const value of parsed.records) {
		try {
			records.push(validateRecord(value, true));
		} catch {
			skipped += 1;
		} // Preserve records this reader cannot interpret on the next write, too (#434).
	}
	return { records: records.sort(compareRecords), writable: skipped === 0, skipped };
}

function retireHistory(path: string, version: number): string | null {
	const stamp = new Date()
		.toISOString()
		.replace(/[-:]/gu, "")
		.replace(/\.\d+Z$/u, "Z");
	const retired = `${path}.v${version}.${stamp}.retired`;
	try {
		renameSync(path, retired);
	} catch (error) {
		// A sibling process set the same file aside first.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		// Windows refuses to rename a file another process holds open. The store keeps serving with the old file
		// preserved and unwritten, and a later read sets it aside (#434).
		return error instanceof Error ? error.message : String(error);
	}
	writeDiagnostic(
		`[clio-coder:dispatch] route history v${version} is retired; starting empty at v${ROUTE_HISTORY_VERSION}. Prior observations: ${retired}\n`,
	);
	return null;
}

/** Inode, size and mtime; every write is tmp-and-rename, so a rewrite always moves it. */
function fileIdentity(path: string): string {
	try {
		const stats = statSync(path);
		return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
	} catch {
		return "missing";
	}
}

function writeHistory(path: string, records: ReadonlyArray<RouteHistoryRecord>): void {
	safeResourceWrite(
		path,
		JSON.stringify({ version: ROUTE_HISTORY_VERSION, records: [...records].sort(compareRecords) }, null, 2),
	);
}

/**
 * Durable bounded history. Upserts are keyed by terminal receipt digest, so a
 * later authenticated gate source refines the same sample instead of
 * double-counting it. Replaying an unchanged source set is idempotent.
 */
export function createRouteHistoryStore(options: CreateRouteHistoryStoreOptions = {}): RouteHistoryStore {
	const path = historyPath(options.stateDir ?? clioStateDir());
	const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
	let snapshot = readHistory(path);
	let records = snapshot.records;
	let loaded = fileIdentity(path);
	let reportedUnwritable = false;
	// A preserved file this version cannot write silently stops route learning; say so once (#434).
	const reportUnwritable = (): void => {
		if (snapshot.writable || reportedUnwritable) return;
		reportedUnwritable = true;
		if (snapshot.retireError !== undefined) {
			writeDiagnostic(
				`[clio-coder:dispatch] route history ${path} is an older format that could not be set aside (${snapshot.retireError}); it is preserved unchanged and no new route observations are written until it is moved aside\n`,
			);
			return;
		}
		writeDiagnostic(
			`[clio-coder:dispatch] route history ${path} holds ${snapshot.skipped} record(s) this version does not read; it is preserved unchanged and no new route observations are written until it is moved aside\n`,
		);
	};
	reportUnwritable();

	const reload = (): void => {
		snapshot = readHistory(path);
		records = snapshot.records;
		loaded = fileIdentity(path);
		reportUnwritable();
	};
	// Other Clio processes append to the same file. Reads pick up their writes
	// when the file's identity moved, which costs one stat per read.
	const refresh = (): void => {
		if (fileIdentity(path) === loaded) return;
		try {
			reload();
		} catch {
			// An unreadable rewrite keeps the last good view; the next upsert
			// reloads under the lock and reports the error there.
		}
	};

	return {
		health() {
			refresh();
			return { skipped: snapshot.skipped, writable: snapshot.writable };
		},
		recordsFor(route) {
			refresh();
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
			refresh();
			return records.map(clone);
		},
		upsert(input) {
			const record = validateRecord(input);
			return withStateFileLockSync(path, () => {
				reload();
				if (!snapshot.writable) throw new Error("route history contains unsupported records; preserving existing file");
				const index = records.findIndex((entry) => entry.receiptDigest === record.receiptDigest);
				if (index >= 0) {
					const existing = records[index];
					if (JSON.stringify(existing) === JSON.stringify(record)) return "duplicate";
					records[index] = record;
					writeHistory(path, records.slice(-maxRecords));
					records = records.slice(-maxRecords);
					loaded = fileIdentity(path);
					return "updated";
				}
				records = [...records, record].sort(compareRecords).slice(-maxRecords);
				writeHistory(path, records);
				loaded = fileIdentity(path);
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

function isPhaseTiming(value: unknown): value is RouteHistoryPhaseTiming {
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
