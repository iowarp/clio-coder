import { createHash } from "node:crypto";
import path from "node:path";
import { parseJsonObjectPayload } from "../../core/json-payload.js";
import { AGENT_AUTOMATION_AUTHORITIES, type AgentAutomationAuthority } from "./spec.js";

export type ResultContract =
	| { kind: "architect-plan"; path: string }
	| { kind: "scout-report" }
	| { kind: "verifier-report" }
	| { kind: "council-report" }
	/**
	 * One council member's ballot under `synthesis: "vote"`.
	 *
	 * The vote is a strict majority over the members' `verdict` fields, computed
	 * by the coordinator with no model call. Nothing asked a member for that
	 * field before this kind existed, and nothing could: an unnamed council
	 * seats the builtin `researcher`, whose `research-report` accepts only
	 * `source` and `findings`, so a member that emitted a verdict failed its own
	 * postcondition and a member that obeyed its postcondition emitted no
	 * verdict. Every vote therefore resolved to `no_verdict_field` with an empty
	 * tally, on every input (#230).
	 *
	 * The ballot is the coordinator's postcondition for that slot, not the
	 * recipe's, in the same way `reviewer` and the compete `judge` answer the
	 * gate that dispatched them. It rides in as a `resultContractOverride` on
	 * the member request, so the seated recipe keeps its persona and any recipe
	 * can be voted with. No recipe may declare it: `parseResultContract` rejects
	 * the kind, and a Scout subtask may not request it, because it is a
	 * topology's ballot rather than an agent's work product.
	 */
	| { kind: "council-ballot" }
	| { kind: "debugger-report" }
	| { kind: "research-report" }
	| { kind: "mutation-report" }
	| { kind: "provenance-report" }
	| { kind: "delegation-plan" }
	/**
	 * The advisory answer `/oracle` asks for. It exists as its own kind because
	 * the answer shape is the whole point of the command: a verdict, the
	 * strongest challenge the advisor can mount, the evidence that would change
	 * its mind, and the prior decisions it read. Folding it onto
	 * `research-report` would ask for claims and evidence instead, and the
	 * challenge and the reversal condition would have nowhere to go.
	 */
	| { kind: "oracle-report" }
	| { kind: "external-delegation" }
	/**
	 * The run's postcondition is the artifact it left on disk, so its terminal
	 * text carries no claim to validate. Only the caller that named the output
	 * location can check the artifact, and it does so by reading the location
	 * rather than by believing a report. A writer asked for a typed report
	 * instead has to invent one: a small model handed `mutation-report` for a
	 * documentation pass routinely seals a fabricated passing `npm test` entry,
	 * which is a false correctness signal produced purely to satisfy a shape.
	 * Recipes may declare this kind; Scout subtasks may not request it, because
	 * a subtask's result is consumed as data by its dependents.
	 */
	| { kind: "artifact-report" }
	/**
	 * The CLIO-CODER.md handbook payload `clio-coder context init` parses. It exists as its
	 * own kind because the alternative was dispatching Scout and telling it in
	 * prose to ignore its own recipe: the recipe body and the repair directive
	 * both name the findings shape, so a model that obeys the recipe returns
	 * reconnaissance and the bootstrap parser rejects every run. A contract is
	 * the wrong thing to override with a sentence in a task prompt.
	 * Scout subtasks may not request it; it is a command's payload, not a
	 * dependency edge.
	 */
	| { kind: "context-handbook" }
	/**
	 * A deterministic command's structured result. No agent recipe may declare
	 * it (`parseResultContract` rejects the kind) and no Scout subtask may
	 * request it: it is authored by the code-step runner, never by a model. It
	 * lives in this union so a code step's terminal result is validated, sealed,
	 * and handed across plan edges through exactly the same door an agent's
	 * report uses.
	 */
	| { kind: "code-report" };

export type ResultContractQuality = "pass" | "fail" | "unmeasured";

export interface ResultContractValidation {
	/** Whether the declared postcondition itself was met. */
	conformance: "pass" | "fail";
	/** Only correctness-bearing contracts can produce a routing-quality label. */
	quality: ResultContractQuality;
	sourceId: string;
	validatorDigest: string;
	/** Parsed Scout data for the model-facing dispatch projection. */
	scout?: ScoutResult;
	/** Parsed Verifier data for the dispatch review-gate projection. */
	verifier?: VerifierResult;
	delegationPlan?: DelegationPlanResult;
	reason?: string;
}

export interface ResultContractFilesystem {
	readFile(path: string): string | null;
	/**
	 * Whether anything exists at this location. Optional because most contracts
	 * only ever need a file's bytes; a mutation report needs presence, since a
	 * run legitimately creates directories and writes through channels no tool
	 * event enumerates. Absent means presence is unobservable here, and the
	 * mutation grounding below degrades to the quality label rather than
	 * calling an unreadable path fabricated.
	 */
	pathExists?(path: string): boolean;
	/**
	 * Whether this location is a directory. Optional for the same reason as
	 * `pathExists`: a contract that only needs a file's bytes never asks. A
	 * Scout citation does, because a survey task cites directories, and a
	 * directory has no bytes to read and no line to ground. Absent means the
	 * distinction is unobservable here, so an unreadable location stays
	 * unreadable rather than being assumed to be a directory.
	 */
	isDirectory?(path: string): boolean;
}

/**
 * Inclusive `[start, end]` line spans a run actually observed, by absolute
 * path. Grounding is only checkable where this evidence exists, which is the
 * worker that made the reads.
 */
export type ObservedReadRanges = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

/**
 * The write-side counterpart of `ObservedReadRanges`: what this run's own tool
 * calls show it changed and ran. Both are recorded by the layer that watched
 * the tool stream (`domains/safety/run-effects.ts`).
 */
export interface ObservedRunEffects {
	/** Absolute paths the run's successful tool calls aimed a mutation at. */
	mutatedPaths: ReadonlySet<string>;
	/** Absolute paths whose only mutation attempt came back blocked or errored. */
	failedMutationPaths: ReadonlySet<string>;
	/** Canonical validation commands the run ran to a clean exit. */
	validationCommands: ReadonlySet<string>;
}

export interface ResultContractValidationInput {
	contract: ResultContract;
	output: string | null;
	cwd: string;
	networkAllowed: boolean;
	filesystem: ResultContractFilesystem;
	/**
	 * Line spans this run read. When supplied, a cited line must fall inside
	 * one, which turns "this line exists in the file" into "this run looked at
	 * this line". Absent means grounding is not observable at this layer and
	 * only the weaker existence check applies.
	 */
	observedReadRanges?: ObservedReadRanges;
	/**
	 * What this run did to the workspace. When supplied, a mutation report is
	 * measured against it instead of being believed. Absent means the effects
	 * are not observable at this layer and the report's own word stands, which
	 * is what every caller got before grounding existed.
	 */
	observedRunEffects?: ObservedRunEffects;
}

/**
 * Receipt-ready projection of the typed result validator.
 *
 * `not-reached` is the third conformance state and is not a soft failure. A
 * declared postcondition is only an applicable check once the run got far
 * enough to produce a terminal result. A worker that crashed before its first
 * token, a target that could not load the model, an operator abort, and an
 * engine loop-guard abort all leave the contract unevaluated. Recording those
 * as `fail` invents correctness evidence out of infrastructure noise, so they
 * seal `not-reached` and stay out of the routing quality denominator.
 */
export interface ResultContractFact {
	sourceId: string;
	validatorDigest: string;
	conformance: "pass" | "fail" | "not-reached";
	quality: ResultContractQuality;
}

export interface ValidateRecipeResultInput {
	contract: ResultContract | null;
	output: string | null;
	cwd: string;
	networkAllowed: boolean;
	filesystem: ResultContractFilesystem;
	/**
	 * Whether the run reached the point where its terminal result was due. The
	 * caller owns this judgement because only it knows how the attempt ended.
	 */
	reachedTerminalResult: boolean;
	/** What the run's tool calls show it changed and ran, when observed. */
	observedRunEffects?: ObservedRunEffects;
}

/**
 * A declared contract that never got to run. `applicable: false` carries the
 * contract's identity so offline replay still knows which postcondition was in
 * force, while contributing no correctness label.
 */
export type RecipeResultOutcome =
	| { applicable: true; validation: ResultContractValidation; fact: ResultContractFact }
	| { applicable: false; fact: ResultContractFact };

export interface ScoutCitation {
	path: string;
	line: number;
}

