import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type CanonicalCheckout, canonicalCheckout, linkedWorktreeRoots } from "../../core/project-root.js";
import { fsyncDirectory, safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { containsInstructionMarkers } from "../../core/untrusted-content.js";
import { clioStateDir } from "../../core/xdg.js";
import { claimRecordId } from "./capture.js";
import {
	type ClaimEdgeState,
	type ClaimEdgeSubject,
	claimEdgeSubject,
	claimLogRecordId,
	deriveClaimEdgesFrom,
	foldSweepRunLayout,
	type SweepRunLayout,
} from "./edges.js";
import {
	type CheckRun,
	deriveHypothesisRecords,
	deriveHypothesisTests,
	type HypothesisDraft,
	hypothesisSubject,
} from "./hypotheses.js";
import {
	type CheckRunIdentity,
	type CheckStartRecord,
	CLAIM_KINDS,
	CLAIM_RECORD_VERSION,
	type ClaimDisputeRecord,
	type ClaimEdgeRecord,
	type ClaimImportRecord,
	type ClaimRecord,
	type ClaimRegressionRecord,
	type ClaimSource,
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
 * Six line types share the log: `claim`, `edge`, `regression`, `hypothesis`, `check-start` and `hypothesis-test`.
 * Edges, hypothesis revisions, check starts and hypothesis tests are derived from the log as it stands under the same
 * lock that appends them, so two sessions capturing at once derive against each other's records.
 */

/**
 * The project key a session at `cwd` reads and writes claims under: the canonical project root (`canonicalCheckout`),
 * so a subdirectory, a symlinked path and a linked worktree of one repository share the main checkout's log, the key
 * memory uses too (#406).
 */
export function claimsProjectRoot(cwd: string): string {
	return canonicalCheckout(cwd).project;
}

/**
 * Where a capture at `cwd` may record, or null when it may not (#406). A checkout whose `.git` pointer claims a linked
 * worktree its main repository does not record back is forged: it could otherwise write into another project's log,
 * so nothing is recorded there. Every other checkout, and a directory outside any repository, records under its key.
 */
export function claimsCaptureCheckout(cwd: string): CanonicalCheckout | null {
	const checkout = canonicalCheckout(cwd);
	return checkout.trusted ? checkout : null;
}

/** The linked worktree a capture ran in, for `ClaimRecord.worktree`; undefined in the main checkout. */
export function captureWorktree(checkout: CanonicalCheckout): string | undefined {
	return checkout.linked ? checkout.checkout : undefined;
}

export function claimsLogPath(projectRoot: string): string {
	return join(clioStateDir(), "claims", `${createHash("sha256").update(projectRoot, "utf8").digest("hex")}.jsonl`);
}

/** A sibling of the log: `<digest>.<suffix>`. */
function siblingPath(logPath: string, suffix: string): string {
	return logPath.replace(/\.jsonl$/u, `.${suffix}`);
}

export function claimsIndexPath(projectRoot: string): string {
	return siblingPath(claimsLogPath(projectRoot), "index.json");
}

/**
 * The most bytes one log line may hold. Every record is bounded by capture, so a longer line is damage or a writer
 * bug: it is never appended, and on read it counts as unreadable without being parsed.
 */
export const CLAIMS_LOG_LINE_MAX_BYTES = 64 * 1024;

function withinLineBound(line: string): boolean {
	return line.length <= CLAIMS_LOG_LINE_MAX_BYTES && Buffer.byteLength(line, "utf8") <= CLAIMS_LOG_LINE_MAX_BYTES;
}

/**
 * The most claims one project's log holds before recording evicts (MEM-3). A claim is never refused, and a live claim,
 * one a regression, hypothesis test or contradiction names, or one a memory record cites is never evicted: only
 * superseded claims nothing names go, oldest first, down to `CLAIMS_LOG_EVICT_TO`, with the edges pointing at them. Evicted
 * lines move to `<digest>.evicted.jsonl`; nothing is deleted. A log that cannot get under the cap tries again each
 * `CLAIMS_LOG_EVICT_STEP` claims past it, so an append never pays a rewrite every time.
 */
export const CLAIMS_LOG_MAX_CLAIMS = 4096;
const CLAIMS_LOG_EVICT_TO = 3072;
const CLAIMS_LOG_EVICT_STEP = 1024;

/** Whether an append taking the log from `before` to `after` claims crosses the cap, or another step past it. */
function crossesClaimsCap(before: number, after: number): boolean {
	const step = (count: number) =>
		count <= CLAIMS_LOG_MAX_CLAIMS ? -1 : Math.floor((count - CLAIMS_LOG_MAX_CLAIMS - 1) / CLAIMS_LOG_EVICT_STEP);
	return step(after) > step(before);
}

/** Where claims evicted past the cap are kept, beside the log. */
function claimsEvictedPath(projectRoot: string): string {
	return siblingPath(claimsLogPath(projectRoot), "evicted.jsonl");
}

/** How many claims the cap evicted from a project's log, and where they are kept; null when none was. */
export function claimsEvicted(projectRoot: string): { claims: number; path: string } | null {
	const path = claimsEvictedPath(projectRoot);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let claims = 0;
	for (const line of text.split("\n")) {
		if (!withinLineBound(line)) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isObject(value) && value.type === "claim") claims += 1;
		} catch {
			// An empty or torn line counts for nothing.
		}
	}
	return claims > 0 ? { claims, path } : null;
}

/**
 * The append path's index (#406): `<digest>.index.json` beside the log, a cache of exactly what appending needs, so an
 * append reads the index and the lines written since it, never the whole log.
 *
 * - The edge state: each live claim as a subject (`ClaimEdgeSubject`), the superseded set and the sweep run layouts.
 *   A claim stays live while nothing superseded it or while it is the latest claim of its check, run and pinned
 *   conditions, which is all `deriveClaimEdges` ever matches against; older ones are dropped from the index, not the log.
 * - The contradictions still waiting for their regression line, so `recordClaims` reads the whole log only then.
 * - The current hypothesis revision of each slate entry and recent check starts, for `appendCheckStarts`.
 *
 * It is valid while the log still holds the bytes it was built from: `logBytes` is not past the end and the digest of
 * the bytes just before `logBytes` matches. An append by an older build is then folded in from `logBytes`; a log that
 * was rewritten (compaction) or damaged rebuilds the index from a full read, the cost every append paid before. The
 * index is a cache: deleting it is always safe.
 */
