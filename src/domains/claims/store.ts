import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clioProjectRoot } from "../../core/project-root.js";
import { fsyncDirectory } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import { claimRecordId } from "./capture.js";
import { claimLogRecordId, deriveClaimEdges } from "./edges.js";
import {
	type CheckRun,
	deriveHypothesisRecords,
	deriveHypothesisTests,
	type HypothesisDraft,
	hypothesesNameCheck,
} from "./hypotheses.js";
import {
	CLAIM_KINDS,
	CLAIM_RECORD_VERSION,
	type ClaimEdgeRecord,
	type ClaimRecord,
	type ClaimRegressionRecord,
	type HypothesisRecord,
	type HypothesisTestRecord,
} from "./types.js";

/**
 * The claims log: `<stateDir>/claims/<sha256(project root)>.jsonl`, one record per line, append-only (#406).
 *
 * The project root is the realpath of the enclosing repository root, the key workspace trust already uses
 * (`clioProjectRoot` over the realpath), so a session in a subdirectory reads and writes the same log and no fourth
 * project key exists. The log lives in Clio's state directory rather than the repository, so a cloned repository
 * cannot ship claims, the same reason trust records and session ledgers live there.
 *
 * A line is appended in place under the file's state lock and fsynced, the way the fleet event journal appends. A
 * whole-file `safeResourceWrite` per claim would make every capture cost the size of the log; an append cannot lose an
 * earlier line, and a line torn by a crash is skipped on read and closed off by the next append.
 *
 * Five line types share the log: `claim`, `edge`, `regression`, `hypothesis` and `hypothesis-test`. Edges, hypothesis
 * revisions and hypothesis tests are derived from the log as it stands under the same lock that appends them, so two
 * sessions capturing at once derive against each other's records.
 */

export function claimsProjectRoot(cwd: string): string {
	const absolute = resolve(cwd);
	let physical = absolute;
	try {
		physical = realpathSync(absolute);
	} catch {
		// A cwd that no longer resolves keeps its lexical form; it still keys one log consistently.
	}
	return clioProjectRoot(physical);
}

export function claimsLogPath(projectRoot: string): string {
	return join(clioStateDir(), "claims", `${createHash("sha256").update(projectRoot, "utf8").digest("hex")}.jsonl`);
}