/** One reconnaissance claim and the live-read location that grounds it. */
export interface ScoutFinding extends ScoutCitation {
	claim: string;
}

export interface ScoutResult {
	findings: ReadonlyArray<ScoutFinding>;
	/** Grounding locations projected from findings, in reported order. */
	citations: ReadonlyArray<ScoutCitation>;
	needsSplit: boolean;
	proposedSubtasks: ReadonlyArray<ScoutSubtask>;
	/**
	 * Claims salvaged from a degraded result that carry no citation this run can
	 * ground. They are leads, never evidence, and they exist so a small model's
	 * observations survive a terminal shape it could not emit. Absent on a
	 * strictly conforming result.
	 */
	ungroundedClaims?: ReadonlyArray<string>;
	/**
	 * The validator's own reason for accepting a degraded shape. Its presence is
	 * the flag: any consumer that needs strict Scout data checks for it. Absent
	 * on a strictly conforming result.
	 */
	degradedReason?: string;
}

/** Strict Scout-authored data. Every execution/control field is coordinator-owned. */
export interface ScoutSubtask {
	id: string;
	task: string;
	dependencies: ReadonlyArray<string>;
	expectedResultContract: ResultContract["kind"];
	requestedAuthority: AgentAutomationAuthority;
}

export interface VerifierCheck {
	name: string;
	passed: boolean;
	evidence: string;
}

/** Parsed `verifier-report` payload, for callers that need the verdict itself. */
export interface VerifierResult {
	verdict: "pass" | "fail";
	checks: ReadonlyArray<VerifierCheck>;
}

export interface DelegationPlanResultTask {
	id: string;
	agent: string;
	description: string;
	depends_on: ReadonlyArray<string>;
	writes: ReadonlyArray<string>;
	mode?: "sequential" | "parallel";
}

export interface DelegationPlanResult {
	tasks: ReadonlyArray<DelegationPlanResultTask>;
}

export function parseDelegationPlanResult(output: string | null): DelegationPlanResult | null {
	const parsed = parseJson(output);
	if (
		!parsed.ok ||
		!hasOnlyKeys(parsed.value, ["tasks"]) ||
		!Array.isArray(parsed.value.tasks) ||
		parsed.value.tasks.length === 0
	)
		return null;
	const tasks: DelegationPlanResultTask[] = [];
	for (const raw of parsed.value.tasks) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const task = raw as Record<string, unknown>;
		if (
			!hasOnlyKeys(task, ["id", "agent", "description", "depends_on", "writes", "mode"]) ||
			!string(task.id) ||
			!string(task.agent) ||
			!string(task.description) ||
			!Array.isArray(task.depends_on) ||
			task.depends_on.some((entry) => !string(entry)) ||
			!Array.isArray(task.writes) ||
			task.writes.some((entry) => !string(entry)) ||
			(task.mode !== undefined && task.mode !== "sequential" && task.mode !== "parallel")
		)
			return null;
		tasks.push({
			id: task.id,
			agent: task.agent,
			description: task.description,
			depends_on: [...task.depends_on] as string[],
			writes: [...task.writes] as string[],
			...(task.mode !== undefined ? { mode: task.mode as "sequential" | "parallel" } : {}),
		});
	}
	return { tasks };
}

/**
 * Longest verdict token a ballot may cast, in bytes.
 *
 * A tally groups members by their exact verdict string, so a verdict that is a
 * sentence can only ever tie with itself and a council of any size reports
 * `no_majority`. The bound is what makes a majority reachable: it forces the
 * decision into a token members can match (`yes`, `no`, `keep`, an option
 * name) and pushes the reasoning into `text`, where the report already reads
 * it. A newline is refused for the same reason.
 */
export const COUNCIL_BALLOT_VERDICT_MAX_BYTES = 64;

/**
 * The ballot's wire shape, quoted verbatim to the member that must cast it and
 * by the repair round that corrects it. Exported because the council composes
 * the member's ask from it, which is the rule this module already states: a
 * contract's example is written once so a prompt cannot drift from its
 * validator.
 */
export const COUNCIL_BALLOT_SHAPE = '{"verdict":"yes","text":"the answer and the evidence behind it"}';

interface CouncilBallot {
	/** The comparable token the tally counts. */
	verdict: string;
	/** The member's answer in prose, which is what the council report shows. */
	text: string;
}

/**
 * Read a council member's ballot. The council reads a verdict out of the
 * member's terminal text with its own reader, because the judge synthesis
 * carries the same two fields under no contract at all; this one is what
 * decides whether the member is allowed to seal that text as its result.
 */
function parseCouncilBallot(output: string | null): CouncilBallot | null {
	const parsed = parseJson(output);
	if (!parsed.ok) return null;
	const value = parsed.value;
	if (!hasOnlyKeys(value, ["verdict", "text"]) || !string(value.verdict) || !string(value.text)) return null;
	const verdict = value.verdict.trim();
	if (verdict.includes("\n") || Buffer.byteLength(verdict, "utf8") > COUNCIL_BALLOT_VERDICT_MAX_BYTES) return null;
	return { verdict, text: value.text.trim() };
}

function validateCouncilBallot(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const ballot = parseCouncilBallot(output);
	if (ballot === null) {
		return failure(
			contract,
			"unmeasured",
			`A council ballot must carry only verdict and text, both non-empty strings, with verdict a single line of at most ${COUNCIL_BALLOT_VERDICT_MAX_BYTES} bytes so the tally can match it against the other members`,
		);
	}
	// Unmeasured, like every other contract whose shape carries no correctness
	// claim: casting a well-formed ballot says nothing about whether the member
	// was right, and the tally is a count of opinions rather than a check.
	return success(contract, "unmeasured", ballot);
}

export interface CouncilReportMember {
	label: string;
	runId: string;
	round: number;
	answer: string;
	verdict?: string;
	failed?: { reason: string };
}

export interface CouncilReport {
	members: CouncilReportMember[];
	synthesis: {
		kind: "none" | "judge" | "vote";
		text?: string;
		verdict?: string;
		tally?: Record<string, number>;
		judgeRunId?: string;
	};
}

export function parseCouncilReport(output: string | null): CouncilReport | null {
	if (output === null) return null;
	const parsed = parseJsonObjectPayload(output);
	if (!parsed.ok) return null;
	const value = parsed.value;
	if (!hasOnlyKeys(value, ["members", "synthesis"]) || !Array.isArray(value.members) || value.members.length === 0) {
		return null;
	}
	const members: CouncilReportMember[] = [];
	for (const raw of value.members) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const member = raw as Record<string, unknown>;
		if (
			!hasOnlyKeys(member, ["label", "runId", "round", "answer", "verdict", "failed"]) ||
			!string(member.label) ||
			!string(member.runId) ||
			!Number.isInteger(member.round) ||
			Number(member.round) < 1 ||
			typeof member.answer !== "string" ||
			(member.verdict !== undefined && !string(member.verdict))
		)
			return null;
		let failed: { reason: string } | undefined;
		if (member.failed !== undefined) {
			if (
				member.failed === null ||
				typeof member.failed !== "object" ||
				Array.isArray(member.failed) ||
				!hasOnlyKeys(member.failed as Record<string, unknown>, ["reason"]) ||
				!string((member.failed as Record<string, unknown>).reason)
			)
				return null;
			failed = { reason: (member.failed as { reason: string }).reason };
		}
		members.push({
			label: member.label,
			runId: member.runId,
			round: Number(member.round),
			answer: member.answer,
			...(member.verdict !== undefined ? { verdict: member.verdict as string } : {}),
			...(failed !== undefined ? { failed } : {}),
		});
	}
	if (value.synthesis === null || typeof value.synthesis !== "object" || Array.isArray(value.synthesis)) return null;
	const rawSynthesis = value.synthesis as Record<string, unknown>;
	if (!hasOnlyKeys(rawSynthesis, ["kind", "text", "verdict", "tally", "judgeRunId"])) return null;
	if (rawSynthesis.kind !== "none" && rawSynthesis.kind !== "judge" && rawSynthesis.kind !== "vote") return null;
	for (const key of ["text", "verdict", "judgeRunId"] as const) {
		if (rawSynthesis[key] !== undefined && !string(rawSynthesis[key])) return null;
	}
	let tally: Record<string, number> | undefined;
	if (rawSynthesis.tally !== undefined) {
		if (rawSynthesis.tally === null || typeof rawSynthesis.tally !== "object" || Array.isArray(rawSynthesis.tally))
			return null;
		tally = {};
		for (const [key, count] of Object.entries(rawSynthesis.tally as Record<string, unknown>)) {
			if (!key || !Number.isInteger(count) || Number(count) < 0) return null;
			tally[key] = Number(count);
		}
	}
	return {
		members,
		synthesis: {
			kind: rawSynthesis.kind,
			...(rawSynthesis.text !== undefined ? { text: rawSynthesis.text as string } : {}),
			...(rawSynthesis.verdict !== undefined ? { verdict: rawSynthesis.verdict as string } : {}),
			...(tally !== undefined ? { tally } : {}),
			...(rawSynthesis.judgeRunId !== undefined ? { judgeRunId: rawSynthesis.judgeRunId as string } : {}),
		},
	};
}

