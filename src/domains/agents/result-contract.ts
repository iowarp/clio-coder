import { createHash } from "node:crypto";
import path from "node:path";
import { AGENT_AUTOMATION_AUTHORITIES, type AgentAutomationAuthority } from "./spec.js";

export type ResultContract =
	| { kind: "architect-plan"; path: string }
	| { kind: "scout-report" }
	| { kind: "verifier-report" }
	| { kind: "debugger-report" }
	| { kind: "research-report" }
	| { kind: "mutation-report" }
	| { kind: "provenance-report" }
	| { kind: "external-delegation" }
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
	reason?: string;
}

export interface ResultContractFilesystem {
	readFile(path: string): string | null;
}

/**
 * Inclusive `[start, end]` line spans a run actually observed, by absolute
 * path. Grounding is only checkable where this evidence exists, which is the
 * worker that made the reads.
 */
export type ObservedReadRanges = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

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
	extra: Pick<ResultContractValidation, "scout" | "verifier"> = {},
): ResultContractValidation {
	return {
		conformance: "pass",
		quality,
		sourceId: resultContractSourceId(contract),
		validatorDigest: digest({ contract, value }),
		...extra,
	};
}

function parseJson(
	output: string | null,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
	if (output === null || output.trim().length === 0) return { ok: false, reason: "missing final result" };
	try {
		const value = JSON.parse(output) as unknown;
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return { ok: false, reason: "result must be a JSON object" };
		}
		return { ok: true, value: value as Record<string, unknown> };
	} catch {
		return { ok: false, reason: "result must be valid JSON" };
	}
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

function isBootstrapScoutResult(value: Record<string, unknown>): boolean {
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

function validateScout(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "fail", parsed.reason);
	const value = parsed.value;
	// Bootstrap explicitly replaces Scout's ordinary reconnaissance result with
	// its own provider-enforced schema. It is a typed conformance variant, not
	// correctness evidence, so it remains unmeasured for routing quality.
	if (isBootstrapScoutResult(value)) return success(contract, "unmeasured", value);
	if (!hasOnlyKeys(value, ["findings", "needsSplit", "proposedSubtasks"])) {
		return failure(contract, "fail", "Scout result has unknown fields");
	}
	const findings = parseFindings(value.findings);
	const proposedSubtasks = parseSubtasks(value.proposedSubtasks);
	if (findings === null || typeof value.needsSplit !== "boolean" || proposedSubtasks === null) {
		return failure(
			contract,
			"fail",
			"Scout result must carry findings as {claim, path, line} objects, needsSplit, and 0..4 typed proposed subtasks",
		);
	}
	if (value.needsSplit !== proposedSubtasks.length > 0) {
		return failure(contract, "fail", "Scout needsSplit must agree with proposedSubtasks");
	}
	// A grounded report needs at least one cited claim. A split recommendation
	// is the explicit exception: it reports that the task did not fit, so it
	// carries subtasks instead of findings.
	if (findings.length === 0 && !value.needsSplit) {
		return failure(contract, "fail", "Scout result must carry at least one cited finding, or set needsSplit");
	}
	if (value.needsSplit && findings.length > 0) {
		return failure(contract, "fail", "Scout split recommendations carry typed subtasks instead of findings");
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

function validateScoutCitations(
	input: ResultContractValidationInput,
	citations: ReadonlyArray<ScoutCitation>,
): { ok: true; evidence: ReadonlyArray<ScoutCitation & { contentDigest: string }> } | { ok: false; reason: string } {
	const cwd = path.resolve(input.cwd);
	const evidence: Array<ScoutCitation & { contentDigest: string }> = [];
	for (const citation of citations) {
		const citedPath = path.resolve(cwd, citation.path);
		const relative = path.relative(cwd, citedPath);
		if (relative === "" || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
			return { ok: false, reason: `Scout citation path escapes the workspace: ${citation.path}` };
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
		evidence.push({ ...citation, contentDigest: createHash("sha256").update(content, "utf8").digest("hex") });
	}
	return { ok: true, evidence };
}

function validateVerifier(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "fail", parsed.reason);
	const value = parsed.value;
	if (!hasOnlyKeys(value, ["verdict", "checks"]) || (value.verdict !== "pass" && value.verdict !== "fail")) {
		return failure(contract, "fail", "Verifier result must carry pass or fail verdict and checks");
	}
	const checks = parseChecks(value.checks);
	if (checks === null || (value.verdict === "pass") !== checks.every((check) => check.passed)) {
		return failure(contract, "fail", "Verifier verdict must agree with every typed check");
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
	const value = JSON.parse(output) as CodeReportResult;
	return {
		passed: value.passed,
		exitCode: value.exitCode,
		checks: value.checks.map((check) => ({ ...check })),
		artifactPaths: [...value.artifactPaths],
		outputExcerpt: value.outputExcerpt,
	};
}

function validateDebugger(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["diagnosis", "reproduction", "evidence"]) ||
		!string(value.diagnosis) ||
		(value.reproduction !== "reproduced" &&
			value.reproduction !== "not-reproduced" &&
			value.reproduction !== "unknown") ||
		!Array.isArray(value.evidence) ||
		value.evidence.some((entry) => !string(entry))
	) {
		return failure(
			contract,
			"unmeasured",
			"Debugger result must carry diagnosis, reproduction status, and evidence without a verdict",
		);
	}
	return success(contract, "unmeasured", value);
}

function validateResearch(
	contract: ResultContract,
	output: string | null,
	networkAllowed: boolean,
): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["source", "findings"]) ||
		(value.source !== "local" && value.source !== "external") ||
		!Array.isArray(value.findings)
	) {
		return failure(
			contract,
			"unmeasured",
			"Research result must distinguish local or external sources and carry findings",
		);
	}
	if (value.source === "external" && !networkAllowed) {
		return failure(contract, "unmeasured", "external research requires an allowed network posture");
	}
	for (const finding of value.findings) {
		if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
			return failure(contract, "unmeasured", "Research findings must be objects");
		}
		const record = finding as Record<string, unknown>;
		if (!hasOnlyKeys(record, ["claim", "evidence"]) || !string(record.claim) || !string(record.evidence)) {
			return failure(contract, "unmeasured", "Research findings must carry claim and evidence");
		}
	}
	return success(contract, "unmeasured", value);
}

