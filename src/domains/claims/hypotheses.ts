import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { containsInstructionMarkers } from "../../core/untrusted-content.js";
import { canonicalClaimJson } from "./capture.js";
import { claimLogRecordId } from "./edges.js";
import {
	CLAIM_RECORD_VERSION,
	type ClaimRecord,
	type ClaimSource,
	HYPOTHESIS_SLATE_SCHEMA,
	type HypothesisRecordV1,
	type HypothesisSource,
	type HypothesisStatus,
	type HypothesisTestRecordV1,
} from "./types.js";

/**
 * Hypotheses in the claims ledger (#406). A hypothesis-workflow slate keeps every hypothesis at `proposed`; the ledger
 * records each one and moves it only on Clio's own execution of the check its success criterion names. The text of a
 * hypothesis is the model's and is kept as proposed, never grounded; what supports or refutes it is a claim, which no
 * model can write.
 */

/** Statement and prediction are clipped to this many characters, so one slate cannot grow the log without bound. */
const HYPOTHESIS_TEXT_MAX_CHARS = 1000;
const HYPOTHESIS_ID = /^H[0-9]+$/u;

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed.length <= HYPOTHESIS_TEXT_MAX_CHARS ? trimmed : `${trimmed.slice(0, HYPOTHESIS_TEXT_MAX_CHARS - 3)}...`;
}

