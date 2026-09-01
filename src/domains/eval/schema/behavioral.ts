import { createHash } from "node:crypto";
import { normalizeEvalSchemaId } from "./naming.js";
import { EVAL_VERDICT_SCHEMA_V1, type EvalVerdictEnvelopeV1 } from "./verdict.js";

export const EVAL_BEHAVIOR_SCENARIO_SCHEMA_V1 = "clio-coder.eval.scenario.v1" as const;
export const EVAL_BEHAVIOR_SCHEMA_V1 = "clio-coder.eval.behavior.v1" as const;

export const EVAL_BEHAVIOR_CATEGORIES = [
	"tool_choice",
	"exploration",
	"delegation",
	"safety_comprehension",
	"claim_grounding",
	"denied_tool_recovery",
	"completion_behavior",
	"task_correctness",
] as const;

export type EvalBehaviorCategoryV1 = (typeof EVAL_BEHAVIOR_CATEGORIES)[number];
export type EvalBehaviorExecutionModeV1 = "machinery-only" | "model-required";
export type EvalBehaviorFactSourceV1 = "transcript" | "tool" | "receipt" | "grader";
export type EvalBehaviorRuleOpV1 = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
export type EvalBehaviorScalarV1 = string | number | boolean;
export type EvalBehaviorLabelV1 = "satisfied" | "violated" | "unknown" | "unmeasured";
export type EvalBehaviorOutcomeV1 = "pass" | "behavioral_failure" | "unknown" | "unmeasured" | "infrastructure_failure";

const MAX_RULES = 64;
const MAX_FACTS = 128;
const MAX_EVIDENCE_PER_LABEL = 8;
const MAX_ID_CHARS = 128;
const MAX_TEXT_CHARS = 1_000;
const MAX_EXPLANATION_CHARS = 2_000;

export interface EvalBehaviorPredicateV1 {
	source: EvalBehaviorFactSourceV1;
	key: string;
	op: EvalBehaviorRuleOpV1;
	value: EvalBehaviorScalarV1;
}

export interface EvalBehaviorRuleV1 {
	id: string;
	category: EvalBehaviorCategoryV1;
	fact: EvalBehaviorPredicateV1;
	rationale?: string;
}

export interface EvalBehaviorScenarioV1 {
	schema: typeof EVAL_BEHAVIOR_SCENARIO_SCHEMA_V1;
	corpus: { id: string; version: string };
	execution: {
		mode: EvalBehaviorExecutionModeV1;
		subject: { kind: "main-agent" | "worker"; role: string };
		toolTarget: "available" | "none";
	};
	expectedBehavior: EvalBehaviorRuleV1[];
	forbiddenBehavior: EvalBehaviorRuleV1[];
	judge: { maxEvidenceItems: number; maxExplanationChars: number };
}

export interface EvalBehaviorEvidenceV1 {
	factId: string;
	source: EvalBehaviorFactSourceV1;
	locator: string;
	digest: string;
	excerpt: string | null;
}

export interface EvalBehaviorJudgeFactV1 {
	id: string;
	source: EvalBehaviorFactSourceV1;
	key: string;
	value: EvalBehaviorScalarV1;
	evidence: Omit<EvalBehaviorEvidenceV1, "factId" | "source">;
}

export interface EvalBehaviorJudgeInputV1 {
	facts: EvalBehaviorJudgeFactV1[];
	unavailableSources: EvalBehaviorFactSourceV1[];
	infrastructureFailure: boolean;
}

export interface EvalBehaviorLabelResultV1 {
	category: EvalBehaviorCategoryV1;
	label: EvalBehaviorLabelV1;
	ruleIds: string[];
	evidence: EvalBehaviorEvidenceV1[];
	explanation: string | null;
}

