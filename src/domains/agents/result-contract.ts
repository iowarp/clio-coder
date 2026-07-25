import { createHash } from "node:crypto";
import path from "node:path";

export type ResultContract =
	| { kind: "architect-plan"; path: string }
	| { kind: "scout-report" }
	| { kind: "verifier-report" }
	| { kind: "debugger-report" }
	| { kind: "research-report" }
	| { kind: "mutation-report" }
	| { kind: "provenance-report" }
	| { kind: "external-delegation" };

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

export interface ResultContractValidationInput {
	contract: ResultContract;
	output: string | null;
	cwd: string;
	networkAllowed: boolean;
	filesystem: ResultContractFilesystem;
}

/** Receipt-ready projection of the typed result validator. */
export interface ResultContractFact {
	sourceId: string;
	validatorDigest: string;
	conformance: "pass" | "fail";
	quality: ResultContractQuality;
}

export interface ValidateRecipeResultInput {
	contract: ResultContract | null;
	output: string | null;
	cwd: string;
	networkAllowed: boolean;
	filesystem: ResultContractFilesystem;
}

export interface ScoutCitation {
	path: string;
	line: number;
}

export interface ScoutResult {
	citations: ReadonlyArray<ScoutCitation>;
	needsSplit: boolean;
	proposedSubtasks: ReadonlyArray<string>;
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

function sourceId(contract: ResultContract): string {
	return `agent-result-contract:${contract.kind}:${resultContractDigest(contract)}`;
}

function failure(contract: ResultContract, quality: ResultContractQuality, reason: string): ResultContractValidation {
	return {
		conformance: "fail",
		quality,
		sourceId: sourceId(contract),
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
		sourceId: sourceId(contract),
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

function parseCitations(value: unknown): ScoutCitation[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const citations: ScoutCitation[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const citation = entry as Record<string, unknown>;
		const line = citation.line;
		if (
			!hasOnlyKeys(citation, ["path", "line"]) ||
			!string(citation.path) ||
			typeof line !== "number" ||
			!Number.isSafeInteger(line) ||
			line < 1
		) {
			return null;
		}
		citations.push({ path: citation.path, line });
	}
	return citations;
}

function parseSubtasks(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > 4 || value.some((entry) => !string(entry))) return null;
	return [...value] as string[];
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
	if (!hasOnlyKeys(value, ["citations", "needsSplit", "proposedSubtasks"])) {
		return failure(contract, "fail", "Scout result has unknown fields");
	}
	const citations = parseCitations(value.citations);
	const proposedSubtasks = parseSubtasks(value.proposedSubtasks);
	if (citations === null || typeof value.needsSplit !== "boolean" || proposedSubtasks === null) {
		return failure(contract, "fail", "Scout result must carry citations, needsSplit, and 0..4 proposed subtasks");
	}
	if (value.needsSplit !== proposedSubtasks.length > 0) {
		return failure(contract, "fail", "Scout needsSplit must agree with proposedSubtasks");
	}
	const scout: ScoutResult = { citations, needsSplit: value.needsSplit, proposedSubtasks };
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
	}
}

/** Validate a recipe's final result and project it into receipt-safe facts. */
export function validateRecipeResult(
	input: ValidateRecipeResultInput,
): { validation: ResultContractValidation; fact: ResultContractFact } | null {
	if (input.contract === null) return null;
	const validation = validateResultContract({
		contract: input.contract,
		output: input.output,
		cwd: input.cwd,
		networkAllowed: input.networkAllowed,
		filesystem: input.filesystem,
	});
	return {
		validation,
		fact: {
			sourceId: validation.sourceId,
			validatorDigest: validation.validatorDigest,
			conformance: validation.conformance,
			quality: validation.quality,
		},
	};
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