/** Write lines to the end of a log under its lock; `lines` sees the log as it stands once the lock is held. */
async function appendLines(path: string, lines: (current: string) => string[]): Promise<void> {
	const dir = dirname(path);
	const created = !existsSync(dir);
	mkdirSync(dir, { recursive: true });
	await withStateFileLock(path, () => {
		const fd = openSync(path, "a+", 0o600);
		try {
			const current = readFileSync(fd, "utf8");
			const next = lines(current);
			if (next.length === 0) return;
			// A line torn by a crash is closed off, so the append starts a line of its own.
			const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
			writeSync(fd, `${prefix}${next.join("\n")}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	});
	if (created) fsyncDirectory(dir);
}

/**
 * Append claims to their project's log, each followed by the edges it adds against the log (#406). Records for several
 * projects are grouped per log. Returns the edges written.
 */
export async function appendClaims(records: ReadonlyArray<ClaimRecord>): Promise<ClaimEdgeRecord[]> {
	const byProject = new Map<string, ClaimRecord[]>();
	for (const record of records) byProject.set(record.project, [...(byProject.get(record.project) ?? []), record]);
	const written: ClaimEdgeRecord[] = [];
	for (const [project, group] of byProject) {
		await appendLines(claimsLogPath(project), (current) => {
			const log = parseClaimsLog(current, project);
			const lines: string[] = [];
			const history = { claims: [...log.records], edges: [...log.edges] };
			for (const claim of group) {
				const edges = deriveClaimEdges(history, [claim]);
				lines.push(JSON.stringify(claim), ...edges.map((edge) => JSON.stringify(edge)));
				history.claims.push(claim);
				history.edges.push(...edges);
				written.push(...edges);
			}
			return lines;
		});
	}
	return written;
}

/** Append regression records, which name what a contradiction did to memory, to their project's log. */
export async function appendClaimRegressions(records: ReadonlyArray<ClaimRegressionRecord>): Promise<void> {
	const byProject = new Map<string, ClaimRegressionRecord[]>();
	for (const record of records) byProject.set(record.project, [...(byProject.get(record.project) ?? []), record]);
	for (const [project, group] of byProject)
		await appendLines(claimsLogPath(project), () => group.map((record) => JSON.stringify(record)));
}

/**
 * Append the hypotheses one slate write holds (#406): an unchanged entry adds nothing, a changed one adds a record
 * revising the latest earlier one. Returns the records written.
 */
export async function appendHypotheses(
	project: string,
	drafts: ReadonlyArray<HypothesisDraft>,
): Promise<HypothesisRecord[]> {
	const written: HypothesisRecord[] = [];
	if (drafts.length === 0) return written;
	await appendLines(claimsLogPath(project), (current) => {
		const added = deriveHypothesisRecords(parseClaimsLog(current, project).hypotheses, drafts);
		written.push(...added);
		return added.map((record) => JSON.stringify(record));
	});
	return written;
}

/**
 * Append a test record for each current hypothesis whose criterion names a check that ran (#406). The log is read
 * once without the lock first, so a check no hypothesis names never takes it. Returns the records written.
 */
export async function appendHypothesisTests(
	project: string,
	runs: ReadonlyArray<CheckRun>,
): Promise<HypothesisTestRecord[]> {
	const written: HypothesisTestRecord[] = [];
	if (runs.length === 0) return written;
	const checks = runs.map((run) => run.check);
	if (!hypothesesNameCheck(readClaims(project).hypotheses, checks)) return written;
	await appendLines(claimsLogPath(project), (current) => {
		const added = deriveHypothesisTests(parseClaimsLog(current, project).hypotheses, runs);
		written.push(...added);
		return added.map((record) => JSON.stringify(record));
	});
	return written;
}

export interface ClaimsLogRead {
	project: string;
	path: string;
	records: ClaimRecord[];
	edges: ClaimEdgeRecord[];
	regressions: ClaimRegressionRecord[];
	hypotheses: HypothesisRecord[];
	hypothesisTests: HypothesisTestRecord[];
	/** Lines that are not a JSON object, such as a line torn by a crash. */
	unreadable: number;
	/** Records whose id does not match their content, or that name another project: edited after capture. */
	mismatched: number;
	/** Records of a version this build does not read. */
	unknownVersion: number;
}

function isClaimRecord(value: Record<string, unknown>): boolean {
	return (
		value.type === "claim" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.text === "string" &&
		typeof value.subject === "string" &&
		CLAIM_KINDS.some((kind) => kind === value.kind) &&
		(value.verdict === "agrees" || value.verdict === "disagrees") &&
		typeof value.conditions === "object" &&
		value.conditions !== null &&
		typeof value.source === "object" &&
		value.source !== null &&
		typeof value.keys === "object" &&
		value.keys !== null
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEdgeRecord(value: Record<string, unknown>): boolean {
	return (
		value.type === "edge" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		(value.kind === "contradicts" || value.kind === "supersedes") &&
		typeof value.from === "string" &&
		typeof value.to === "string" &&
		typeof value.check === "string"
	);
}

function isRegressionRecord(value: Record<string, unknown>): boolean {
	return (
		value.type === "regression" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.edge === "string" &&
		typeof value.from === "string" &&
		isStringArray(value.backing) &&
		isStringArray(value.memory)
	);
}

function isHypothesisRecord(value: Record<string, unknown>): boolean {
	const criterion = value.criterion as Record<string, unknown> | null | undefined;
	return (
		value.type === "hypothesis" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.slate === "string" &&
		typeof value.hypothesis === "string" &&
		typeof value.statement === "string" &&
		typeof value.prediction === "string" &&
		typeof value.subject === "string" &&
		value.evidence === "proposed" &&
		typeof criterion === "object" &&
		criterion !== null &&
		typeof criterion.kind === "string" &&
		typeof value.source === "object" &&
		value.source !== null
	);
}

function isHypothesisTestRecord(value: Record<string, unknown>): boolean {
	return (
		value.type === "hypothesis-test" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.hypothesis === "string" &&
		typeof value.check === "string" &&
		(value.outcome === "tested" || value.outcome === "supported" || value.outcome === "refuted") &&
		// Only a judged claim supports or refutes; a record saying otherwise was not written by this ledger.
		(value.outcome === "tested") === (value.claim === undefined) &&
		(value.claim === undefined || typeof value.claim === "string") &&
		typeof value.execution === "string" &&
		typeof value.source === "object" &&
		value.source !== null
	);
}

function parseClaimsLog(text: string, projectRoot: string): ClaimsLogRead {
	const read: ClaimsLogRead = {
		project: projectRoot,
		path: claimsLogPath(projectRoot),
		records: [],
		edges: [],
		regressions: [],
		hypotheses: [],
		hypothesisTests: [],
		unreadable: 0,
		mismatched: 0,
		unknownVersion: 0,
	};
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			read.unreadable += 1;
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			read.unreadable += 1;
			continue;
		}
		const record = value as Record<string, unknown>;
		if (record.v !== CLAIM_RECORD_VERSION) {
			read.unknownVersion += 1;
			continue;
		}
		if (isClaimRecord(record)) {
			const claim = record as unknown as ClaimRecord;
			if (claim.project !== projectRoot || claimRecordId(claim) !== claim.id) read.mismatched += 1;
			else read.records.push(claim);
			continue;
		}
		if (isEdgeRecord(record) || isRegressionRecord(record)) {
			if (record.project !== projectRoot || claimLogRecordId(record) !== record.id) read.mismatched += 1;
			else if (record.type === "edge") read.edges.push(record as unknown as ClaimEdgeRecord);
			else read.regressions.push(record as unknown as ClaimRegressionRecord);
			continue;
		}
		if (isHypothesisRecord(record) || isHypothesisTestRecord(record)) {
			if (record.project !== projectRoot || claimLogRecordId(record) !== record.id) read.mismatched += 1;
			else if (record.type === "hypothesis") read.hypotheses.push(record as unknown as HypothesisRecord);
			else read.hypothesisTests.push(record as unknown as HypothesisTestRecord);
			continue;
		}
		read.unreadable += 1;
	}
	return read;
}

/** Every claim, edge and regression in a project's log, oldest first. A missing log reads as empty. */
export function readClaims(projectRoot: string): ClaimsLogRead {
	let text: string;
	try {
		text = readFileSync(claimsLogPath(projectRoot), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseClaimsLog("", projectRoot);
		throw error;
	}
	return parseClaimsLog(text, projectRoot);
}