export interface EvalBehaviorVerdictV1 {
	schema: typeof EVAL_BEHAVIOR_SCHEMA_V1;
	verdictRef: {
		schema: typeof EVAL_VERDICT_SCHEMA_V1;
		scenarioId: string;
		trialIndex: number;
	};
	corpus: { id: string; version: string };
	judgeInputDigest: string;
	outcome: EvalBehaviorOutcomeV1;
	labels: EvalBehaviorLabelResultV1[];
}

export function parseEvalBehaviorScenarioV1(value: unknown, source = "behavioral scenario"): EvalBehaviorScenarioV1 {
	const record = asRecord(value, source);
	if (normalizeEvalSchemaId(record.schema) !== EVAL_BEHAVIOR_SCENARIO_SCHEMA_V1) {
		throw new Error(`${source}.schema: expected ${EVAL_BEHAVIOR_SCENARIO_SCHEMA_V1}`);
	}
	const corpus = asRecord(record.corpus, `${source}.corpus`);
	const execution = asRecord(record.execution, `${source}.execution`);
	const subject = asRecord(execution.subject, `${source}.execution.subject`);
	const mode = execution.mode;
	if (mode !== "machinery-only" && mode !== "model-required") {
		throw new Error(`${source}.execution.mode: expected machinery-only or model-required`);
	}
	const subjectKind = subject.kind;
	if (subjectKind !== "main-agent" && subjectKind !== "worker") {
		throw new Error(`${source}.execution.subject.kind: expected main-agent or worker`);
	}
	const toolTarget = execution.toolTarget;
	if (toolTarget !== "available" && toolTarget !== "none") {
		throw new Error(`${source}.execution.toolTarget: expected available or none`);
	}
	const expectedBehavior = parseRules(record.expectedBehavior, `${source}.expectedBehavior`);
	const forbiddenBehavior = parseRules(record.forbiddenBehavior, `${source}.forbiddenBehavior`);
	const ruleIds = new Set<string>();
	for (const rule of [...expectedBehavior, ...forbiddenBehavior]) {
		if (ruleIds.has(rule.id)) throw new Error(`${source}: duplicate behavioral rule id ${rule.id}`);
		ruleIds.add(rule.id);
	}
	if (ruleIds.size === 0) throw new Error(`${source}: expected at least one behavioral rule`);
	const judge = asRecord(record.judge, `${source}.judge`);
	const maxEvidenceItems = readBoundedInteger(judge.maxEvidenceItems, `${source}.judge.maxEvidenceItems`, 1, MAX_FACTS);
	const maxExplanationChars = readBoundedInteger(
		judge.maxExplanationChars,
		`${source}.judge.maxExplanationChars`,
		1,
		MAX_EXPLANATION_CHARS,
	);
	return {
		schema: EVAL_BEHAVIOR_SCENARIO_SCHEMA_V1,
		corpus: {
			id: readId(corpus.id, `${source}.corpus.id`),
			version: readText(corpus.version, `${source}.corpus.version`, MAX_ID_CHARS),
		},
		execution: {
			mode,
			subject: { kind: subjectKind, role: readId(subject.role, `${source}.execution.subject.role`) },
			toolTarget,
		},
		expectedBehavior,
		forbiddenBehavior,
		judge: { maxEvidenceItems, maxExplanationChars },
	};
}