const CLAIMS_INDEX_VERSION = 1;
const INDEX_TAIL_BYTES = 4096;
/** Claim ids kept beyond the live subjects, so an append retried after it landed derives nothing again. */
const INDEX_RECENT_IDS = 512;
/** Check-start run identities kept, so a run that starts twice keeps its first binding. */
const INDEX_RECENT_STARTS = 512;
/**
 * Log records an index may lag behind before an append that adds only empty check starts checkpoints it. Every verify
 * call starts its checks, almost always with no hypothesis to bind, and rewriting the whole index for each such line
 * costs more than folding a short tail on the next load (`loadIndex`). Any other record checkpoints at once.
 */
export const CLAIMS_INDEX_CHECKPOINT_LAG = 32;

interface ClaimsIndexFile {
	v: typeof CLAIMS_INDEX_VERSION;
	project: string;
	logBytes: number;
	tail: string;
	/** Claim lines in the log, for the count cap; repeats count until a rewrite drops them. */
	claims: number;
	subjects: ClaimEdgeSubject[];
	superseded: string[];
	layouts: Array<[string, SweepRunLayout | null]>;
	recent: string[];
	pending: string[];
	hypotheses: Array<{ key: string; id: string; subject: string; check?: string }>;
	starts: Array<[string, string[]]>;
}

interface ClaimsIndex {
	claims: number;
	edges: ClaimEdgeState;
	recent: string[];
	pending: Set<string>;
	hypotheses: Map<string, { id: string; subject: string; check?: string }>;
	starts: Map<string, string[]>;
	/** Log records folded in past the index file's `logBytes` on load; zero for a rebuilt index. Not persisted. */
	lag: number;
}

function emptyIndex(): ClaimsIndex {
	return {
		claims: 0,
		edges: { subjects: [], superseded: new Set(), layouts: new Map(), known: new Set() },
		recent: [],
		pending: new Set(),
		hypotheses: new Map(),
		starts: new Map(),
		lag: 0,
	};
}

function sha256Bytes(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function readRange(fd: number, start: number, end: number): Buffer {
	const length = Math.max(0, end - start);
	const buffer = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const got = readSync(fd, buffer, read, length - read, start + read);
		if (got === 0) break;
		read += got;
	}
	return buffer.subarray(0, read);
}

function tailDigest(fd: number, logBytes: number): string {
	return sha256Bytes(readRange(fd, Math.max(0, logBytes - INDEX_TAIL_BYTES), logBytes));
}

/** Fold one parsed line into the index, as a full read would admit it. Idempotent for lines it already holds. */
function foldIndexLine(index: ClaimsIndex, project: string, value: Record<string, unknown>): void {
	if (value.v !== CLAIM_RECORD_VERSION || value.project !== project || typeof value.id !== "string") return;
	if (isClaimRecord(value)) {
		const claim = value as unknown as ClaimRecord;
		if (claimRecordId(claim) !== claim.id) return;
		index.claims += 1;
		if (claim.evidence !== "grounded" || !isCheckSource(claim.source)) return;
		foldSweepRunLayout(index.edges.layouts, claim);
		if (index.edges.known.has(claim.id)) return;
		index.edges.subjects.push(claimEdgeSubject(claim));
		index.edges.known.add(claim.id);
		index.recent.push(claim.id);
		return;
	}
	if (claimLogRecordId(value) !== value.id) return;
	if (isEdgeRecord(value)) {
		const edge = value as unknown as ClaimEdgeRecord;
		if (edge.kind === "supersedes") index.edges.superseded.add(edge.to);
		else if (index.edges.subjects.find((subject) => subject.id === edge.from)?.verdict === "disagrees")
			index.pending.add(edge.id);
		return;
	}
	if (isRegressionRecord(value)) {
		index.pending.delete(value.edge as string);
		return;
	}
	if (isHypothesisRecord(value)) {
		const record = value as unknown as HypothesisRecord;
		if (hypothesisSubject(record) !== record.subject) return;
		const key = `${record.slate}\0${record.hypothesis}`;
		const current = index.hypotheses.get(key);
		if (
			current === undefined
				? record.revises !== undefined
				: record.revises !== current.id || current.subject === record.subject
		)
			return;
		index.hypotheses.set(key, {
			id: record.id,
			subject: record.subject,
			...(record.criterion.check !== undefined ? { check: record.criterion.check } : {}),
		});
		return;
	}
	if (isCheckStartRecord(value)) {
		const start = value as unknown as CheckStartRecord;
		const key = runKey(start.run, start.check);
		if (!index.starts.has(key)) index.starts.set(key, [...start.hypotheses]);
	}
}

function foldIndexText(index: ClaimsIndex, project: string, text: string): number {
	let records = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		records += 1;
		if (!withinLineBound(line)) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isObject(value)) foldIndexLine(index, project, value);
		} catch {
			// A torn or foreign line: a full read counts it as unreadable, and it carries nothing an append needs.
		}
	}
	return records;
}

function indexFromRead(read: ClaimsLogRead): ClaimsIndex {
	const index = emptyIndex();
	index.claims = read.records.length;
	for (const claim of read.records) {
		foldSweepRunLayout(index.edges.layouts, claim);
		index.edges.subjects.push(claimEdgeSubject(claim));
		index.edges.known.add(claim.id);
		index.recent.push(claim.id);
	}
	const verdicts = new Map(read.records.map((claim) => [claim.id, claim.verdict]));
	for (const edge of read.edges) {
		if (edge.kind === "supersedes") index.edges.superseded.add(edge.to);
		else if (verdicts.get(edge.from) === "disagrees") index.pending.add(edge.id);
	}
	for (const regression of read.regressions) index.pending.delete(regression.edge);
	for (const record of read.hypotheses)
		index.hypotheses.set(`${record.slate}\0${record.hypothesis}`, {
			id: record.id,
			subject: record.subject,
			...(record.criterion.check !== undefined ? { check: record.criterion.check } : {}),
		});
	for (const start of read.checkStarts) {
		const key = runKey(start.run, start.check);
		if (!index.starts.has(key)) index.starts.set(key, [...start.hypotheses]);
	}
	return index;
}

