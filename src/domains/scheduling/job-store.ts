import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import {
	JOB_HISTORY_LIMIT,
	JOB_SESSION_LIMIT,
	jobIsComplete,
	jobSpecHash,
	normalizeJobSpec,
	sameJobOwner,
} from "./job-model.js";
import type { JobCreateInput, JobOwner, JobRecord, JobStore } from "./job-types.js";

const STORE_MAX_BYTES = 8 * 1024 * 1024;
const RECORD_MAX_BYTES = 256 * 1024;
const validTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableTime = (value: unknown): boolean => value === null || validTime(value);
const obj = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Stored state is an execution boundary, not a trusted TypeScript cast (#411). */
function validateRecord(value: unknown, owner: JobOwner): asserts value is JobRecord {
	if (
		!obj(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		!/^job-[a-f0-9-]{36}$/.test(value.id) ||
		!obj(value.owner) ||
		!sameJobOwner(value.owner as unknown as JobOwner, owner) ||
		typeof value.owner.generation !== "string" ||
		!validTime(value.revision) ||
		!validTime(value.generation) ||
		!validTime(value.createdAt) ||
		!validTime(value.updatedAt) ||
		!["active", "paused", "terminal"].includes(String(value.state)) ||
		!obj(value.spec) ||
		!obj(value.process) ||
		!validTime(value.process.pid) ||
		typeof value.process.instanceId !== "string" ||
		!(value.process.birthToken === null || typeof value.process.birthToken === "string") ||
		!validTime(value.starts) ||
		!validTime(value.settled) ||
		!validTime(value.consecutiveFailures) ||
		!nullableTime(value.nextDueAt) ||
		typeof value.cancelRequested !== "boolean" ||
		!(
			value.costUsd === null ||
			(typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0)
		) ||
		!(value.pendingReason === null || typeof value.pendingReason === "string") ||
		!(value.persistenceError === null || typeof value.persistenceError === "string") ||
		!(
			value.reason === null ||
			["count", "condition", "stopped", "canceled", "deadline", "failure"].includes(String(value.reason))
		) ||
		!Array.isArray(value.history) ||
		value.history.length > JOB_HISTORY_LIMIT
	)
		throw new Error("job: malformed stored record");
	const spec = value.spec;
	const input: JobCreateInput = {
		intervalMs: spec.intervalMs as number,
		runner: spec.runner as JobCreateInput["runner"],
		timeoutMs: spec.timeoutMs as number,
		...(spec.count !== null ? { count: spec.count as number } : {}),
		...(spec.deadlineAt !== null ? { deadlineAt: spec.deadlineAt as number } : {}),
		...(spec.until !== null ? { until: spec.until as NonNullable<JobCreateInput["until"]> } : {}),
		onMatch: spec.onMatch as NonNullable<JobCreateInput["onMatch"]>,
		...(spec.constraints !== null ? { constraints: spec.constraints as NonNullable<JobCreateInput["constraints"]> } : {}),
		...(spec.originTurnId !== null ? { originTurnId: spec.originTurnId as string } : {}),
	};
	const normalized = normalizeJobSpec(input, value.createdAt);
	if (value.specHash !== jobSpecHash(normalized) || JSON.stringify(spec) !== JSON.stringify(normalized))
		throw new Error("job: stored specification failed integrity validation");
	const evidence = (v: unknown): boolean =>
		v === null ||
		(obj(v) &&
			["succeeded", "failed", "noop", "canceled", "timed_out", "interrupted"].includes(String(v.outcome)) &&
			typeof v.summary === "string" &&
			Buffer.byteLength(v.summary) <= 2052 &&
			typeof v.truncated === "boolean" &&
			typeof v.jsonComplete === "boolean" &&
			typeof v.cleanupUnresolved === "boolean" &&
			Array.isArray(v.evidenceRefs) &&
			v.evidenceRefs.length <= 8 &&
			v.evidenceRefs.every((ref) => typeof ref === "string") &&
			(v.costUsd === null || (typeof v.costUsd === "number" && Number.isFinite(v.costUsd) && v.costUsd >= 0)) &&
			(v.errorClass === null || ["infrastructure", "permission", "execution"].includes(String(v.errorClass))));
	const occurrence = (v: unknown): boolean =>
		obj(v) &&
		typeof v.id === "string" &&
		validTime(v.scheduledAt) &&
		nullableTime(v.startedAt) &&
		nullableTime(v.endedAt) &&
		["pending", "running", "terminal"].includes(String(v.state)) &&
		evidence(v.evidence);
	if (
		!value.history.every(occurrence) ||
		(value.active !== null && !occurrence(value.active)) ||
		(value.pending !== null && !occurrence(value.pending))
	)
		throw new Error("job: malformed stored occurrence");
	const d = value.delivery;
	if (
		d !== null &&
		(!obj(d) ||
			typeof d.id !== "string" ||
			typeof d.occurrenceId !== "string" ||
			!["notice", "main_turn"].includes(String(d.kind)) ||
			!["pending", "running", "delivered", "dropped", "failed"].includes(String(d.state)) ||
			!validTime(d.createdAt) ||
			!nullableTime(d.startedAt) ||
			!nullableTime(d.endedAt) ||
			!evidence(d.evidence) ||
			!(d.reason === null || typeof d.reason === "string"))
	)
		throw new Error("job: malformed stored delivery");
	if (Buffer.byteLength(JSON.stringify(value)) > RECORD_MAX_BYTES) throw new Error("job: stored record too large");
}

export function createJobStore(options: { rootDir?: string } = {}): JobStore {
	const root = options.rootDir ?? join(clioStateDir(), "jobs");
	const pathFor = (owner: JobOwner): string =>
		join(
			root,
			`${createHash("sha256")
				.update(JSON.stringify([owner.sessionId, owner.cwd]))
				.digest("hex")}.json`,
		);
	function read(owner: JobOwner): JobRecord[] {
		const path = pathFor(owner);
		let raw: string;
		try {
			if (statSync(path).size > STORE_MAX_BYTES) throw new Error("job: session store too large");
			raw = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const parsed: unknown = JSON.parse(raw);
		if (!obj(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > JOB_SESSION_LIMIT)
			throw new Error("job: malformed session store");
		const ids = new Set<string>();
		for (const record of parsed.jobs) {
			validateRecord(record, owner);
			if (ids.has(record.id)) throw new Error("job: duplicate stored identity");
			ids.add(record.id);
		}
		return parsed.jobs as JobRecord[];
	}
	return {
		list: read,
		write(record, expectedRevision) {
			validateRecord(record, record.owner);
			const path = pathFor(record.owner);
			withStateFileLockSync(
				path,
				() => {
					const rows = read(record.owner);
					const index = rows.findIndex((row) => row.id === record.id);
					const previous = rows[index];
					if (expectedRevision === null ? previous !== undefined : previous?.revision !== expectedRevision)
						throw new Error("job: concurrent state update; reload before control");
					if (record.revision !== (expectedRevision === null ? 0 : expectedRevision + 1))
						throw new Error("job: invalid revision");
					if (previous && (previous.specHash !== record.specHash || previous.createdAt !== record.createdAt))
						throw new Error("job: immutable specification changed");
					if (index >= 0) rows[index] = record;
					else {
						while (rows.length >= JOB_SESSION_LIMIT) {
							const oldest = rows.filter(jobIsComplete).sort((a, b) => a.updatedAt - b.updatedAt)[0];
							if (!oldest) throw new Error("job: session job capacity reached");
							rows.splice(rows.indexOf(oldest), 1);
						}
						rows.push(record);
					}
					const body = JSON.stringify({ version: 1, jobs: rows });
					if (Buffer.byteLength(body) > STORE_MAX_BYTES) throw new Error("job: session store too large");
					safeResourceWrite(path, body, { mode: 0o600 });
				},
				{ timeoutMs: 100 },
			);
		},
	};
}