function canonicalizeEvalBehaviorJudgeInputV1(
	value: unknown,
	scenario: EvalBehaviorScenarioV1,
	source = "behavioral judge input",
): { input: EvalBehaviorJudgeInputV1; digest: string } {
	const record = asRecord(value, source);
	if (!Array.isArray(record.facts)) throw new Error(`${source}.facts: expected array`);
	if (record.facts.length > scenario.judge.maxEvidenceItems || record.facts.length > MAX_FACTS) {
		throw new Error(`${source}.facts: exceeds bounded evidence limit`);
	}
	const facts = record.facts.map((fact, index) => parseFact(fact, `${source}.facts[${index}]`));
	const factIds = new Set<string>();
	const factKeys = new Set<string>();
	for (const fact of facts) {
		if (factIds.has(fact.id)) throw new Error(`${source}: duplicate fact id ${fact.id}`);
		const key = `${fact.source}\u0000${fact.key}`;
		if (factKeys.has(key)) throw new Error(`${source}: conflicting fact ${fact.source}.${fact.key}`);
		factIds.add(fact.id);
		factKeys.add(key);
	}
	const unavailableSources = parseSources(record.unavailableSources, `${source}.unavailableSources`);
	const infrastructureFailure = record.infrastructureFailure;
	if (typeof infrastructureFailure !== "boolean") {
		throw new Error(`${source}.infrastructureFailure: expected boolean`);
	}
	const input: EvalBehaviorJudgeInputV1 = {
		facts: facts.sort((left, right) => left.source.localeCompare(right.source) || left.key.localeCompare(right.key)),
		unavailableSources: [...new Set(unavailableSources)].sort(),
		infrastructureFailure,
	};
	return { input, digest: sha256(stableJson(input)) };
}

export function judgeEvalBehaviorV1(
	scenarioValue: EvalBehaviorScenarioV1,
	verdict: Pick<EvalVerdictEnvelopeV1, "schema" | "scenarioId" | "trialIndex">,
	inputValue: unknown,
): EvalBehaviorVerdictV1 {
	const scenario = parseEvalBehaviorScenarioV1(scenarioValue);
	const { input, digest } = canonicalizeEvalBehaviorJudgeInputV1(inputValue, scenario);
	const labels = EVAL_BEHAVIOR_CATEGORIES.map((category) =>
		judgeCategory(category, scenario, input, scenario.judge.maxExplanationChars),
	);
	const outcome: EvalBehaviorOutcomeV1 = input.infrastructureFailure
		? "infrastructure_failure"
		: labels.some((label) => label.label === "violated")
			? "behavioral_failure"
			: labels.some((label) => label.label === "unknown")
				? "unknown"
				: labels.every((label) => label.label === "unmeasured")
					? "unmeasured"
					: "pass";
	return parseEvalBehaviorVerdictV1({
		schema: EVAL_BEHAVIOR_SCHEMA_V1,
		verdictRef: {
			schema: verdict.schema,
			scenarioId: verdict.scenarioId,
			trialIndex: verdict.trialIndex,
		},
		corpus: scenario.corpus,
		judgeInputDigest: digest,
		outcome,
		labels,
	});
}

export function parseEvalBehaviorVerdictV1(value: unknown, source = "behavioral verdict"): EvalBehaviorVerdictV1 {
	const record = asRecord(value, source);
	if (normalizeEvalSchemaId(record.schema) !== EVAL_BEHAVIOR_SCHEMA_V1)
		throw new Error(`${source}.schema: expected ${EVAL_BEHAVIOR_SCHEMA_V1}`);
	const verdictRef = asRecord(record.verdictRef, `${source}.verdictRef`);
	if (normalizeEvalSchemaId(verdictRef.schema) !== EVAL_VERDICT_SCHEMA_V1) {
		throw new Error(`${source}.verdictRef.schema: expected ${EVAL_VERDICT_SCHEMA_V1}`);
	}
	const corpus = asRecord(record.corpus, `${source}.corpus`);
	const outcome = readOutcome(record.outcome, `${source}.outcome`);
	if (!Array.isArray(record.labels)) throw new Error(`${source}.labels: expected array`);
	const labels = record.labels.map((label, index) => parseLabel(label, `${source}.labels[${index}]`));
	const categories = labels.map((label) => label.category);
	if (
		labels.length !== EVAL_BEHAVIOR_CATEGORIES.length ||
		new Set(categories).size !== EVAL_BEHAVIOR_CATEGORIES.length
	) {
		throw new Error(`${source}.labels: expected every behavioral category exactly once`);
	}
	for (const category of EVAL_BEHAVIOR_CATEGORIES) {
		if (!categories.includes(category)) throw new Error(`${source}.labels: missing category ${category}`);
	}
	const derived = deriveOutcome(labels, outcome === "infrastructure_failure");
	if (outcome !== derived) throw new Error(`${source}.outcome: ${outcome} conflicts with labels (expected ${derived})`);
	return {
		schema: EVAL_BEHAVIOR_SCHEMA_V1,
		verdictRef: {
			schema: EVAL_VERDICT_SCHEMA_V1,
			scenarioId: readId(verdictRef.scenarioId, `${source}.verdictRef.scenarioId`),
			trialIndex: readBoundedInteger(verdictRef.trialIndex, `${source}.verdictRef.trialIndex`, 0, Number.MAX_SAFE_INTEGER),
		},
		corpus: {
			id: readId(corpus.id, `${source}.corpus.id`),
			version: readText(corpus.version, `${source}.corpus.version`, MAX_ID_CHARS),
		},
		judgeInputDigest: readDigest(record.judgeInputDigest, `${source}.judgeInputDigest`),
		outcome,
		labels,
	};
}