function validateMutation(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	if (
		!hasOnlyKeys(value, ["mutatedPaths", "validations"]) ||
		!Array.isArray(value.mutatedPaths) ||
		value.mutatedPaths.some((entry) => !string(entry))
	) {
		return failure(contract, "unmeasured", "Mutation result must carry mutatedPaths and validations");
	}
	const validations = parseChecks(value.validations);
	if (validations === null)
		return failure(contract, "unmeasured", "Mutation result must carry typed validation results");
	return success(contract, validations.every((check) => check.passed) ? "pass" : "fail", value);
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
/** Parse the Scout structured result for model-facing task decomposition. */
export function parseScoutResult(output: string): ScoutResult | null {
	const validation = validateScout({ kind: "scout-report" }, output);
	return validation.conformance === "pass" && validation.scout !== undefined ? validation.scout : null;
}

export function validateResultContract(input: ResultContractValidationInput): ResultContractValidation {
	switch (input.contract.kind) {
		case "architect-plan":
			return validateArchitect(input.contract, input);
		case "scout-report": {
			const validation = validateScout(input.contract, input.output);
			if (validation.scout === undefined) return validation;
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
		case "debugger-report":
			return validateDebugger(input.contract, input.output);
		case "research-report":
			return validateResearch(input.contract, input.output, input.networkAllowed);
		case "mutation-report":
			return validateMutation(input.contract, input.output);
		case "provenance-report":
			return validateProvenance(input.contract, input.output);
		case "external-delegation":
			return success(input.contract, "unmeasured", { external: true });
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
 * This is the one place a contract's wire example is written; agent recipes and
 * repair rounds both cite it, so a prompt cannot drift from its validator.
 */
export function resultContractShape(contract: ResultContract): string {
	switch (contract.kind) {
		case "architect-plan":
			return `a plan artifact written to ${contract.path}`;
		case "scout-report":
			return '{"findings":[{"claim":"what you observed","path":"src/file.ts","line":1}],"needsSplit":false,"proposedSubtasks":[]} or {"findings":[],"needsSplit":true,"proposedSubtasks":[{"id":"inspect","task":"Inspect the boundary","dependencies":[],"expectedResultContract":"scout-report","requestedAuthority":"read-only"}]}';
		case "verifier-report":
			return '{"verdict":"pass","checks":[{"name":"npm run typecheck","passed":true,"evidence":"exit 0"}]}';
		case "debugger-report":
			return '{"diagnosis":"...","reproduction":"reproduced","evidence":["..."]}';
		case "research-report":
			return '{"source":"local","findings":[{"claim":"...","evidence":"..."}]}';
		case "mutation-report":
			return '{"mutatedPaths":["src/file.ts"],"validations":[{"name":"npm test","passed":true,"evidence":"exit 0"}]}';
		case "provenance-report":
			return '{"confirmedFacts":["..."],"missingEvidence":["..."],"nextInspections":["..."]}';
		case "external-delegation":
			return "any final text";
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
}

/**
 * One repair directive. It states the validator's reason, the exact shape, and
 * that tool use is over, so the model's only remaining move is to emit the
 * terminal document from evidence it already has.
 */
export function resultContractRepairMessage(input: ResultContractRepairInput): string {
	const last = input.attempt >= RESULT_CONTRACT_REPAIR_LIMIT;
	const lines = [
		last
			? "FINAL RESULT REQUIRED IN THIS RESPONSE. Your previous response still did not satisfy this run's result contract."
			: "Your previous response did not satisfy this run's result contract.",
		`Validator reason: ${input.reason}`,
		"Tool use is over. Answer from the evidence you already gathered.",
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

/** Strict frontmatter parser for the one recipe result-contract schema. */
export function parseResultContract(value: unknown, sourcePath: string): ResultContract {
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
	const kinds = [
		"scout-report",
		"verifier-report",
		"debugger-report",
		"research-report",
		"mutation-report",
		"provenance-report",
		"external-delegation",
	] as const;
	if (!(kinds as ReadonlyArray<string>).includes(record.kind) || !only("kind")) {
		throw new Error(`agent recipe: ${sourcePath}: resultContract.kind is unsupported or has unknown keys`);
	}
	return { kind: record.kind as Exclude<ResultContract["kind"], "architect-plan"> };
}
