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
	hypothesesNaming,
	hypothesisSubject,
} from "./hypotheses.js";
import {
	type CheckRunIdentity,
	type CheckStartRecord,
	CLAIM_KINDS,
	CLAIM_RECORD_VERSION,
	type ClaimEdgeRecord,
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
	await appendLines(claimsLogPath(project), (current) => {
		if (stillCurrent !== undefined && !stillCurrent()) {
			refused = true;
			return [];
		}
		const added = deriveHypothesisRecords(parseClaimsLog(current, project).hypotheses, drafts);
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
	await appendLines(claimsLogPath(project), (current) => {
		const log = parseClaimsLog(current, project);
		const started = new Map(log.checkStarts.map((record) => [runKey(record.run, record.check), record]));
		const lines: string[] = [];
		for (const check of wanted) {
			const earlier = started.get(runKey(run, check));
			if (earlier !== undefined) {
				bindings.set(check, [...earlier.hypotheses]);
				continue;
			}
			const hypotheses = hypothesesNaming(log.hypotheses, check);
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
	checkStarts: CheckStartRecord[];
	hypothesisTests: HypothesisTestRecord[];
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