export function assertEvalBehaviorReferencesVerdictV1(
	behavior: EvalBehaviorVerdictV1,
	verdict: EvalVerdictEnvelopeV1,
	source = "behavioral verdict",
): void {
	if (behavior.verdictRef.scenarioId !== verdict.scenarioId || behavior.verdictRef.trialIndex !== verdict.trialIndex) {
		throw new Error(`${source}.verdictRef: conflicts with result verdict identity`);
	}
	if (verdict.machinery === "infrastructure_failure" && behavior.outcome !== "infrastructure_failure") {
		throw new Error(`${source}.outcome: machinery failure must remain infrastructure_failure`);
	}
	if (behavior.outcome === "pass" && verdict.outcome !== "pass") {
		throw new Error(`${source}.outcome: behavioral pass cannot override a failed or unmeasured result`);
	}
}

function judgeCategory(
	category: EvalBehaviorCategoryV1,
	scenario: EvalBehaviorScenarioV1,
	input: EvalBehaviorJudgeInputV1,
	maxExplanationChars: number,
): EvalBehaviorLabelResultV1 {
	const expected = scenario.expectedBehavior.filter((rule) => rule.category === category);
	const forbidden = scenario.forbiddenBehavior.filter((rule) => rule.category === category);
	const rules = [...expected, ...forbidden];
	if (input.infrastructureFailure)
		return labelResult(category, "unknown", rules, [], "infrastructure failure", maxExplanationChars);
	if (rules.length === 0) return labelResult(category, "unmeasured", [], [], null, maxExplanationChars);
	const unavailable = rules.some((rule) => input.unavailableSources.includes(rule.fact.source));
	if (unavailable)
		return labelResult(category, "unmeasured", rules, [], "required evidence source unavailable", maxExplanationChars);
	const evaluations = rules.map((rule) => {
		const fact = input.facts.find(
			(candidate) => candidate.source === rule.fact.source && candidate.key === rule.fact.key,
		);
		if (fact === undefined) return { rule, fact: null, holds: null };
		const matches = compare(fact.value, rule.fact.op, rule.fact.value);
		return { rule, fact, holds: expected.includes(rule) ? matches : !matches };
	});
	const evidence = evaluations
		.flatMap(({ fact }) => (fact === null ? [] : [toEvidence(fact)]))
		.slice(0, MAX_EVIDENCE_PER_LABEL);
	if (evaluations.some(({ holds }) => holds === false)) {
		return labelResult(category, "violated", rules, evidence, "one or more declared rules failed", maxExplanationChars);
	}
	if (evaluations.some(({ holds }) => holds === null)) {
		return labelResult(category, "unknown", rules, evidence, "required observable fact missing", maxExplanationChars);
	}
	return labelResult(category, "satisfied", rules, evidence, null, maxExplanationChars);
}