/**
 * Superseded claims of one check kept as contradiction candidates, newest first. A new claim contradicts the latest
 * earlier claim with equal pins, so a superseded claim matters again only when a check returns to old conditions
 * (rerun at an older commit); this many recent pin sets cover that, and the index stays bounded per check.
 */
const INDEX_SUPERSEDED_PER_CHECK = 8;

/**
 * Drop what no later append can match: superseded subjects past the latest of their pins, and past the newest few
 * per check; the oldest recent ids and starts past their caps.
 */
function pruneIndex(index: ClaimsIndex): void {
	const subjects = index.edges.subjects;
	const pinsKey = (subject: ClaimEdgeSubject) =>
		`${subject.kind}\0${subject.keys.check}\0${subject.keys.run ?? ""}\0${subject.pins ?? subject.id}`;
	const checkKey = (subject: ClaimEdgeSubject) => `${subject.kind}\0${subject.keys.check}\0${subject.keys.run ?? ""}`;
	const latest = new Map<string, number>();
	for (const [position, subject] of subjects.entries()) latest.set(pinsKey(subject), position);
	const keptPerCheck = new Map<string, number>();
	const keep = new Set<number>();
	for (let position = subjects.length - 1; position >= 0; position--) {
		const subject = subjects[position];
		if (subject === undefined) continue;
		if (!index.edges.superseded.has(subject.id)) {
			keep.add(position);
			continue;
		}
		if (latest.get(pinsKey(subject)) !== position) continue;
		const kept = keptPerCheck.get(checkKey(subject)) ?? 0;
		if (kept >= INDEX_SUPERSEDED_PER_CHECK) continue;
		keptPerCheck.set(checkKey(subject), kept + 1);
		keep.add(position);
	}
	index.edges.subjects = subjects.filter((_subject, position) => keep.has(position));
	const live = new Set(index.edges.subjects.map((subject) => subject.id));
	index.edges.superseded = new Set([...index.edges.superseded].filter((id) => live.has(id)));
	index.recent = index.recent.slice(-INDEX_RECENT_IDS);
	index.edges.known = new Set([...live, ...index.recent]);
	while (index.starts.size > INDEX_RECENT_STARTS) {
		const [oldest] = index.starts.keys();
		if (oldest === undefined) break;
		index.starts.delete(oldest);
	}
}

function loadIndex(project: string, fd: number, size: number): ClaimsIndex | null {
	let file: ClaimsIndexFile;
	try {
		file = JSON.parse(readFileSync(claimsIndexPath(project), "utf8")) as ClaimsIndexFile;
	} catch {
		// Missing or damaged: rebuilt from a full read.
		return null;
	}
	if (
		!isObject(file) ||
		file.v !== CLAIMS_INDEX_VERSION ||
		file.project !== project ||
		typeof file.logBytes !== "number" ||
		file.logBytes > size ||
		typeof file.claims !== "number" ||
		!Array.isArray(file.subjects) ||
		!Array.isArray(file.superseded) ||
		!Array.isArray(file.layouts) ||
		!Array.isArray(file.recent) ||
		!Array.isArray(file.pending) ||
		!Array.isArray(file.hypotheses) ||
		!Array.isArray(file.starts) ||
		tailDigest(fd, file.logBytes) !== file.tail
	)
		return null;
	const index: ClaimsIndex = {
		claims: file.claims,
		edges: {
			subjects: file.subjects,
			superseded: new Set(file.superseded),
			layouts: new Map(file.layouts),
			known: new Set([...file.subjects.map((subject) => subject.id), ...file.recent]),
		},
		recent: file.recent,
		pending: new Set(file.pending),
		hypotheses: new Map(file.hypotheses.map(({ key, ...rest }) => [key, rest])),
		starts: new Map(file.starts),
		lag: 0,
	};
	// Lines appended after the index was written: empty check starts this build left unindexed, an older build's lines,
	// or an append whose checkpoint a crash cut short.
	if (size > file.logBytes)
		index.lag = foldIndexText(index, project, readRange(fd, file.logBytes, size).toString("utf8"));
	return index;
}

/** Whether a line this build appends is a check start that bound no hypothesis, the record most verify calls add. */
function isEmptyCheckStartLine(line: string): boolean {
	try {
		const value: unknown = JSON.parse(line);
		return (
			isObject(value) && value.type === "check-start" && Array.isArray(value.hypotheses) && value.hypotheses.length === 0
		);
	} catch {
		return false;
	}
}

function writeIndex(project: string, index: ClaimsIndex, fd: number, size: number): void {
	pruneIndex(index);
	const file: ClaimsIndexFile = {
		v: CLAIMS_INDEX_VERSION,
		project,
		logBytes: size,
		tail: tailDigest(fd, size),
		claims: index.claims,
		subjects: index.edges.subjects,
		superseded: [...index.edges.superseded],
		layouts: [...index.edges.layouts],
		recent: index.recent,
		pending: [...index.pending],
		hypotheses: [...index.hypotheses].map(([key, value]) => ({ key, ...value })),
		starts: [...index.starts],
	};
	try {
		safeResourceWrite(claimsIndexPath(project), `${JSON.stringify(file)}\n`, { mode: 0o600 });
	} catch {
		// The index is a cache; the next append rebuilds it from the log.
	}
}

interface AppendContext {
	/** The index as of the log's current end, held under the lock. */
	index: ClaimsIndex;
	/** The whole log, parsed once on first use. Only writers that need history beyond the index call it. */
	full: () => ClaimsLogRead;
}

/** Bytes appended through `appendLines` that read the whole log, counted for the index contract (#406). */
let fullReadsForTest = 0;
export function claimsFullReadCount(): number {
	return fullReadsForTest;
}

/**
 * Write lines to the end of a project's log under its lock. `lines` sees the index, and the whole log on request, as
 * they stand once the lock is held. A line over the bound is dropped. Returns the index after the append.
 */