/**
 * Parsed `oracle-report` payload. `/oracle` renders these four fields into the
 * operator note it hands the main agent, so the shape is the answer shape.
 */
export interface OracleResult {
	verdict: string;
	challenge: string;
	changesMyMind: string;
	citedDecisions: ReadonlyArray<string>;
}

/**
 * Parsed `code-report` payload. `passed` restates `exitCode === 0` so a
 * downstream reader never has to know a runner's exit conventions, and
 * `outputExcerpt` is the command's own bytes so a builder repairs from what
 * the command printed rather than from someone's summary of it.
 */
export interface CodeReportResult {
	passed: boolean;
	exitCode: number;
	checks: ReadonlyArray<VerifierCheck>;
	artifactPaths: ReadonlyArray<string>;
	outputExcerpt: string;
}

function canonical(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("result contract cannot digest non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	throw new Error(`result contract cannot digest ${typeof value}`);
}

function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function resultContractDigest(contract: ResultContract): string {
	return digest(contract);
}

export function resultContractSourceId(contract: ResultContract): string {
	return `agent-result-contract:${contract.kind}:${resultContractDigest(contract)}`;
}

function failure(contract: ResultContract, quality: ResultContractQuality, reason: string): ResultContractValidation {
	return {
		conformance: "fail",
		quality,
		sourceId: resultContractSourceId(contract),
		validatorDigest: digest({ contract, reason }),
		reason,
	};
}

function success(
	contract: ResultContract,
	quality: ResultContractQuality,
	value: unknown,
	extra: Pick<ResultContractValidation, "scout" | "verifier" | "delegationPlan" | "reason"> = {},
): ResultContractValidation {
	return {
		conformance: "pass",
		quality,
		sourceId: resultContractSourceId(contract),
		validatorDigest: digest({ contract, value }),
		...extra,
	};
}

/**
 * Read the JSON object a terminal result carries. Every contract prompt asks
 * for bare JSON and a fence is the deviation local models reach for first, so
 * refusing one burns both repair rounds and fails a run whose payload was
 * correct. Widening the span that is searched does not widen what conforms: a
 * candidate still has to parse and still has to be an object, and the per-kind
 * validators still own every field.
 */
function parseJson(
	output: string | null,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
	if (output === null || output.trim().length === 0) return { ok: false, reason: "missing final result" };
	const parsed = parseJsonObjectPayload(output);
	if (parsed.ok) return parsed;
	return {
		ok: false,
		reason: parsed.reason === "not-object" ? "result must be a JSON object" : "result must be valid JSON",
	};
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function string(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function parseFindings(value: unknown): ScoutFinding[] | null {
	if (!Array.isArray(value)) return null;
	const findings: ScoutFinding[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const finding = entry as Record<string, unknown>;
		const line = finding.line;
		if (
			!hasOnlyKeys(finding, ["claim", "path", "line"]) ||
			!string(finding.claim) ||
			!string(finding.path) ||
			typeof line !== "number" ||
			!Number.isSafeInteger(line) ||
			line < 1
		) {
			return null;
		}
		findings.push({ claim: finding.claim, path: finding.path, line });
	}
	return findings;
}

const RESULT_CONTRACT_KINDS: ReadonlyArray<ResultContract["kind"]> = [
	"architect-plan",
	"scout-report",
	"verifier-report",
	"council-report",
	"debugger-report",
	"research-report",
	"mutation-report",
	"provenance-report",
	"external-delegation",
];

function parseSubtasks(value: unknown): ScoutSubtask[] | null {
	if (!Array.isArray(value) || value.length > 4) return null;
	const subtasks: ScoutSubtask[] = [];
	const ids = new Set<string>();
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const subtask = entry as Record<string, unknown>;
		if (
			!hasOnlyKeys(subtask, ["id", "task", "dependencies", "expectedResultContract", "requestedAuthority"]) ||
			!string(subtask.id) ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(subtask.id) ||
			ids.has(subtask.id) ||
			!string(subtask.task) ||
			Buffer.byteLength(subtask.task, "utf8") > 4096 ||
			!Array.isArray(subtask.dependencies) ||
			subtask.dependencies.length > 4 ||
			subtask.dependencies.some((dependency) => !string(dependency)) ||
			new Set(subtask.dependencies).size !== subtask.dependencies.length ||
			!RESULT_CONTRACT_KINDS.includes(subtask.expectedResultContract as ResultContract["kind"]) ||
			!AGENT_AUTOMATION_AUTHORITIES.includes(subtask.requestedAuthority as AgentAutomationAuthority)
		) {
			return null;
		}
		ids.add(subtask.id);
		subtasks.push({
			id: subtask.id,
			task: subtask.task,
			dependencies: [...subtask.dependencies] as string[],
			expectedResultContract: subtask.expectedResultContract as ResultContract["kind"],
			requestedAuthority: subtask.requestedAuthority as AgentAutomationAuthority,
		});
	}
	for (const subtask of subtasks) {
		if (subtask.dependencies.some((dependency) => dependency === subtask.id || !ids.has(dependency))) return null;
	}
	const remaining = new Set(ids);
	const completed = new Set<string>();
	while (remaining.size > 0) {
		const ready = subtasks.filter(
			(subtask) => remaining.has(subtask.id) && subtask.dependencies.every((dependency) => completed.has(dependency)),
		);
		if (ready.length === 0) return null;
		for (const subtask of ready) {
			remaining.delete(subtask.id);
			completed.add(subtask.id);
		}
	}
	return subtasks;
}

function isContextHandbookResult(value: Record<string, unknown>): boolean {
	if (!hasOnlyKeys(value, ["projectName", "identity", "conventions", "invariants", "sections"])) return false;
	if (!string(value.projectName) || !string(value.identity)) return false;
	if (!Array.isArray(value.conventions) || value.conventions.some((entry) => !string(entry))) return false;
	if (!Array.isArray(value.invariants) || value.invariants.some((entry) => !string(entry))) return false;
	if (!Array.isArray(value.sections)) return false;
	return value.sections.every((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
		const section = entry as Record<string, unknown>;
		return hasOnlyKeys(section, ["title", "body"]) && string(section.title) && string(section.body);
	});
}

/**
 * The handbook payload conforms or it does not. Quality stays unmeasured: a
 * well-formed handbook is a shape, not evidence that the repository was read
 * correctly, and routing statistics must not treat it as a correctness signal.
 */
function validateContextHandbook(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "fail", parsed.reason);
	if (!isContextHandbookResult(parsed.value)) {
		return failure(
			contract,
			"fail",
			"context handbook result must carry projectName, identity, conventions[], invariants[], and sections[{title, body}] and nothing else",
		);
	}
	return success(contract, "unmeasured", parsed.value);
}

/**
 * Everything a degraded Scout result still carries: the claims themselves,
 * split by whether a `path`/`line` came with them. Deliberately lenient where
 * `parseFindings` is strict, because this runs only after the strict parse has
 * already failed and the alternative to leniency is discarding the run.
 */
function salvageScoutClaims(value: unknown): { grounded: ScoutFinding[]; ungrounded: string[] } {
	const grounded: ScoutFinding[] = [];
	const ungrounded: string[] = [];
	if (!Array.isArray(value)) return { grounded, ungrounded };
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const finding = entry as Record<string, unknown>;
		if (!string(finding.claim)) continue;
		const line = finding.line;
		if (string(finding.path) && typeof line === "number" && Number.isSafeInteger(line) && line >= 1) {
			grounded.push({ claim: finding.claim, path: finding.path, line });
			continue;
		}
		ungrounded.push(finding.claim);
	}
	return { grounded, ungrounded };
}