function labelResult(
	category: EvalBehaviorCategoryV1,
	label: EvalBehaviorLabelV1,
	rules: ReadonlyArray<EvalBehaviorRuleV1>,
	evidence: EvalBehaviorEvidenceV1[],
	explanation: string | null,
	maxExplanationChars: number,
): EvalBehaviorLabelResultV1 {
	return {
		category,
		label,
		ruleIds: rules.map((rule) => rule.id).sort(),
		evidence,
		explanation: explanation === null ? null : explanation.slice(0, maxExplanationChars),
	};
}

function deriveOutcome(
	labels: ReadonlyArray<EvalBehaviorLabelResultV1>,
	infrastructure: boolean,
): EvalBehaviorOutcomeV1 {
	if (infrastructure) return "infrastructure_failure";
	if (labels.some((label) => label.label === "violated")) return "behavioral_failure";
	if (labels.some((label) => label.label === "unknown")) return "unknown";
	if (labels.every((label) => label.label === "unmeasured")) return "unmeasured";
	return "pass";
}

function parseRules(value: unknown, source: string): EvalBehaviorRuleV1[] {
	if (!Array.isArray(value)) throw new Error(`${source}: expected array`);
	if (value.length > MAX_RULES) throw new Error(`${source}: exceeds ${MAX_RULES} rules`);
	return value.map((entry, index) => {
		const record = asRecord(entry, `${source}[${index}]`);
		const fact = asRecord(record.fact, `${source}[${index}].fact`);
		const rationale =
			record.rationale === undefined
				? undefined
				: readText(record.rationale, `${source}[${index}].rationale`, MAX_TEXT_CHARS);
		return {
			id: readId(record.id, `${source}[${index}].id`),
			category: readCategory(record.category, `${source}[${index}].category`),
			fact: {
				source: readSource(fact.source, `${source}[${index}].fact.source`),
				key: readText(fact.key, `${source}[${index}].fact.key`, MAX_TEXT_CHARS),
				op: readOp(fact.op, `${source}[${index}].fact.op`),
				value: readScalar(fact.value, `${source}[${index}].fact.value`),
			},
			...(rationale === undefined ? {} : { rationale }),
		};
	});
}

function parseFact(value: unknown, source: string): EvalBehaviorJudgeFactV1 {
	const record = asRecord(value, source);
	const evidence = asRecord(record.evidence, `${source}.evidence`);
	return {
		id: readId(record.id, `${source}.id`),
		source: readSource(record.source, `${source}.source`),
		key: readText(record.key, `${source}.key`, MAX_TEXT_CHARS),
		value: readScalar(record.value, `${source}.value`),
		evidence: {
			locator: readText(evidence.locator, `${source}.evidence.locator`, MAX_TEXT_CHARS),
			digest: readDigest(evidence.digest, `${source}.evidence.digest`),
			excerpt: evidence.excerpt === null ? null : readText(evidence.excerpt, `${source}.evidence.excerpt`, MAX_TEXT_CHARS),
		},
	};
}

function parseLabel(value: unknown, source: string): EvalBehaviorLabelResultV1 {
	const record = asRecord(value, source);
	const label = record.label;
	if (label !== "satisfied" && label !== "violated" && label !== "unknown" && label !== "unmeasured") {
		throw new Error(`${source}.label: expected satisfied, violated, unknown, or unmeasured`);
	}
	if (!Array.isArray(record.ruleIds) || !Array.isArray(record.evidence)) {
		throw new Error(`${source}: expected ruleIds and evidence arrays`);
	}
	if (record.evidence.length > MAX_EVIDENCE_PER_LABEL) throw new Error(`${source}.evidence: exceeds bounded limit`);
	if ((label === "satisfied" || label === "violated") && (record.ruleIds.length === 0 || record.evidence.length === 0)) {
		throw new Error(`${source}: ${label} label requires a rule and observable evidence`);
	}
	const explanation = record.explanation;
	if (explanation !== null && (typeof explanation !== "string" || explanation.length > MAX_EXPLANATION_CHARS)) {
		throw new Error(`${source}.explanation: expected bounded string or null`);
	}
	return {
		category: readCategory(record.category, `${source}.category`),
		label,
		ruleIds: record.ruleIds.map((id, index) => readId(id, `${source}.ruleIds[${index}]`)),
		evidence: record.evidence.map((entry, index) => {
			const evidence = asRecord(entry, `${source}.evidence[${index}]`);
			return {
				factId: readId(evidence.factId, `${source}.evidence[${index}].factId`),
				source: readSource(evidence.source, `${source}.evidence[${index}].source`),
				locator: readText(evidence.locator, `${source}.evidence[${index}].locator`, MAX_TEXT_CHARS),
				digest: readDigest(evidence.digest, `${source}.evidence[${index}].digest`),
				excerpt:
					evidence.excerpt === null
						? null
						: readText(evidence.excerpt, `${source}.evidence[${index}].excerpt`, MAX_TEXT_CHARS),
			};
		}),
		explanation: explanation as string | null,
	};
}