function projectPath(project: string, path: string): string {
	if (!isAbsolute(path)) return path;
	const inside = relative(project, path);
	return inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

/** A hypothesis record before the log decides whether it revises an earlier one; its id is set then. */
export type HypothesisDraft = Omit<HypothesisRecordV1, "id" | "revises">;

/** Where a slate came from, before its bytes are hashed. */
export type SlateOrigin =
	| Omit<Extract<HypothesisSource, { channel: "slate" }>, "slateSha256">
	| Omit<Extract<HypothesisSource, { channel: "worker-slate" }>, "slateSha256">;

/** The digest a hypothesis record's `subject` must equal: the same entry rewritten unchanged is one subject. */
export function hypothesisSubject(
	record: Pick<HypothesisRecordV1, "slate" | "hypothesis" | "statement" | "prediction" | "criterion">,
): string {
	return sha256(
		canonicalClaimJson({
			slate: record.slate,
			hypothesis: record.hypothesis,
			statement: record.statement,
			prediction: record.prediction,
			criterion: record.criterion,
		}),
	);
}

/** A slate's parsed top level, or null when the text is not a hypothesis slate. */
function parseSlate(text: string): { hypotheses: unknown[] } | null {
	let slate: unknown;
	try {
		slate = JSON.parse(text);
	} catch {
		return null;
	}
	return isRecord(slate) && slate.schema === HYPOTHESIS_SLATE_SCHEMA && Array.isArray(slate.hypotheses)
		? { hypotheses: slate.hypotheses }
		: null;
}

export function isHypothesisSlate(text: string): boolean {
	return parseSlate(text) !== null;
}

/**
 * The hypotheses a slate holds, or null when the text is not a slate. Only an entry with a slate id, a statement and a
 * falsifiable prediction becomes a record, and only while the slate holds it at `proposed`: the checker refuses any
 * other status, and a status the model wrote is never read as evidence.
 */
export function hypothesesFromSlate(input: {
	text: string;
	path: string;
	project: string;
	at: string;
	source: SlateOrigin;
}): HypothesisDraft[] | null {
	const slate = parseSlate(input.text);
	if (slate === null) return null;
	const path = projectPath(input.project, input.path);
	const slateSha256 = sha256(input.text);
	const seen = new Set<string>();
	const drafts: HypothesisDraft[] = [];
	for (const entry of slate.hypotheses) {
		if (!isRecord(entry)) continue;
		const id = typeof entry.id === "string" && HYPOTHESIS_ID.test(entry.id) ? entry.id : null;
		const statement = text(entry.statement);
		const prediction = text(entry.prediction);
		if (id === null || statement === null || prediction === null || seen.has(id)) continue;
		if (entry.status !== undefined && entry.status !== "proposed") continue;
		seen.add(id);
		const experiment = isRecord(entry.experiment) ? entry.experiment : {};
		const success = isRecord(experiment.successCriterion) ? experiment.successCriterion : {};
		const check =
			typeof success.verifyId === "string" && success.verifyId.trim().length > 0 ? success.verifyId.trim() : null;
		const criterionStatement = text(success.statement);
		const criterion: HypothesisRecordV1["criterion"] = {
			kind: typeof success.kind === "string" && success.kind.length > 0 ? success.kind : "unspecified",
			...(check !== null ? { check } : {}),
			...(criterionStatement !== null ? { statement: criterionStatement } : {}),
		};
		const subject = hypothesisSubject({ slate: path, hypothesis: id, statement, prediction, criterion });
		drafts.push({
			v: CLAIM_RECORD_VERSION,
			type: "hypothesis",
			at: input.at,
			project: input.project,
			slate: path,
			hypothesis: id,
			statement,
			prediction,
			criterion,
			subject,
			source: { ...input.source, slateSha256 },
			evidence: "proposed",
			...(containsInstructionMarkers(`${statement}\n${prediction}\n${criterion.statement ?? ""}`)
				? { flagged: "instruction-markers" as const }
				: {}),
		});
	}
	return drafts;
}

function entryKey(record: Pick<HypothesisRecordV1, "slate" | "hypothesis">): string {
	return `${record.slate}\0${record.hypothesis}`;
}

/** The latest record of each slate entry, keyed by slate path and hypothesis id. */
export function latestHypotheses(records: ReadonlyArray<HypothesisRecordV1>): Map<string, HypothesisRecordV1> {
	const latest = new Map<string, HypothesisRecordV1>();
	for (const record of records) latest.set(entryKey(record), record);
	return latest;
}

/**
 * The records a slate write adds against the log: an entry whose content is unchanged adds nothing, a changed entry
 * adds a record that revises the latest earlier one, and a new entry adds a record of its own.
 */
export function deriveHypothesisRecords(
	history: ReadonlyArray<HypothesisRecordV1>,
	drafts: ReadonlyArray<HypothesisDraft>,
): HypothesisRecordV1[] {
	const latest = latestHypotheses(history);
	const added: HypothesisRecordV1[] = [];
	for (const draft of drafts) {
		const previous = latest.get(entryKey(draft));
		if (previous?.subject === draft.subject) continue;
		const body: Omit<HypothesisRecordV1, "id"> = {
			...draft,
			...(previous !== undefined ? { revises: previous.id } : {}),
		};
		const record = { ...body, id: claimLogRecordId(body) };
		latest.set(entryKey(record), record);
		added.push(record);
	}
	return added;
}

/**
 * One run of a declared check, with the claim it was judged into when it was judged. `hypotheses` are the revisions
 * bound when the check started; only those are tested, so a hypothesis proposed or revised while the check ran is not.
 */
export interface CheckRun {
	check: string;
	hypotheses: ReadonlyArray<string>;
	execution: string;
	claim?: ClaimRecord;
	source: ClaimSource;
	at: string;
}

/** The current revisions whose criterion names a check: what a run of it that starts now tests. */
export function hypothesesNaming(records: ReadonlyArray<HypothesisRecordV1>, check: string): string[] {
	return [...latestHypotheses(records).values()]
		.filter((record) => record.criterion.check === check)
		.map((record) => record.id);
}

/**
 * The test records check runs add: one per hypothesis bound to the run when it started, which still names the check.
 * The claim decides the outcome; a run without one only marks the hypothesis tested.
 */
export function deriveHypothesisTests(
	history: ReadonlyArray<HypothesisRecordV1>,
	runs: ReadonlyArray<CheckRun>,
): HypothesisTestRecordV1[] {
	const byId = new Map(history.map((record) => [record.id, record]));
	const added: HypothesisTestRecordV1[] = [];
	for (const run of runs) {
		for (const id of new Set(run.hypotheses)) {
			const hypothesis = byId.get(id);
			if (hypothesis?.criterion.check !== run.check) continue;
			const outcome: HypothesisTestRecordV1["outcome"] =
				run.claim === undefined ? "tested" : run.claim.verdict === "agrees" ? "supported" : "refuted";
			const body: Omit<HypothesisTestRecordV1, "id"> = {
				v: CLAIM_RECORD_VERSION,
				type: "hypothesis-test",
				at: run.at,
				project: hypothesis.project,
				hypothesis: hypothesis.id,
				check: run.check,
				outcome,
				...(run.claim !== undefined ? { claim: run.claim.id } : {}),
				execution: run.execution,
				source: run.source,
			};
			added.push({ ...body, id: claimLogRecordId(body) });
		}
	}
	return added;
}

export interface HypothesisState {
	status: HypothesisStatus;
	/** The test that decided the status: the latest judged one, else the latest run. */
	decidedBy?: HypothesisTestRecordV1;
	tests: HypothesisTestRecordV1[];
	/** The later record of the same slate entry, when one replaced this one. */
	revisedBy?: string;
}

/**
 * Status of every hypothesis record from its tests. The latest judged run decides between supported and refuted; a
 * later run that concluded nothing (a timeout, a crash) leaves that standing, since it judged nothing.
 */
export function hypothesisStatuses(
	records: ReadonlyArray<HypothesisRecordV1>,
	tests: ReadonlyArray<HypothesisTestRecordV1>,
): Map<string, HypothesisState> {
	const states = new Map<string, HypothesisState>();
	for (const record of records) states.set(record.id, { status: "proposed", tests: [] });
	for (const record of records) {
		const revised = record.revises === undefined ? undefined : states.get(record.revises);
		if (revised !== undefined) revised.revisedBy = record.id;
	}
	for (const test of tests) {
		const state = states.get(test.hypothesis);
		if (state === undefined) continue;
		state.tests.push(test);
		if (test.outcome !== "tested") {
			state.status = test.outcome;
			state.decidedBy = test;
		} else if (state.status === "proposed" || state.status === "tested") {
			state.status = "tested";
			state.decidedBy = test;
		}
	}
	return states;
}