/**
 * A degraded acceptance. The strict contract is the goal, not the point: on a
 * small local model the `{claim, path, line}` shape is close to a coin flip,
 * and the E19 drive lost an entire 51k-token reconnaissance run because two
 * bounded repair rounds could not land it. Nothing about the evidence was
 * wrong; only the envelope was, and failing the run threw the evidence away
 * with it.
 *
 * So a result that still carries usable claims conforms, and the claims reach
 * the parent. Quality is `unmeasured`, never `pass`: a shape this validator had
 * to repair is not correctness evidence, and routing statistics must not
 * inherit one. `degradedReason` marks it for every consumer that needs the
 * strict data, and `parseScoutResult` refuses it outright, so a degraded run
 * can never become a `from_scout` continuation source.
 */
function degradedScout(
	contract: ResultContract,
	value: Record<string, unknown>,
	reason: string,
): ResultContractValidation | null {
	const salvaged = salvageScoutClaims(value.findings);
	if (salvaged.grounded.length === 0 && salvaged.ungrounded.length === 0) return null;
	const degradedReason = `${reason} (accepted as a degraded reconnaissance result; findings are leads, not validation evidence)`;
	// needsSplit is forced false and subtasks dropped: a subtask is control-plane
	// data a coordinator acts on, so a malformed one is never repaired here.
	const scout: ScoutResult = {
		findings: salvaged.grounded,
		citations: salvaged.grounded.map(({ path: citedPath, line }) => ({ path: citedPath, line })),
		needsSplit: false,
		proposedSubtasks: [],
		ungroundedClaims: salvaged.ungrounded,
		degradedReason,
	};
	return success(contract, "unmeasured", scout, { scout, reason: degradedReason });
}

function validateScout(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	// Nothing to salvage from bytes that are not a JSON object.
	if (!parsed.ok) return failure(contract, "fail", parsed.reason);
	const value = parsed.value;
	// Every strict rejection below falls through to `degrade`, which returns the
	// strict failure unchanged when the result carries no usable claim either.
	const degrade = (reason: string): ResultContractValidation =>
		degradedScout(contract, value, reason) ?? failure(contract, "fail", reason);
	if (!hasOnlyKeys(value, ["findings", "needsSplit", "proposedSubtasks"])) {
		return degrade("Scout result has unknown fields");
	}
	const findings = parseFindings(value.findings);
	const proposedSubtasks = parseSubtasks(value.proposedSubtasks);
	if (findings === null || typeof value.needsSplit !== "boolean" || proposedSubtasks === null) {
		return degrade(
			"Scout result must carry findings as {claim, path, line} objects, needsSplit, and 0..4 typed proposed subtasks",
		);
	}
	if (value.needsSplit !== proposedSubtasks.length > 0) {
		return degrade("Scout needsSplit must agree with proposedSubtasks");
	}
	// A grounded report needs at least one cited claim. A split recommendation
	// is the explicit exception: it reports that the task did not fit, so it
	// carries subtasks instead of findings.
	if (findings.length === 0 && !value.needsSplit) {
		return degrade("Scout result must carry at least one cited finding, or set needsSplit");
	}
	if (value.needsSplit && findings.length > 0) {
		return degrade("Scout split recommendations carry typed subtasks instead of findings");
	}
	const scout: ScoutResult = {
		findings,
		citations: findings.map(({ path: citedPath, line }) => ({ path: citedPath, line })),
		needsSplit: value.needsSplit,
		proposedSubtasks,
	};
	return success(contract, "pass", scout, { scout });
}

function parseChecks(value: unknown): VerifierCheck[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const checks: VerifierCheck[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const check = entry as Record<string, unknown>;
		if (
			!hasOnlyKeys(check, ["name", "passed", "evidence"]) ||
			!string(check.name) ||
			typeof check.passed !== "boolean" ||
			!string(check.evidence)
		) {
			return null;
		}
		checks.push({ name: check.name, passed: check.passed, evidence: check.evidence });
	}
	return checks;
}

type ScoutCitationEvidence = ScoutCitation & { contentDigest: string };

/**
 * Where a citation lands relative to the workspace root, after the written form
 * is normalized away.
 *
 * A model writes the same location six ways: `src`, `./src`, `src/`, `./src/`,
 * and for the root itself `.` or `./`. `path.resolve` collapses every one of
 * them, so the containment question is answered on the resolved pair and never
 * on the string the model typed.
 *
 * The root is the case that broke. `path.relative(cwd, cwd)` is the empty
 * string, and the check read empty as "not inside", which is exactly backwards:
 * the workspace root is the one path guaranteed to be contained. A
 * directory-survey Scout cites `.` because that is what it surveyed, and four
 * runs died `result_contract_exhausted` on evidence that never left the
 * workspace. Containment is unchanged for a real escape, which still resolves
 * to a `..` segment or an absolute path outside the root.
 */
function citationWithinWorkspace(cwd: string, citedPath: string): boolean {
	const relative = path.relative(cwd, citedPath);
	if (relative === "") return true;
	return !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/**
 * A directory citation carries no bytes and no line, so its evidence digest is
 * bound to the location instead. Prefixed so it can never collide with the
 * content digest of a file that happens to hold the same text.
 */
function directoryCitationDigest(cwd: string, citedPath: string): string {
	const relative = path.relative(cwd, citedPath);
	return createHash("sha256")
		.update(`directory:${relative === "" ? "." : relative}`, "utf8")
		.digest("hex");
}

/** One citation against the workspace and, where known, against this run's own reads. */
function validateScoutCitation(
	input: ResultContractValidationInput,
	citation: ScoutCitation,
): { ok: true; evidence: ScoutCitationEvidence } | { ok: false; reason: string } {
	const cwd = path.resolve(input.cwd);
	const citedPath = path.resolve(cwd, citation.path);
	if (!citationWithinWorkspace(cwd, citedPath)) {
		return { ok: false, reason: `Scout citation path escapes the workspace: ${citation.path}` };
	}
	// A directory is a legal reconnaissance location. Existence is the whole
	// check available: there is no content to digest, no line count to bound the
	// cited line against, and no read span to ground it in, because a survey
	// lists a directory rather than reading it. Requiring a live read here would
	// reject the correct answer to every directory-survey task.
	if (input.filesystem.isDirectory?.(citedPath) === true) {
		return { ok: true, evidence: { ...citation, contentDigest: directoryCitationDigest(cwd, citedPath) } };
	}
	const content = input.filesystem.readFile(citedPath);
	if (content === null) return { ok: false, reason: `Scout citation cannot be read: ${citation.path}` };
	const lineCount = content.split(/\r\n|\r|\n/u).length;
	if (citation.line > lineCount) {
		return { ok: false, reason: `Scout citation is past end of file: ${citation.path}:${citation.line}` };
	}
	// Grounding: a line that exists is not a line anyone looked at. Where the
	// run's own read spans are known, the cited line has to fall inside one,
	// so an approximated or inferred line number cannot pass as observation.
	if (input.observedReadRanges !== undefined) {
		const spans = input.observedReadRanges.get(citedPath) ?? [];
		if (!spans.some(([start, end]) => citation.line >= start && citation.line <= end)) {
			const observed =
				spans.length === 0
					? "this run never read that file"
					: `this run read only ${spans.map(([start, end]) => `${start}-${end}`).join(", ")}`;
			return {
				ok: false,
				reason: `Scout citation is not grounded in a live read: ${citation.path}:${citation.line} (${observed})`,
			};
		}
	}
	return {
		ok: true,
		evidence: { ...citation, contentDigest: createHash("sha256").update(content, "utf8").digest("hex") },
	};
}

/**
 * Every citation on a strictly conforming result has to ground. One that does
 * not is a fabricated location on a report claiming `pass`, so it fails the
 * whole result; this check is the only thing standing between an invented
 * `path:line` and a quality label the router believes.
 */
function validateScoutCitations(
	input: ResultContractValidationInput,
	citations: ReadonlyArray<ScoutCitation>,
): { ok: true; evidence: ReadonlyArray<ScoutCitationEvidence> } | { ok: false; reason: string } {
	const evidence: ScoutCitationEvidence[] = [];
	for (const citation of citations) {
		const checked = validateScoutCitation(input, citation);
		if (!checked.ok) return checked;
		evidence.push(checked.evidence);
	}
	return { ok: true, evidence };
}

/**
 * Ground a degraded result without ever failing it. On a strict result an
 * ungrounded citation is fabrication and fails the run; here the result already
 * carries no correctness label, so a citation that does not ground is simply
 * dropped and its claim demoted to an ungrounded lead. The parent gets what the
 * run actually observed, correctly labeled, instead of nothing.
 */
function groundDegradedScout(
	contract: ResultContract,
	input: ResultContractValidationInput,
	scout: ScoutResult,
	degradedReason: string,
): ResultContractValidation {
	const grounded: ScoutFinding[] = [];
	const evidence: ScoutCitationEvidence[] = [];
	const demoted: string[] = [];
	for (const finding of scout.findings) {
		const checked = validateScoutCitation(input, { path: finding.path, line: finding.line });
		if (checked.ok) {
			grounded.push(finding);
			evidence.push(checked.evidence);
			continue;
		}
		demoted.push(finding.claim);
	}
	const degraded: ScoutResult = {
		findings: grounded,
		citations: grounded.map(({ path: citedPath, line }) => ({ path: citedPath, line })),
		needsSplit: false,
		proposedSubtasks: [],
		ungroundedClaims: [...(scout.ungroundedClaims ?? []), ...demoted],
		degradedReason,
	};
	return success(contract, "unmeasured", { scout: degraded, evidence }, { scout: degraded, reason: degradedReason });
}

function validateVerifier(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "fail", `Verifier result payload failed: ${parsed.reason}`);
	const value = parsed.value;
	const unknown = Object.keys(value).filter((key) => key !== "verdict" && key !== "checks");
	if (unknown.length > 0) {
		return failure(
			contract,
			"fail",
			`Verifier result field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not legal; legal top-level fields are verdict and checks`,
		);
	}
	if (value.verdict !== "pass" && value.verdict !== "fail") {
		return failure(contract, "fail", 'Verifier field "verdict" must be one of: pass | fail');
	}
	if (!Array.isArray(value.checks) || value.checks.length === 0) {
		return failure(
			contract,
			"fail",
			'Verifier field "checks" must be a non-empty array of {name, passed, evidence}; each checks[].passed value must be one of: true | false',
		);
	}
	const checks: VerifierCheck[] = [];
	for (const [index, raw] of value.checks.entries()) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			return failure(contract, "fail", `Verifier field "checks[${index}]" must be an object`);
		}
		const check = raw as Record<string, unknown>;
		const checkUnknown = Object.keys(check).filter((key) => key !== "name" && key !== "passed" && key !== "evidence");
		if (checkUnknown.length > 0) {
			return failure(
				contract,
				"fail",
				`Verifier field "checks[${index}].${checkUnknown[0]}" is not legal; legal check fields are name, passed, and evidence`,
			);
		}
		if (!string(check.name)) {
			return failure(contract, "fail", `Verifier field "checks[${index}].name" must be a non-empty string`);
		}
		if (typeof check.passed !== "boolean") {
			return failure(contract, "fail", `Verifier field "checks[${index}].passed" must be one of: true | false`);
		}
		if (!string(check.evidence)) {
			return failure(contract, "fail", `Verifier field "checks[${index}].evidence" must be a non-empty string`);
		}
		checks.push({ name: check.name, passed: check.passed, evidence: check.evidence });
	}
	if ((value.verdict === "pass") !== checks.every((check) => check.passed)) {
		return failure(
			contract,
			"fail",
			'Verifier field "verdict" must agree with every checks[].passed value; verdict legal values are pass | fail and checks[].passed legal values are true | false',
		);
	}
	const verifier: VerifierResult = { verdict: value.verdict, checks };
	return success(contract, value.verdict, verifier, { verifier });
}