async function appendLines(project: string, lines: (context: AppendContext) => string[]): Promise<ClaimsIndex> {
	const path = claimsLogPath(project);
	const dir = dirname(path);
	const created = !existsSync(dir);
	mkdirSync(dir, { recursive: true });
	let result: ClaimsIndex = emptyIndex();
	await withStateFileLock(path, () => {
		const fd = openSync(path, "a+", 0o600);
		try {
			const size = fstatSync(fd).size;
			let full: ClaimsLogRead | undefined;
			const readFull = (): ClaimsLogRead => {
				if (full === undefined) {
					fullReadsForTest += 1;
					full = parseClaimsLog(readRange(fd, 0, size).toString("utf8"), project);
				}
				return full;
			};
			const loaded = loadIndex(project, fd, size);
			const index = loaded ?? indexFromRead(readFull());
			result = index;
			const next = lines({ index, full: readFull }).filter(withinLineBound);
			if (next.length === 0) return;
			// A line torn by a crash is closed off, so the append starts a line of its own.
			const torn = size > 0 && readRange(fd, size - 1, size).toString("utf8") !== "\n";
			writeSync(fd, `${torn ? "\n" : ""}${next.join("\n")}\n`);
			fsyncSync(fd);
			const lag = index.lag + foldIndexText(index, project, next.join("\n"));
			// Empty check starts leave the index lagging, up to a bound; the next load folds them back in (C-36).
			if (loaded !== null && lag < CLAIMS_INDEX_CHECKPOINT_LAG && next.every(isEmptyCheckStartLine)) return;
			writeIndex(project, index, fd, fstatSync(fd).size);
		} finally {
			closeSync(fd);
		}
	});
	if (created) fsyncDirectory(dir);
	return result;
}

/**
 * Append claims to their project's log, each followed by the edges it adds against the log (#406). Records for several
 * projects are grouped per log. Edges are derived from the log's index, so an append costs the claims of the check it
 * touches, not the log. Returns the edges written, per project the contradictions still awaiting a regression, and
 * the projects whose log this append took past the claim cap (`evictClaimsPastCap`).
 */
async function appendClaimsIndexed(
	records: ReadonlyArray<ClaimRecord>,
): Promise<{ edges: ClaimEdgeRecord[]; pending: Map<string, string[]>; overCap: string[] }> {
	const byProject = new Map<string, ClaimRecord[]>();
	for (const record of records) byProject.set(record.project, [...(byProject.get(record.project) ?? []), record]);
	const written: ClaimEdgeRecord[] = [];
	const pending = new Map<string, string[]>();
	const overCap: string[] = [];
	for (const [project, group] of byProject) {
		let claimsBefore = 0;
		const index = await appendLines(project, ({ index }) => {
			claimsBefore = index.claims;
			const lines: string[] = [];
			for (const claim of group) {
				// Checked here, not only in appendLines, so an unwritten claim derives no edges.
				if (!withinLineBound(JSON.stringify(claim))) continue;
				const edges = deriveClaimEdgesFrom(index.edges, [claim]);
				lines.push(JSON.stringify(claim), ...edges.map((edge) => JSON.stringify(edge)));
				written.push(...edges);
			}
			return lines;
		});
		pending.set(project, [...index.pending]);
		if (crossesClaimsCap(claimsBefore, index.claims)) overCap.push(project);
	}
	return { edges: written, pending, overCap };
}

/**
 * Evict, under the log's lock, the oldest superseded claims nothing names down to `CLAIMS_LOG_EVICT_TO` (MEM-3).
 * `cited` holds the claim ids memory records cite, which stay like any claim the log itself names; the caller reads
 * memory, so a caller that cannot must not evict. Returns how many claims were evicted.
 */
export async function evictClaimsPastCap(project: string, cited: ReadonlySet<string>): Promise<number> {
	const path = claimsLogPath(project);
	if (!existsSync(path)) return 0;
	let evicted = 0;
	await withStateFileLock(path, () => {
		evicted = rewriteLogLocked(project, { cited }, emptyCompaction(path, false), CLAIMS_LOG_EVICT_TO);
	});
	return evicted;
}

export async function appendClaims(records: ReadonlyArray<ClaimRecord>): Promise<ClaimEdgeRecord[]> {
	return (await appendClaimsIndexed(records)).edges;
}

/** `appendClaims`, also returning the contradictions of each project that still await a regression line. */
export { appendClaimsIndexed };

/** Append regression records, which name what a contradiction did to memory, to their project's log. */
export async function appendClaimRegressions(records: ReadonlyArray<ClaimRegressionRecord>): Promise<void> {
	const byProject = new Map<string, ClaimRegressionRecord[]>();
	for (const record of records) byProject.set(record.project, [...(byProject.get(record.project) ?? []), record]);
	for (const [project, group] of byProject)
		await appendLines(project, () => group.map((record) => JSON.stringify(record)));
}

/**
 * Append the hypotheses one slate write holds (#406): an unchanged entry adds nothing, a changed one adds a record
 * revising the latest earlier one. `stillCurrent` runs once the log's lock is held and refuses the whole append when
 * it answers false, so a capture whose slate changed after it was read never revises the record of newer bytes.
 * Returns the records written, or null when `stillCurrent` refused.
 */
export async function appendHypotheses(
	project: string,
	drafts: ReadonlyArray<HypothesisDraft>,
	stillCurrent?: () => boolean,
): Promise<HypothesisRecord[] | null> {
	const written: HypothesisRecord[] = [];
	if (drafts.length === 0) return written;
	let refused = false;
	await appendLines(project, ({ full }) => {
		if (stillCurrent !== undefined && !stillCurrent()) {
			refused = true;
			return [];
		}
		const added = deriveHypothesisRecords(full().hypotheses, drafts);
		written.push(...added);
		return added.map((record) => JSON.stringify(record));
	});
	return refused ? null : written;
}

/**
 * Bind a run's checks to the hypothesis revisions they test, as the run starts (#406). Under the log's lock, each check
 * gets a check-start record listing the current revisions that name it, and the same lists are returned for the
 * producer to test once the check finished; replay admits a test only for a revision its run's start record lists. A
 * check no hypothesis names is still started, with an empty list: its run's identity is then taken, so a start written
 * for it later, once a hypothesis naming the check appeared, is a second start and binds nothing. A run already bound
 * keeps its first binding.
 */