function toEvidence(fact: EvalBehaviorJudgeFactV1): EvalBehaviorEvidenceV1 {
	return { factId: fact.id, source: fact.source, ...fact.evidence };
}

function compare(actual: EvalBehaviorScalarV1, op: EvalBehaviorRuleOpV1, expected: EvalBehaviorScalarV1): boolean {
	if (op === "eq") return actual === expected;
	if (op === "neq") return actual !== expected;
	if (typeof actual !== "number" || typeof expected !== "number") return false;
	if (op === "lt") return actual < expected;
	if (op === "lte") return actual <= expected;
	if (op === "gt") return actual > expected;
	return actual >= expected;
}

function parseSources(value: unknown, source: string): EvalBehaviorFactSourceV1[] {
	if (!Array.isArray(value)) throw new Error(`${source}: expected array`);
	return value.map((entry, index) => readSource(entry, `${source}[${index}]`));
}

function readOutcome(value: unknown, source: string): EvalBehaviorOutcomeV1 {
	if (
		value === "pass" ||
		value === "behavioral_failure" ||
		value === "unknown" ||
		value === "unmeasured" ||
		value === "infrastructure_failure"
	)
		return value;
	throw new Error(`${source}: expected a closed behavioral outcome`);
}

function readCategory(value: unknown, source: string): EvalBehaviorCategoryV1 {
	if (typeof value === "string" && (EVAL_BEHAVIOR_CATEGORIES as readonly string[]).includes(value)) {
		return value as EvalBehaviorCategoryV1;
	}
	throw new Error(`${source}: expected a closed behavioral category`);
}

function readSource(value: unknown, source: string): EvalBehaviorFactSourceV1 {
	if (value === "transcript" || value === "tool" || value === "receipt" || value === "grader") return value;
	throw new Error(`${source}: expected transcript, tool, receipt, or grader`);
}

function readOp(value: unknown, source: string): EvalBehaviorRuleOpV1 {
	if (value === "eq" || value === "neq" || value === "lt" || value === "lte" || value === "gt" || value === "gte") {
		return value;
	}
	throw new Error(`${source}: expected eq, neq, lt, lte, gt, or gte`);
}

function readScalar(value: unknown, source: string): EvalBehaviorScalarV1 {
	if (typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length <= MAX_TEXT_CHARS) return value;
	throw new Error(`${source}: expected bounded string, finite number, or boolean`);
}

function readId(value: unknown, source: string): string {
	const id = readText(value, source, MAX_ID_CHARS);
	if (!/^[A-Za-z0-9._-]+$/u.test(id)) throw new Error(`${source}: expected stable id`);
	return id;
}

function readText(value: unknown, source: string, maxChars: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars) {
		throw new Error(`${source}: expected non-empty string no longer than ${maxChars} characters`);
	}
	return value;
}

function readDigest(value: unknown, source: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${source}: expected sha256 digest`);
	return value;
}

function readBoundedInteger(value: unknown, source: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${source}: expected integer from ${min} through ${max}`);
	}
	return value;
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	throw new Error(`${source}: expected object`);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}