/**
 * Parse a Verifier structured result under the same schema its recipe contract
 * enforces. The review gate needs the verdict itself, not just its conformance
 * label, so this exposes the parsed payload the way `parseScoutResult` does for
 * reconnaissance. It defines no new schema.
 */
export function parseVerifierResult(output: string | null): VerifierResult | null {
	const validation = validateVerifier({ kind: "verifier-report" }, output);
	return validation.verifier ?? null;
}

/**
 * An advisory opinion is never a correctness signal about the route that
 * produced it, so conformance is judged on the shape alone and quality stays
 * `unmeasured`. `citedDecisions` may be empty: an honest advisor that found no
 * settled decision bearing on the question must be able to say so.
 */
function validateOracle(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["verdict", "challenge", "changesMyMind", "citedDecisions"]) ||
		!string(value.verdict) ||
		!string(value.challenge) ||
		!string(value.changesMyMind) ||
		!Array.isArray(value.citedDecisions) ||
		value.citedDecisions.some((entry) => !string(entry))
	) {
		return failure(
			contract,
			"unmeasured",
			'Oracle result must carry verdict, challenge, changesMyMind, and a citedDecisions array of strings, for example {"verdict":"consistent with decision routing.target","challenge":"...","changesMyMind":"...","citedDecisions":["routing.target"]}',
		);
	}
	return success(contract, "unmeasured", value);
}

/** Parse an oracle answer under the same schema its recipe contract enforces. */
export function parseOracleResult(output: string | null): OracleResult | null {
	const validation = validateOracle({ kind: "oracle-report" }, output);
	if (validation.conformance !== "pass") return null;
	const parsed = parseJson(output);
	if (!parsed.ok) return null;
	return {
		verdict: String(parsed.value.verdict),
		challenge: String(parsed.value.challenge),
		changesMyMind: String(parsed.value.changesMyMind),
		citedDecisions: (parsed.value.citedDecisions as ReadonlyArray<string>).map((entry) => String(entry)),
	};
}

/**
 * A code step's result is always `unmeasured` for routing quality. A red suite
 * is evidence about the repository, not about the route that ran the command,
 * and code steps are not routes: they never reach route history or the routing
 * quality reducer. Conformance here judges the shape alone, so a failing
 * command still produces a conformant report that crosses its outgoing edges.
 */
function validateCodeReport(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["passed", "exitCode", "checks", "artifactPaths", "outputExcerpt"]) ||
		typeof value.passed !== "boolean" ||
		typeof value.exitCode !== "number" ||
		!Number.isSafeInteger(value.exitCode) ||
		typeof value.outputExcerpt !== "string" ||
		!Array.isArray(value.artifactPaths) ||
		value.artifactPaths.some((entry) => !string(entry))
	) {
		return failure(
			contract,
			"unmeasured",
			"Code result must carry passed, integer exitCode, checks, artifactPaths, and outputExcerpt",
		);
	}
	const checks = parseChecks(value.checks);
	if (checks === null) return failure(contract, "unmeasured", "Code result must carry typed checks");
	if (value.passed !== (value.exitCode === 0) || value.passed !== checks.every((check) => check.passed)) {
		return failure(contract, "unmeasured", "Code result passed must agree with its exit code and every check");
	}
	return success(contract, "unmeasured", value);
}

/** Parse a `code-report` payload for callers that need the structured result. */
export function parseCodeReport(output: string | null): CodeReportResult | null {
	const validation = validateCodeReport({ kind: "code-report" }, output);
	if (validation.conformance !== "pass" || output === null) return null;
	// The same reader the validator used, so a fenced payload that passed
	// validation cannot fail here on a re-parse of the raw text.
	const parsed = parseJsonObjectPayload(output);
	if (!parsed.ok) return null;
	const value = parsed.value as unknown as CodeReportResult;
	return {
		passed: value.passed,
		exitCode: value.exitCode,
		checks: value.checks.map((check) => ({ ...check })),
		artifactPaths: [...value.artifactPaths],
		outputExcerpt: value.outputExcerpt,
	};
}

/**
 * Bytes of authored commit message a terminal result may carry. A commit
 * subject and a short body fit; a pasted diff does not.
 */
export const RESULT_COMMIT_MESSAGE_MAX_BYTES = 1_000;

/** Authored prose a work-product contract may carry beside its evidence. */
export interface ResultAuthorship {
	/** The agent's proposed commit message for the work it just produced. */
	commitMessage: string | null;
	/** One-line description, used to build a deterministic fallback message. */
	summary: string | null;
}

const AUTHORSHIP_FIELDS: ReadonlyArray<keyof ResultAuthorship> = ["commitMessage", "summary"];

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x7f) return true;
		if (code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") return true;
	}
	return false;
}

function normalizeAuthored(value: string): string {
	return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
}

/**
 * Optional authored fields, checked only for shape. Code owns committing; the
 * agent only supplies the sentence, so the sentence is bounded and free of the
 * control characters that would make a commit log unreadable.
 */