export async function appendCheckStarts(
	project: string,
	run: CheckRunIdentity,
	checks: ReadonlyArray<string>,
	at: string,
): Promise<Map<string, string[]>> {
	const bindings = new Map<string, string[]>();
	const wanted = new Set(checks);
	if (wanted.size === 0) return bindings;
	await appendLines(project, ({ index }) => {
		const lines: string[] = [];
		for (const check of wanted) {
			const earlier = index.starts.get(runKey(run, check));
			if (earlier !== undefined) {
				bindings.set(check, [...earlier]);
				continue;
			}
			// The current revision of each slate entry whose criterion names the check, from the index.
			const hypotheses = [...index.hypotheses.values()].filter((current) => current.check === check).map(({ id }) => id);
			const body: Omit<CheckStartRecord, "id"> = {
				v: CLAIM_RECORD_VERSION,
				type: "check-start",
				at,
				project,
				check,
				run,
				hypotheses,
			};
			lines.push(JSON.stringify({ ...body, id: claimLogRecordId(body) }));
			bindings.set(check, hypotheses);
		}
		return lines;
	});
	return bindings;
}

/** Append a test record for each hypothesis a check run was bound to when it started (#406). Returns the records written. */
export async function appendHypothesisTests(
	project: string,
	runs: ReadonlyArray<CheckRun>,
): Promise<HypothesisTestRecord[]> {
	const written: HypothesisTestRecord[] = [];
	if (!runs.some((run) => run.hypotheses.length > 0)) return written;
	await appendLines(project, ({ full }) => {
		const added = deriveHypothesisTests(full().hypotheses, runs);
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
	checkStarts: CheckStartRecord[];
	hypothesisTests: HypothesisTestRecord[];
	/** Worker disagreements from agent ledgers, kept past their dispatch; inferred. */
	disputes: ClaimDisputeRecord[];
	/** Claims imported from another project; inferred, never edge-forming. */
	imports: ClaimImportRecord[];
	/** Logs of linked worktrees written before worktrees folded into the main checkout, read through, never rewritten. */
	legacy: string[];
	/** Lines that are not a JSON object, such as a line torn by a crash. */
	unreadable: number;
	/**
	 * Records whose id does not match their content, that name another project, or a claim that is not grounded in a
	 * valid execution source: edited or written after capture by something other than this ledger.
	 */
	mismatched: number;
	/** Records of a version this build does not read. */
	unknownVersion: number;
	/**
	 * Hypothesis, check-start and test records whose links to earlier records do not hold: a replayed line, a revision
	 * that does not follow the entry's current record, a second start of one run or one that does not list exactly the
	 * revisions current then, or a test whose hypothesis its run's start does not list or whose claim is not a later
	 * record of its check, run and verdict. The ledger never writes one; it was added to the log by something else.
	 */
	unlinked: number;
	/**
	 * Claim, edge and regression lines repeating the id of an earlier one, such as an append retried after a write that
	 * did land. Ids hash the record's content, so the repeat is the same record; the first is kept where it was appended.
	 */
	duplicates: number;
}

function isDisputePost(value: unknown): boolean {
	return (
		isObject(value) &&
		typeof value.entry === "string" &&
		typeof value.runId === "string" &&
		typeof value.agentId === "string" &&
		typeof value.kind === "string" &&
		typeof value.text === "string" &&
		(value.path === undefined || typeof value.path === "string") &&
		(value.line === undefined || typeof value.line === "number")
	);
}

function isDisputeRecord(value: Record<string, unknown>): boolean {
	return (
		value.type === "dispute" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.ledger === "string" &&
		value.evidence === "inferred" &&
		isDisputePost(value.target) &&
		isDisputePost(value.review)
	);
}

function isImportRecord(value: Record<string, unknown>): boolean {
	const origin = value.origin;
	return (
		value.type === "import" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		value.evidence === "inferred" &&
		isObject(origin) &&
		typeof origin.projectDigest === "string" &&
		isNullableString(origin.rootCommit) &&
		(origin.remote === undefined || typeof origin.remote === "string") &&
		isObject(value.claim) &&
		isClaimRecord(value.claim)
	);
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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): boolean {
	return value === null || typeof value === "string";
}

function isHypothesisSource(value: unknown): boolean {
	if (!isObject(value) || typeof value.slateSha256 !== "string") return false;
	if (value.channel === "slate") return isNullableString(value.sessionId) && isNullableString(value.toolCallId);
	return value.channel === "worker-slate" && typeof value.runId === "string" && typeof value.receiptDigest === "string";
}

function isCheckSource(value: unknown): boolean {
	if (!isObject(value)) return false;
	if (value.channel === "verify")
		return (
			isNullableString(value.sessionId) &&
			isNullableString(value.toolCallId) &&
			(value.requestedBy === "model" || value.requestedBy === "harness")
		);
	return (
		value.channel === "host-verification" && typeof value.runId === "string" && typeof value.receiptDigest === "string"
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
		(criterion.check === undefined || typeof criterion.check === "string") &&
		(criterion.statement === undefined || typeof criterion.statement === "string") &&
		(value.revises === undefined || typeof value.revises === "string") &&
		isHypothesisSource(value.source)
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
		isCheckSource(value.source)
	);
}

function isCheckRunIdentity(value: unknown): boolean {
	if (!isObject(value)) return false;
	if (value.channel === "verify") return isNullableString(value.sessionId) && typeof value.toolCallId === "string";
	return value.channel === "host-verification" && typeof value.runId === "string";
}

function isCheckStartRecord(value: Record<string, unknown>): boolean {
	return (
		value.type === "check-start" &&
		typeof value.id === "string" &&
		typeof value.at === "string" &&
		typeof value.check === "string" &&
		isCheckRunIdentity(value.run) &&
		isStringArray(value.hypotheses)
	);
}

/** One run of one check: a verify call, or a check of a worker run's host verification. */
function runKey(run: CheckRunIdentity, check: string): string {
	return JSON.stringify(
		run.channel === "verify" ? [run.channel, run.sessionId, run.toolCallId, check] : [run.channel, run.runId, check],
	);
}

/** The run a test's or claim's source names, or null when it names none a start record could bind. */
function sourceRunKey(source: ClaimSource, check: string): string | null {
	if (source.channel === "verify")
		return source.toolCallId === null
			? null
			: runKey({ channel: "verify", sessionId: source.sessionId, toolCallId: source.toolCallId }, check);
	return runKey({ channel: "host-verification", runId: source.runId }, check);
}

/**
 * The links an ordered read admits a hypothesis, check-start or test record by (#406). Each record's hash only proves
 * its own bytes; these prove where it sits: a revision follows the current record of its entry, a run's start lists
 * the revisions current as it started, and a test names a revision its run's start lists and a claim that followed
 * that start and is the judgement of the very run the test says it is.
 */
interface LinkState {
	ids: Set<string>;
	claims: Map<string, { claim: ClaimRecord; line: number }>;
	hypotheses: Map<string, { record: HypothesisRecord; line: number }>;
	current: Map<string, HypothesisRecord>;
	starts: Map<string, { record: CheckStartRecord; line: number }>;
	tested: Set<string>;
}

/** Two check sources name the same run only when both are valid sources of one channel and agree on its identity. */
function sameSource(a: ClaimSource, b: ClaimSource): boolean {
	if (!isCheckSource(a) || !isCheckSource(b) || a.channel !== b.channel) return false;
	if (a.channel === "host-verification" && b.channel === "host-verification")
		return a.runId === b.runId && a.receiptDigest === b.receiptDigest;
	if (a.channel === "verify" && b.channel === "verify")
		return a.sessionId === b.sessionId && a.toolCallId === b.toolCallId && a.requestedBy === b.requestedBy;
	return false;
}

function admitHypothesis(state: LinkState, record: HypothesisRecord, line: number): boolean {
	if (state.ids.has(record.id) || hypothesisSubject(record) !== record.subject) return false;
	const key = `${record.slate}\0${record.hypothesis}`;
	const current = state.current.get(key);
	// The first record of an entry revises nothing; every later one revises the record current then and changes it.
	if (
		current === undefined
			? record.revises !== undefined
			: record.revises !== current.id || current.subject === record.subject
	)
		return false;
	state.ids.add(record.id);
	state.current.set(key, record);
	state.hypotheses.set(record.id, { record, line });
	return true;
}

/**
 * A run starts once, bound to exactly the revisions whose criterion named its check then: a second start of the same
 * run, or one listing anything else, was not written by this ledger.
 */
function admitCheckStart(state: LinkState, record: CheckStartRecord, line: number): boolean {
	const key = runKey(record.run, record.check);
	if (state.ids.has(record.id) || state.starts.has(key)) return false;
	const naming = new Set(
		[...state.current.values()].filter((current) => current.criterion.check === record.check).map(({ id }) => id),
	);
	const listed = new Set(record.hypotheses);
	if (
		listed.size !== record.hypotheses.length ||
		listed.size !== naming.size ||
		![...listed].every((id) => naming.has(id))
	)
		return false;
	state.ids.add(record.id);
	state.starts.set(key, { record, line });
	return true;
}

function admitHypothesisTest(state: LinkState, test: HypothesisTestRecord): boolean {
	if (state.ids.has(test.id)) return false;
	const hypothesis = state.hypotheses.get(test.hypothesis);
	if (hypothesis === undefined || hypothesis.record.criterion.check !== test.check) return false;
	// Only a revision the run was bound to as it started is tested by it.
	const runStart = sourceRunKey(test.source, test.check);
	const start = runStart === null ? undefined : state.starts.get(runStart);
	if (start === undefined || !start.record.hypotheses.includes(test.hypothesis)) return false;
	if (test.claim !== undefined) {
		const backing = state.claims.get(test.claim);
		const pair = `${test.hypothesis}\0${test.claim}`;
		if (
			backing === undefined ||
			state.tested.has(pair) ||
			// Only Clio's own judgement decides a hypothesis.
			backing.claim.evidence !== "grounded" ||
			// The judgement of the run that started there, so it follows the start, which follows the hypothesis.
			backing.line < start.line ||
			backing.claim.keys.check !== test.check ||
			backing.claim.verdict !== (test.outcome === "supported" ? "agrees" : "disagrees") ||
			!sameSource(backing.claim.source, test.source)
		)
			return false;
		state.tested.add(pair);
	}
	state.ids.add(test.id);
	return true;
}

function parseClaimsLog(text: string, projectRoot: string): ClaimsLogRead {
	const read: ClaimsLogRead = {
		project: projectRoot,
		path: claimsLogPath(projectRoot),
		records: [],
		edges: [],
		regressions: [],
		hypotheses: [],
		checkStarts: [],
		hypothesisTests: [],
		disputes: [],
		imports: [],
		legacy: [],
		unreadable: 0,
		mismatched: 0,
		unknownVersion: 0,
		unlinked: 0,
		duplicates: 0,
	};
	const links: LinkState = {
		ids: new Set(),
		claims: new Map(),
		hypotheses: new Map(),
		current: new Map(),
		starts: new Map(),
		tested: new Set(),
	};
	const seen = new Set<string>();
	let index = -1;
	for (const line of text.split("\n")) {
		index += 1;
		if (line.trim().length === 0) continue;
		if (!withinLineBound(line)) {
			read.unreadable += 1;
			continue;
		}
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
			// The ledger writes only grounded claims from a verify call or a sealed host check; anything else was not its.
			if (
				claim.project !== projectRoot ||
				claim.evidence !== "grounded" ||
				!isCheckSource(claim.source) ||
				claimRecordId(claim) !== claim.id
			)
				read.mismatched += 1;
			else if (links.claims.has(claim.id)) read.duplicates += 1;
			else {
				read.records.push(claim);
				links.claims.set(claim.id, { claim, line: index });
			}
			continue;
		}
		if (isEdgeRecord(record) || isRegressionRecord(record)) {
			const id = record.id as string;
			if (record.project !== projectRoot || claimLogRecordId(record) !== id) read.mismatched += 1;
			else if (seen.has(id)) read.duplicates += 1;
			else {
				seen.add(id);
				if (record.type === "edge") read.edges.push(record as unknown as ClaimEdgeRecord);
				else read.regressions.push(record as unknown as ClaimRegressionRecord);
			}
			continue;
		}
		if (isDisputeRecord(record) || isImportRecord(record)) {
			const id = record.id as string;
			if (record.project !== projectRoot || claimLogRecordId(record) !== id) read.mismatched += 1;
			else if (seen.has(id)) read.duplicates += 1;
			else {
				seen.add(id);
				if (record.type === "dispute") read.disputes.push(record as unknown as ClaimDisputeRecord);
				else read.imports.push(record as unknown as ClaimImportRecord);
			}
			continue;
		}
		if (isHypothesisRecord(record) || isCheckStartRecord(record) || isHypothesisTestRecord(record)) {
			if (record.project !== projectRoot || claimLogRecordId(record) !== record.id) read.mismatched += 1;
			else if (record.type === "hypothesis") {
				const hypothesis = record as unknown as HypothesisRecord;
				if (admitHypothesis(links, hypothesis, index)) read.hypotheses.push(hypothesis);
				else read.unlinked += 1;
			} else if (record.type === "check-start") {
				const start = record as unknown as CheckStartRecord;
				if (admitCheckStart(links, start, index)) read.checkStarts.push(start);
				else read.unlinked += 1;
			} else {
				const test = record as unknown as HypothesisTestRecord;
				if (admitHypothesisTest(links, test)) read.hypothesisTests.push(test);
				else read.unlinked += 1;
			}
			continue;
		}
		read.unreadable += 1;
	}
	return read;
}

function readLog(projectRoot: string): ClaimsLogRead {
	let text: string;
	try {
		text = readFileSync(claimsLogPath(projectRoot), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseClaimsLog("", projectRoot);
		throw error;
	}
	return parseClaimsLog(text, projectRoot);
}

/**
 * Every record in a project's log, oldest first. A missing log reads as empty.
 *
 * Before linked worktrees folded into their main checkout (#406), each worktree kept a log under its own root. Those
 * logs are read through after the project's own records, so a lane's earlier claims stay visible from the checkout it
 * merges into; they are never rewritten, and appends never derive edges against them.
 */
export function readClaims(projectRoot: string): ClaimsLogRead {
	const read = readLog(projectRoot);
	for (const worktree of linkedWorktreeRoots(projectRoot)) {
		if (!existsSync(claimsLogPath(worktree))) continue;
		let legacy: ClaimsLogRead;
		try {
			legacy = readLog(worktree);
		} catch {
			// An unreadable legacy log hides only its own history.
			continue;
		}
		read.legacy.push(legacy.path);
		const known = new Set(read.records.map((claim) => claim.id));
		read.records.push(...legacy.records.filter((claim) => !known.has(claim.id)));
		read.edges.push(...legacy.edges);
		read.regressions.push(...legacy.regressions);
		read.hypotheses.push(...legacy.hypotheses);
		read.checkStarts.push(...legacy.checkStarts);
		read.hypothesisTests.push(...legacy.hypothesisTests);
		read.disputes.push(...legacy.disputes);
		read.imports.push(...legacy.imports);
		read.unreadable += legacy.unreadable;
		read.mismatched += legacy.mismatched;
		read.unknownVersion += legacy.unknownVersion;
		read.unlinked += legacy.unlinked;
		read.duplicates += legacy.duplicates;
	}
	return read;
}

/** What makes two inferred records one: a dispute's id, an import's origin and original claim (not its import time). */
function inferredKey(record: ClaimDisputeRecord | ClaimImportRecord): string {
	return record.type === "import" ? `import\0${record.origin.projectDigest}\0${record.claim.id}` : record.id;
}

/** Append inferred records (disputes, imports) to a project's log; a record already there is skipped. */
async function appendInferred(
	project: string,
	records: ReadonlyArray<ClaimDisputeRecord | ClaimImportRecord>,
): Promise<number> {
	let written = 0;
	if (records.length === 0) return written;
	await appendLines(project, ({ full }) => {
		const log = full();
		const known = new Set([...log.disputes, ...log.imports].map(inferredKey));
		const lines: string[] = [];
		for (const record of records) {
			if (known.has(inferredKey(record))) continue;
			known.add(inferredKey(record));
			lines.push(JSON.stringify(record));
		}
		written = lines.length;
		return lines;
	});
	return written;
}

export async function appendDisputes(project: string, records: ReadonlyArray<ClaimDisputeRecord>): Promise<number> {
	return appendInferred(project, records);
}

export async function appendImports(project: string, records: ReadonlyArray<ClaimImportRecord>): Promise<number> {
	return appendInferred(project, records);
}

/** What a compaction kept, dropped and pruned. */
export interface ClaimsCompaction {
	path: string;
	bytesBefore: number;
	bytesAfter: number;
	linesBefore: number;
	linesAfter: number;
	/** Check-start lines that bound no hypothesis: they decide nothing a later read admits. */
	droppedStarts: number;
	duplicates: number;
	/** Torn, unparseable or tampered lines, moved to `<digest>.quarantine.jsonl`. */
	quarantined: number;
	/** Superseded claims older than the prune date that nothing cites, and the edges that named them. */
	prunedClaims: number;
	prunedEdges: number;
	dryRun: boolean;
}

/**
 * Rewrite a project's log without what no reader needs (#406), under the log's lock: check-starts that bound no
 * hypothesis, repeated lines, and lines that are not a valid record of this project (moved to a quarantine file, not
 * deleted). With `pruneSupersededBefore`, superseded claims captured before that time are pruned too, unless a
 * regression, a hypothesis test or a memory record (`cited`) still names them; edges naming a pruned claim go with
 * it. Lines of a version or type this build does not know are kept as they are, so an older build never drops a newer
 * build's records. The new generation is written beside the log and renamed over it, so a reader without the lock sees
 * one generation or the other; the previous generation stays as `<digest>.prev.jsonl` until the next compaction.
 */
export async function compactClaimsLog(project: string, options: CompactOptions = {}): Promise<ClaimsCompaction> {
	const path = claimsLogPath(project);
	const result = emptyCompaction(path, options.dryRun === true);
	if (!existsSync(path)) return result;
	await withStateFileLock(path, () => {
		rewriteLogLocked(project, options, result);
	});
	return result;
}

interface CompactOptions {
	pruneSupersededBefore?: Date;
	cited?: ReadonlySet<string>;
	dryRun?: boolean;
}

function emptyCompaction(path: string, dryRun: boolean): ClaimsCompaction {
	return {
		path,
		bytesBefore: 0,
		bytesAfter: 0,
		linesBefore: 0,
		linesAfter: 0,
		droppedStarts: 0,
		duplicates: 0,
		quarantined: 0,
		prunedClaims: 0,
		prunedEdges: 0,
		dryRun,
	};
}

/**
 * The compaction rewrite, with the log's lock held. With `evictTo`, superseded claims nothing names are also evicted,
 * oldest first, until at most that many claims remain or none is left to evict (MEM-3); they and the edges pointing at
 * them are appended to `<digest>.evicted.jsonl`, not deleted.
 */
function rewriteLogLocked(
	project: string,
	options: CompactOptions,
	result: ClaimsCompaction,
	evictTo?: number,
): number {
	const path = result.path;
	const text = readFileSync(path, "utf8");
	result.bytesBefore = Buffer.byteLength(text, "utf8");
	const read = parseClaimsLog(text, project);
	const admitted = new Set<string>([
		...read.records.map(({ id }) => id),
		...read.edges.map(({ id }) => id),
		...read.regressions.map(({ id }) => id),
		...read.hypotheses.map(({ id }) => id),
		...read.checkStarts.filter((start) => start.hypotheses.length > 0).map(({ id }) => id),
		...read.hypothesisTests.map(({ id }) => id),
		...read.disputes.map(({ id }) => id),
		...read.imports.map(({ id }) => id),
	]);
	const emptyStarts = new Set(read.checkStarts.filter((start) => start.hypotheses.length === 0).map(({ id }) => id));
	const pruned = new Set<string>();
	const evicted = new Set<string>();
	if (options.pruneSupersededBefore !== undefined || evictTo !== undefined) {
		const before = options.pruneSupersededBefore?.getTime();
		const superseded = new Set(read.edges.filter((edge) => edge.kind === "supersedes").map((edge) => edge.to));
		const kept = new Set<string>([
			...read.regressions.flatMap((regression) => [regression.from, ...regression.backing]),
			...read.hypothesisTests.flatMap((test) => (test.claim === undefined ? [] : [test.claim])),
			...read.edges.filter((edge) => edge.kind === "contradicts").flatMap((edge) => [edge.from, edge.to]),
			...(options.cited ?? []),
		]);
		const candidates = read.records.filter((claim) => superseded.has(claim.id) && !kept.has(claim.id));
		if (before !== undefined) for (const claim of candidates) if (Date.parse(claim.at) < before) pruned.add(claim.id);
		if (evictTo !== undefined)
			for (const claim of candidates) {
				if (read.records.length - pruned.size - evicted.size <= evictTo) break;
				if (!pruned.has(claim.id)) evicted.add(claim.id);
			}
	}
	const keptLines: string[] = [];
	const quarantine: string[] = [];
	const evictedLines: string[] = [];
	const written = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		result.linesBefore += 1;
		let value: unknown;
		try {
			value = withinLineBound(line) ? JSON.parse(line) : undefined;
		} catch {
			value = undefined;
		}
		if (!isObject(value)) {
			quarantine.push(line);
			continue;
		}
		const id = typeof value.id === "string" ? value.id : undefined;
		const known =
			value.v === CLAIM_RECORD_VERSION &&
			["claim", "edge", "regression", "hypothesis", "check-start", "hypothesis-test", "dispute", "import"].includes(
				String(value.type),
			);
		// Another version or type: a newer build's record, kept verbatim.
		if (!known || id === undefined) {
			keptLines.push(line);
			continue;
		}
		if (emptyStarts.has(id)) {
			result.droppedStarts += 1;
			continue;
		}
		if (pruned.has(id)) {
			result.prunedClaims += 1;
			continue;
		}
		if (value.type === "edge" && (pruned.has(String(value.from)) || pruned.has(String(value.to)))) {
			result.prunedEdges += 1;
			continue;
		}
		// An edge leaves with the claim it points at: a kept claim keeps the edge saying what superseded it, even when that
		// later claim is evicted, so eviction never makes an old verdict read as current.
		if (evicted.has(id) || (value.type === "edge" && evicted.has(String(value.to)))) {
			if (!written.has(id)) evictedLines.push(line);
			written.add(id);
			continue;
		}
		if (written.has(id)) {
			result.duplicates += 1;
			continue;
		}
		if (!admitted.has(id)) {
			quarantine.push(line);
			continue;
		}
		written.add(id);
		keptLines.push(line);
	}
	result.quarantined = quarantine.length;
	result.linesAfter = keptLines.length;
	const next = keptLines.length === 0 ? "" : `${keptLines.join("\n")}\n`;
	result.bytesAfter = Buffer.byteLength(next, "utf8");
	if (options.dryRun === true) return 0;
	// Eviction with nothing to evict rewrites nothing: an unasked compaction would only churn the previous generation.
	if (evictTo !== undefined && evicted.size === 0) return 0;
	if (quarantine.length > 0) writeFileLines(siblingPath(path, "quarantine.jsonl"), quarantine);
	if (evictedLines.length > 0) writeFileLines(claimsEvictedPath(project), evictedLines);
	copyFileSync(path, siblingPath(path, "prev.jsonl"));
	const temporary = siblingPath(path, `compact-${process.pid}.tmp`);
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeSync(fd, next);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	fsyncDirectory(dirname(path));
	// The index described the old generation; the next append rebuilds it from this one.
	rmSync(claimsIndexPath(project), { force: true });
	return evicted.size;
}

/** Append lines to an audit file beside the log, created 0600. */
function writeFileLines(path: string, lines: ReadonlyArray<string>): void {
	const fd = openSync(path, "a", 0o600);
	try {
		writeSync(fd, `${lines.join("\n")}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Screen inferred text at capture, as claim text is: flagged text is stored for audit and withheld from prompts. */
export function inferredFlag(...texts: ReadonlyArray<string>): { flagged?: "instruction-markers" } {
	return texts.some((text) => containsInstructionMarkers(text)) ? { flagged: "instruction-markers" } : {};
}