function validateAuthorship(value: Record<string, unknown>): string | null {
	for (const field of AUTHORSHIP_FIELDS) {
		const raw = value[field];
		// Absent, null, and blank are three spellings of the same thing: nothing
		// was authored. `ResultAuthorship` types the field `string | null` and
		// `resultContractAuthorship` already normalizes a blank to null, so
		// failing here on a spelling this contract's own reader accepts ends a
		// finished run over an optional field the agent correctly left empty.
		if (raw === undefined || raw === null) continue;
		if (typeof raw !== "string") return `${field} must be a string when present`;
		if (raw.trim().length === 0) continue;
		if (Buffer.byteLength(raw, "utf8") > RESULT_COMMIT_MESSAGE_MAX_BYTES) {
			return `${field} must be at most ${RESULT_COMMIT_MESSAGE_MAX_BYTES} bytes`;
		}
		// Tab, newline, and carriage return are the only control bytes a message
		// may carry; anything else would corrupt the log it lands in.
		if (hasControlCharacters(raw)) return `${field} must not contain control characters`;
	}
	return null;
}

/**
 * Read the authored commit message and summary from a terminal result.
 *
 * Only work-product contracts carry them: `mutation-report` validates them
 * strictly as optional fields, and `architect-plan` reads them from a JSON
 * answer if one was given, because that contract's postcondition is the plan
 * artifact and its final text has never been constrained. Anything unreadable
 * is simply absent, which the caller turns into its deterministic fallback
 * rather than into a failed commit.
 */
export function resultContractAuthorship(contract: ResultContract, output: string | null): ResultAuthorship {
	const empty: ResultAuthorship = { commitMessage: null, summary: null };
	if (contract.kind !== "mutation-report" && contract.kind !== "architect-plan") return empty;
	const parsed = parseJson(output);
	if (!parsed.ok || validateAuthorship(parsed.value) !== null) return empty;
	const read = (field: keyof ResultAuthorship): string | null => {
		const raw = parsed.value[field];
		if (typeof raw !== "string") return null;
		const normalized = normalizeAuthored(raw);
		return normalized.length === 0 ? null : normalized;
	};
	return { commitMessage: read("commitMessage"), summary: read("summary") };
}

function validateDebugger(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", `Debugger result payload failed: ${parsed.reason}`);
	const value = parsed.value;
	const unknown = Object.keys(value).filter(
		(key) => key !== "diagnosis" && key !== "reproduction" && key !== "evidence",
	);
	if (unknown.length > 0) {
		return failure(
			contract,
			"unmeasured",
			`Debugger result field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not legal; legal top-level fields are diagnosis, reproduction, and evidence`,
		);
	}
	if (!string(value.diagnosis)) {
		return failure(contract, "unmeasured", 'Debugger field "diagnosis" must be a non-empty string');
	}
	if (
		value.reproduction !== "reproduced" &&
		value.reproduction !== "not-reproduced" &&
		value.reproduction !== "unknown"
	) {
		return failure(
			contract,
			"unmeasured",
			'Debugger field "reproduction" must be one of: reproduced | not-reproduced | unknown',
		);
	}
	if (!Array.isArray(value.evidence)) {
		return failure(contract, "unmeasured", 'Debugger field "evidence" must be an array of strings');
	}
	const malformedEvidence = value.evidence.findIndex((entry) => !string(entry));
	if (malformedEvidence >= 0) {
		return failure(contract, "unmeasured", `Debugger field "evidence[${malformedEvidence}]" must be a non-empty string`);
	}
	return success(contract, "unmeasured", value);
}

function validateResearch(
	contract: ResultContract,
	output: string | null,
	networkAllowed: boolean,
): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", `Research result payload failed: ${parsed.reason}`);
	const value = parsed.value;
	const unknown = Object.keys(value).filter((key) => key !== "source" && key !== "findings");
	if (unknown.length > 0) {
		return failure(
			contract,
			"unmeasured",
			`Research result field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not legal; legal top-level fields are source and findings`,
		);
	}
	if (value.source !== "local" && value.source !== "external") {
		return failure(contract, "unmeasured", 'Research field "source" must be one of: local | external');
	}
	if (!Array.isArray(value.findings)) {
		return failure(contract, "unmeasured", 'Research field "findings" must be an array of {claim, evidence} objects');
	}
	if (value.source === "external" && !networkAllowed) {
		return failure(
			contract,
			"unmeasured",
			'Research field "source" is external but the run has no allowed network posture; legal values are local | external, and use local for workspace-only evidence',
		);
	}
	for (const [index, finding] of value.findings.entries()) {
		if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
			return failure(contract, "unmeasured", `Research field "findings[${index}]" must be an object`);
		}
		const record = finding as Record<string, unknown>;
		const findingUnknown = Object.keys(record).filter((key) => key !== "claim" && key !== "evidence");
		if (findingUnknown.length > 0) {
			return failure(
				contract,
				"unmeasured",
				`Research field "findings[${index}].${findingUnknown[0]}" is not legal; legal finding fields are claim and evidence`,
			);
		}
		if (!string(record.claim)) {
			return failure(contract, "unmeasured", `Research field "findings[${index}].claim" must be a non-empty string`);
		}
		if (!string(record.evidence)) {
			return failure(contract, "unmeasured", `Research field "findings[${index}].evidence" must be a non-empty string`);
		}
	}
	return success(contract, "unmeasured", value);
}

/** Paths this run wrote, as workspace-relative names, for a validator reason. */
function describeWriteSet(effects: ObservedRunEffects, cwd: string): string {
	if (effects.mutatedPaths.size === 0) return "this run wrote nothing";
	const written = [...effects.mutatedPaths]
		.map((target) => path.relative(cwd, target) || target)
		.sort()
		.slice(0, MUTATION_WRITE_SET_REASON_LIMIT);
	const more = effects.mutatedPaths.size - written.length;
	return `this run wrote ${written.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** Written paths quoted back in one validator reason before it is truncated. */
const MUTATION_WRITE_SET_REASON_LIMIT = 8;

/**
 * Whether anything is at this location. Without a presence check the validator
 * cannot tell a fabricated path from a directory or an unreadable file, so it
 * answers yes and lets the quality label carry the doubt.
 */
function pathIsPresent(filesystem: ResultContractFilesystem, target: string): boolean {
	if (filesystem.pathExists === undefined) return true;
	return filesystem.pathExists(target);
}

/** One `validations` entry, quoted by every reason that rejects the array. */
const MUTATION_VALIDATION_EXAMPLE = '{"name":"npm test","passed":true,"evidence":"exit 0"}';

/**
 * Why a `validations` array was refused, in terms the model can act on. Naming
 * the requirement was not enough for a small local model (#74): a run that
 * emitted `"validations":[]` read the reason as satisfied, spent both repair
 * rounds re-emitting the same empty array, and failed `result_contract_exhausted`.
 * The two ways to get this wrong need different corrections, so each reason
 * says which one happened and shows the entry that would have passed.
 */
function mutationValidationsReason(value: unknown): string {
	const empty = Array.isArray(value) && value.length === 0;
	if (empty) {
		return `Mutation result must carry typed validation results: validations was empty. Emit one entry per check this run actually made, each shaped like ${MUTATION_VALIDATION_EXAMPLE}. A run that only read files still names the read and cites what it saw.`;
	}
	return `Mutation result must carry typed validation results: every validations entry is shaped like ${MUTATION_VALIDATION_EXAMPLE}, with a string name, a boolean passed, a string evidence, and no other keys.`;
}

/**
 * A mutation report states what the run changed and what it validated. Shape
 * alone cannot tell either claim from an invention, and the shape example this
 * module prints ends up echoed verbatim by small models, so a run that touched
 * nothing has sealed `mutatedPaths: ["src/file.ts"]` as conforming fact.
 *
 * Where the run's own effects were observed, each reported path is measured
 * against them:
 *   - in the write set                   -> the run did this, and it is verified
 *   - its only attempt came back refused -> the run's own tool result says the
 *     write did not land, so the claim is false however the file looks on disk
 *   - absent from it but present on disk -> the run may have written it through
 *     a channel no tool event enumerates, so this is not a failure, but it is
 *     not verified either
 *   - absent from both                   -> nothing this run did could have
 *     produced it, which is a failed postcondition, not a quality signal
 *
 * Quality follows the same rule as conformance. A reported validation the run
 * never ran is not correctness evidence, so it seals `unmeasured` (the label
 * this module already uses for "nothing here can be measured") instead of
 * pass. A self-reported failure still seals `fail`: an agent reporting against
 * its own interest is the one claim here that needs no corroboration.
 */
function validateMutation(contract: ResultContract, input: ResultContractValidationInput): ResultContractValidation {
	const parsed = parseJson(input.output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["mutatedPaths", "validations", "commitMessage", "summary"]) ||
		!Array.isArray(value.mutatedPaths) ||
		value.mutatedPaths.some((entry) => !string(entry))
	) {
		return failure(contract, "unmeasured", "Mutation result must carry mutatedPaths and validations");
	}
	const authorship = validateAuthorship(value);
	if (authorship !== null) return failure(contract, "unmeasured", authorship);
	const validations = parseChecks(value.validations);
	if (validations === null) return failure(contract, "unmeasured", mutationValidationsReason(value.validations));
	const reportedFailure = !validations.every((check) => check.passed);
	const effects = input.observedRunEffects;
	if (effects === undefined) return success(contract, reportedFailure ? "fail" : "pass", value);
	const cwd = path.resolve(input.cwd);
	let unverifiedMutation = false;
	for (const reported of value.mutatedPaths as ReadonlyArray<string>) {
		const target = path.resolve(cwd, reported);
		if (effects.mutatedPaths.has(target)) continue;
		if (effects.failedMutationPaths.has(target)) {
			return failure(
				contract,
				"unmeasured",
				`Mutation result names a path whose only write this run attempted was refused: ${reported} (${describeWriteSet(effects, cwd)})`,
			);
		}
		if (pathIsPresent(input.filesystem, target)) {
			unverifiedMutation = true;
			continue;
		}
		return failure(
			contract,
			"unmeasured",
			`Mutation result names a path this run never wrote and that does not exist: ${reported} (${describeWriteSet(effects, cwd)})`,
		);
	}
	if (reportedFailure) return success(contract, "fail", value);
	const measured = !unverifiedMutation && effects.validationCommands.size > 0;
	return success(contract, measured ? "pass" : "unmeasured", value);
}

function validateProvenance(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["confirmedFacts", "missingEvidence", "nextInspections"]) ||
		![value.confirmedFacts, value.missingEvidence, value.nextInspections].every(
			(entry) => Array.isArray(entry) && entry.every((item) => string(item)),
		)
	) {
		return failure(
			contract,
			"unmeasured",
			"Provenance result must carry confirmedFacts, missingEvidence, and nextInspections",
		);
	}
	return success(contract, "unmeasured", value);
}

function validateArchitect(
	contract: Extract<ResultContract, { kind: "architect-plan" }>,
	input: ResultContractValidationInput,
): ResultContractValidation {
	const artifactPath = path.resolve(input.cwd, contract.path);
	const content = input.filesystem.readFile(artifactPath);
	if (content === null || content.trim().length === 0) {
		return failure(contract, "unmeasured", `required plan artifact is missing or empty: ${contract.path}`);
	}
	return success(contract, "unmeasured", {
		path: contract.path,
		artifactDigest: createHash("sha256").update(content, "utf8").digest("hex"),
	});
}

/**
 * Validate one terminal result under its recipe's typed contract. The caller
 * supplies filesystem access so this module stays deterministic and testable.
 */
/**
 * Parse the Scout structured result for model-facing task decomposition.
 * Strict on purpose: this feeds the `from_scout` continuation, where a subtask
 * becomes a real dispatch, so a degraded result is rejected here even though it
 * conforms as a terminal result. Degraded reconnaissance is readable evidence,
 * never a control-plane input.
 */
export function parseScoutResult(output: string): ScoutResult | null {
	const validation = validateScout({ kind: "scout-report" }, output);
	if (validation.conformance !== "pass" || validation.scout === undefined) return null;
	return validation.scout.degradedReason === undefined ? validation.scout : null;
}

export function validateResultContract(input: ResultContractValidationInput): ResultContractValidation {
	switch (input.contract.kind) {
		case "architect-plan":
			return validateArchitect(input.contract, input);
		case "scout-report": {
			const validation = validateScout(input.contract, input.output);
			if (validation.scout === undefined) return validation;
			const degradedReason = validation.scout.degradedReason;
			if (degradedReason !== undefined) {
				return groundDegradedScout(input.contract, input, validation.scout, degradedReason);
			}
			const citations = validateScoutCitations(input, validation.scout.citations);
			return citations.ok
				? success(
						input.contract,
						"pass",
						{ scout: validation.scout, evidence: citations.evidence },
						{ scout: validation.scout },
					)
				: failure(input.contract, "fail", citations.reason);
		}
		case "verifier-report":
			return validateVerifier(input.contract, input.output);
		case "council-report": {
			const report = parseCouncilReport(input.output);
			return report === null
				? failure(input.contract, "fail", "council-report is malformed")
				: success(input.contract, "unmeasured", { council: report });
		}
		case "council-ballot":
			return validateCouncilBallot(input.contract, input.output);
		case "debugger-report":
			return validateDebugger(input.contract, input.output);
		case "research-report":
			return validateResearch(input.contract, input.output, input.networkAllowed);
		case "mutation-report":
			return validateMutation(input.contract, input);
		case "provenance-report":
			return validateProvenance(input.contract, input.output);
		case "delegation-plan": {
			const plan = parseDelegationPlanResult(input.output);
			return plan === null
				? failure(
						input.contract,
						"fail",
						"delegation-plan must carry tasks with id, agent, description, depends_on, writes, and optional mode",
					)
				: success(input.contract, "unmeasured", plan, { delegationPlan: plan });
		}
		case "oracle-report":
			return validateOracle(input.contract, input.output);
		case "external-delegation":
			return success(input.contract, "unmeasured", { external: true });
		case "artifact-report":
			// Nothing here can be measured: the artifact lives at a location only
			// the caller knows, so the caller checks it. Any terminal text
			// conforms, which is what stops a bounded repair round from being
			// spent teaching a writer a JSON shape that proves nothing.
			return success(input.contract, "unmeasured", { artifact: true });
		case "context-handbook":
			return validateContextHandbook(input.contract, input.output);
		case "code-report":
			return validateCodeReport(input.contract, input.output);
	}
}

/** Validate a recipe's final result and project it into receipt-safe facts. */
export function validateRecipeResult(input: ValidateRecipeResultInput): RecipeResultOutcome | null {
	if (input.contract === null) return null;
	if (!input.reachedTerminalResult) {
		return {
			applicable: false,
			fact: {
				sourceId: resultContractSourceId(input.contract),
				validatorDigest: digest({ contract: input.contract, reached: false }),
				conformance: "not-reached",
				quality: "unmeasured",
			},
		};
	}
	const validation = validateResultContract({
		contract: input.contract,
		output: input.output,
		cwd: input.cwd,
		networkAllowed: input.networkAllowed,
		filesystem: input.filesystem,
		...(input.observedRunEffects !== undefined ? { observedRunEffects: input.observedRunEffects } : {}),
	});
	return {
		applicable: true,
		validation,
		fact: {
			sourceId: validation.sourceId,
			validatorDigest: validation.validatorDigest,
			conformance: validation.conformance,
			quality: validation.quality,
		},
	};
}

/**
 * Bounded in-worker repair rounds for a terminal result that missed its
 * contract. A local model with few active parameters routinely gathers correct
 * evidence and then emits the wrong terminal shape; without feedback that run
 * is lost. Two rounds is the whole allowance, and the run fails after them.
 */
export const RESULT_CONTRACT_REPAIR_LIMIT = 2;

/** Live-read anchors quoted back to the model in a repair round. */
export const RESULT_CONTRACT_ANCHOR_LIMIT = 12;

/**
 * The exact terminal shape each contract accepts, quoted to the model verbatim.
 * This is the one place a contract's wire example is written; agent recipes,
 * repair rounds, and a fleet node's own answer directive all cite it, so a
 * prompt cannot drift from its validator.
 */
export function resultContractShape(contract: ResultContract): string {
	switch (contract.kind) {
		case "architect-plan":
			return `a plan artifact written to ${contract.path}, then optionally {"commitMessage":"...","summary":"..."} describing it`;
		case "scout-report":
			// The third alternative is the floor this validator actually accepts.
			// A repair round that only ever restates the strict shape is what the
			// run already failed twice, so it is told the cheaper exit as well.
			return '{"findings":[{"claim":"what you observed","path":"src/file.ts","line":1}],"needsSplit":false,"proposedSubtasks":[]} or {"findings":[],"needsSplit":true,"proposedSubtasks":[{"id":"inspect","task":"Inspect the boundary","dependencies":[],"expectedResultContract":"scout-report","requestedAuthority":"read-only"}]} or, if you cannot produce a citation you are sure of, at least {"findings":[{"claim":"what you observed"}]}, which is accepted as an ungrounded lead rather than losing the run';
		case "verifier-report":
			return 'one of {"verdict":"pass","checks":[{"name":"npm run typecheck","passed":true,"evidence":"exit 0"}]} or {"verdict":"fail","checks":[{"name":"npm run typecheck","passed":false,"evidence":"exit 1"}]}; verdict legal values are pass | fail and checks[].passed legal values are true | false';
		case "council-report":
			return '{"members":[{"label":"alpha","runId":"run-1","round":1,"answer":"..."}],"synthesis":{"kind":"none"}}';
		case "council-ballot":
			return COUNCIL_BALLOT_SHAPE;
		case "debugger-report":
			return 'one of {"diagnosis":"...","reproduction":"reproduced","evidence":["..."]}, {"diagnosis":"...","reproduction":"not-reproduced","evidence":["..."]}, or {"diagnosis":"...","reproduction":"unknown","evidence":["..."]}; reproduction legal values are reproduced | not-reproduced | unknown';
		case "research-report":
			return 'one of {"source":"local","findings":[{"claim":"...","evidence":"..."}]} or {"source":"external","findings":[{"claim":"...","evidence":"..."}]}; source legal values are local | external';
		case "mutation-report":
			return '{"mutatedPaths":["src/file.ts"],"validations":[{"name":"npm test","passed":true,"evidence":"exit 0"}],"commitMessage":"optional: the commit message for this change","summary":"optional: one line"}';
		case "provenance-report":
			return '{"confirmedFacts":["..."],"missingEvidence":["..."],"nextInspections":["..."]}';
		case "delegation-plan":
			return '{"tasks":[{"id":"build","agent":"coder","description":"Implement the change","depends_on":[],"writes":["src"],"mode":"parallel"}]}';
		case "oracle-report":
			return '{"verdict":"one line","challenge":"the strongest objection you can mount","changesMyMind":"the evidence that would reverse the verdict","citedDecisions":["decision key or task id you relied on"]}';
		case "external-delegation":
			return "any final text";
		case "artifact-report":
			return "any final text; the artifact you wrote at the location the task named is the result";
		case "context-handbook":
			return '{"projectName":"string","identity":"one sentence","conventions":[],"invariants":[],"sections":[{"title":"Architecture","body":"markdown that cites `real/path.ts` tokens"}]}';
		case "code-report":
			return '{"passed":false,"exitCode":1,"checks":[{"name":"test","passed":false,"evidence":"exit 1"}],"artifactPaths":["/path/command.log"],"outputExcerpt":"..."}';
	}
}

export interface ResultContractRepairInput {
	contract: ResultContract;
	/** The validator's own reason; never a paraphrase. */
	reason: string;
	/** 1-based repair round. */
	attempt: number;
	/** `path:line` anchors from reads that succeeded in this run. */
	anchors: ReadonlyArray<string>;
	/** True only when admission preauthorized a larger tool-call revision phase. */
	toolsAvailable?: boolean;
}

/**
 * One repair directive. It states the validator's reason and exact shape. Tool
 * use remains closed unless dispatch preauthorized a larger revision phase.
 */
function resultContractRepairMessage(input: ResultContractRepairInput): string {
	const last = input.attempt >= RESULT_CONTRACT_REPAIR_LIMIT;
	const lines = [
		last
			? "FINAL RESULT REQUIRED IN THIS RESPONSE. Your previous response still did not satisfy this run's result contract."
			: "Your previous response did not satisfy this run's result contract.",
		`Validator reason: ${input.reason}`,
		input.toolsAvailable === true
			? "You may use the admitted tools to repair this validator failure, then emit the required terminal result."
			: "Tool use is over. Answer from the evidence you already gathered.",
		`Emit exactly this shape and nothing else: ${resultContractShape(input.contract)}`,
		"Do not add prose, code fences, or commentary around it. Do not describe work you intend to do next.",
	];
	if (input.anchors.length > 0) {
		lines.push(
			"",
			"Locations you read successfully in this run (use these exact path:line values):",
			...input.anchors.slice(-RESULT_CONTRACT_ANCHOR_LIMIT).map((anchor) => `- ${anchor}`),
		);
	}
	return lines.join("\n");
}

/** Name of the synthetic tool call that carries a repair round. */
export const RESULT_CONTRACT_REPAIR_TOOL = "result_contract";

/**
 * One repair round as a protocol-legal tool exchange: a synthetic assistant
 * call to `result_contract` and the tool result that answers it, sharing the
 * id `clio-result-contract-repair-N`. Strict endpoints (OpenAI, Anthropic)
 * reject a tool result no assistant call issued; local servers tolerated the
 * bare result, and this keeps the history-append shape #55 measured while
 * satisfying both. `stopReason: "toolUse"` and the toolCall block keep the
 * assistant half out of terminal validation, durable output, and the
 * synthesis sanitizer.
 *
 * The assistant half carries explicit zero usage. pi-ai's context estimator
 * (`estimateContextTokens`, run while sizing every request) dereferences
 * `usage` on any assistant message not marked `aborted`/`error`, so a
 * usage-less `toolUse` message throws `Cannot read properties of undefined
 * (reading 'totalTokens')` on the very next model round and the worker dies
 * with the contract `not-reached` (#70). Zero usage keeps the estimator on
 * the model's last real usage and its byte-for-byte prompt-cache behavior.
 */
export function resultContractRepairMessages(
	input: ResultContractRepairInput,
	origin: { provider: string; api: string; model: string },
) {
	const id = `clio-result-contract-repair-${input.attempt}`;
	const timestamp = Date.now();
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: RESULT_CONTRACT_REPAIR_TOOL, arguments: {} }],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			...origin,
			timestamp,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: RESULT_CONTRACT_REPAIR_TOOL,
			content: [{ type: "text", text: resultContractRepairMessage(input) }],
			isError: true,
			timestamp,
		},
	] as const;
}

/** Kinds an agent recipe may declare in its frontmatter. */
const RECIPE_DECLARABLE_KINDS = [
	"scout-report",
	"verifier-report",
	"council-report",
	"debugger-report",
	"research-report",
	"mutation-report",
	"provenance-report",
	"oracle-report",
	"external-delegation",
	"artifact-report",
	"context-handbook",
	"delegation-plan",
] as const;

/**
 * Kinds the coordinator authors and hands to a worker on the wire, which no
 * recipe may declare. A council ballot is the topology's postcondition for a
 * vote member's slot, so it arrives as a `resultContractOverride` on the
 * request and never out of frontmatter.
 */
const COORDINATOR_AUTHORED_KINDS = ["council-ballot"] as const;

function parseContract(value: unknown, sourcePath: string, kinds: ReadonlyArray<string>): ResultContract {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`agent recipe: ${sourcePath}: resultContract must be an object`);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.kind !== "string") throw new Error(`agent recipe: ${sourcePath}: resultContract.kind is required`);
	const keys = Object.keys(record);
	const only = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key));
	if (record.kind === "architect-plan") {
		if (!only("kind", "path") || !string(record.path)) {
			throw new Error(`agent recipe: ${sourcePath}: architect-plan requires only non-empty path`);
		}
		if (path.isAbsolute(record.path) || record.path.split(/[\\/]/u).includes("..")) {
			throw new Error(`agent recipe: ${sourcePath}: architect-plan path must be workspace-relative`);
		}
		return { kind: "architect-plan", path: record.path };
	}
	if (!kinds.includes(record.kind) || !only("kind")) {
		throw new Error(`agent recipe: ${sourcePath}: resultContract.kind is unsupported or has unknown keys`);
	}
	return { kind: record.kind as Exclude<ResultContract["kind"], "architect-plan"> };
}

/** Strict frontmatter parser for the one recipe result-contract schema. */
export function parseResultContract(value: unknown, sourcePath: string): ResultContract {
	return parseContract(value, sourcePath, RECIPE_DECLARABLE_KINDS);
}

/**
 * The same parser for a contract that arrived on a WorkerSpec. It admits what a
 * recipe may declare plus what the coordinator may author, because a dispatch
 * request can override the seated recipe's postcondition and the worker has to
 * be able to read the contract it will be validated against. Keeping the recipe
 * parser strict is the point: a recipe still cannot claim a coordinator's kind.
 */
export function parseWorkerResultContract(value: unknown, sourcePath: string): ResultContract {
	return parseContract(value, sourcePath, [...RECIPE_DECLARABLE_KINDS, ...COORDINATOR_AUTHORED_KINDS]);
}
