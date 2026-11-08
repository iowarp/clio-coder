import { createHash } from "node:crypto";
import { isAbsolute, posix, relative } from "node:path";
import { containsInstructionMarkers } from "../../core/untrusted-content.js";
import type { NumericCompareReport } from "../../tools/verify/numeric.js";
import type { ReproduceReport } from "../../tools/verify/reproduce.js";
import { judgedPayloadKey } from "../evidence/index.js";
import {
	CLAIM_RECORD_VERSION,
	type ClaimConditions,
	type ClaimDigestRef,
	type ClaimKeys,
	type ClaimRecord,
	type ClaimRecordV1,
	type ClaimSource,
	NUMERIC_CLAIM_KEY_LIMIT,
	type NumericClaimConditions,
	type ReproduceClaimConditions,
} from "./types.js";

/**
 * Claims are built only from typed fields Clio stamped while running a declared check: the verify tool's result
 * details on the main thread, and the sealed host verification of a worker run (#406). Tool output text, answer prose
 * and model arguments never reach a claim, so no model can plant one.
 */

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Sorted-key JSON, so a record's id is independent of field order. */
export function canonicalClaimJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalClaimJson(entry ?? null)).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, child]) => child !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalClaimJson(child)}`).join(",")}}`;
}

/** The id a record must carry: the digest of everything else in it. */
export function claimRecordId(record: Omit<ClaimRecordV1, "id"> | ClaimRecordV1): string {
	const { id: _id, ...rest } = record as ClaimRecordV1;
	return sha256(canonicalClaimJson(rest));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectPath(project: string, path: string): string {
	if (!isAbsolute(path)) return path;
	const inside = relative(project, path);
	return inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside) ? inside : path;
}

function digestRef(
	project: string,
	value: { path?: string; sha256: string; bytes: number } | undefined,
): ClaimDigestRef | undefined {
	if (value === undefined) return undefined;
	return {
		...(value.path !== undefined ? { path: projectPath(project, value.path) } : {}),
		sha256: value.sha256,
		bytes: value.bytes,
	};
}

function short(digest: string): string {
	return digest.slice(0, 12);
}

function reproduceConditions(project: string, report: ReproduceReport): ReproduceClaimConditions {
	const reference = digestRef(project, report.reference);
	return {
		kind: "reproduce",
		...report.conditions,
		inputs: report.conditions.inputs.map((input) => ({ ...input })),
		argv: [...report.conditions.argv],
		platform: { ...report.conditions.platform },
		seed: report.conditions.seed === null ? null : { ...report.conditions.seed },
		compare: report.compare,
		tolerance: { ...report.tolerance },
		rule: report.rule,
		...(reference !== undefined ? { reference } : {}),
		payloads: report.runs.flatMap((run) => (run.payload !== undefined ? [run.payload.sha256] : [])),
		metrics: report.metrics.map((metric) => ({
			metric: metric.metric,
			passed: metric.passed,
			failed: [...metric.failed],
		})),
	};
}

function numericConditions(
	project: string,
	report: NumericCompareReport,
	argv: ReadonlyArray<string>,
	tree: { head: string; fingerprint: string } | undefined,
	checkout?: { commit: string; trackedTreeClean: boolean },
): NumericClaimConditions {
	const reference = digestRef(project, report.reference);
	// Failing keys first, so the cap never drops the reason a claim disagrees.
	const ordered = [...report.keys.filter((key) => !key.passed), ...report.keys.filter((key) => key.passed)];
	const kept = ordered.slice(0, NUMERIC_CLAIM_KEY_LIMIT);
	return {
		kind: "numeric-compare",
		tolerance: { ...report.tolerance },
		combine: report.combine,
		nonFinite: report.nonFinite,
		rule: report.rule,
		...(reference !== undefined ? { reference } : {}),
		...(report.actual !== undefined ? { actual: { ...report.actual } } : {}),
		argv: [...argv],
		commit: tree?.head ?? checkout?.commit ?? null,
		...(tree === undefined && checkout !== undefined ? { trackedTreeClean: checkout.trackedTreeClean } : {}),
		...(tree !== undefined ? { treeFingerprint: tree.fingerprint } : {}),
		keys: kept.map((key) => ({ key: key.key, passed: key.passed, failed: [...key.failed] })),
		keysOmitted: report.keys.length - kept.length,
	};
}

function list(items: ReadonlyArray<string>, limit = 4): string {
	const shown = items.slice(0, limit).join(", ");
	return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

/** The claim sentence. Every clause comes from the conditions, and an unrecorded condition is said to be unrecorded. */
export function claimText(check: string, conditions: ClaimConditions, passed: boolean): string {
	if (conditions.kind === "reproduce") {
		const failed = conditions.metrics.filter((metric) => !metric.passed).map((metric) => metric.metric);
		const against =
			conditions.compare === "twice"
				? "across two clean runs"
				: `against reference ${conditions.reference?.path ?? "file"} sha256:${short(conditions.reference?.sha256 ?? "")}`;
		const head = passed
			? `reproduce check '${check}': ${conditions.metrics.length} metric${conditions.metrics.length === 1 ? "" : "s"} agreed ${against} within the declared tolerance (${conditions.rule})`
			: `reproduce check '${check}': ${list(failed)} did not agree ${against} within the declared tolerance (${conditions.rule})`;
		const commit =
			conditions.commit === null
				? "outside a repository"
				: `at commit ${short(conditions.commit)}${conditions.trackedTreeClean === false ? " (the committed tree ran; the checkout had uncommitted changes)" : ""}`;
		const platform = `on ${conditions.platform.os}/${conditions.platform.arch}, node ${conditions.platform.nodeVersion}${conditions.platform.pythonVersion !== undefined ? `, ${conditions.platform.pythonVersion}` : ""}`;
		const seed = conditions.seed === null ? "no seed" : `seed ${conditions.seed.env}=${conditions.seed.value}`;
		const inputs =
			conditions.inputs.length === 0
				? "no pinned inputs"
				: `inputs ${list(conditions.inputs.map((input) => `${input.path}@${short(input.sha256)}`))}`;
		return `${head}, ${commit} ${platform}, ${seed}, ${inputs}.`;
	}
	const failed = conditions.keys.filter((key) => !key.passed).map((key) => key.key);
	const total = conditions.keys.length + conditions.keysOmitted;
	const reference =
		conditions.reference === undefined
			? "its reference"
			: `reference ${conditions.reference.path ?? "file"} sha256:${short(conditions.reference.sha256)}`;
	const head = passed
		? `numeric-compare check '${check}': ${total} key${total === 1 ? "" : "s"} agreed with ${reference} within the declared tolerance (${conditions.rule})`
		: `numeric-compare check '${check}': ${list(failed)} did not agree with ${reference} within the declared tolerance (${conditions.rule})`;
	const commit =
		conditions.commit === null
			? "commit not recorded"
			: `at commit ${short(conditions.commit)}${conditions.trackedTreeClean === false ? " with uncommitted changes to tracked files" : ""}`;
	return `${head}, ${commit}.`;
}

function checkLabel(check: string, run: string | undefined): string {
	return run === undefined ? check : `${check}/${posix.basename(run)}`;
}

/** The name an operator called a claim's check by: `<id>/<run>` for one run of a sweep check, else the check id. */
export function claimCheckLabel(claim: ClaimRecord): string {
	return checkLabel(claim.keys.check, claim.keys.run);
}

/**
 * The digest of the judged-payload key the verified-outcome count uses, so a claim and an outcome name one judgement
 * alike. Kind, check id and every judged digest: rerunning on the same bytes is the same subject.
 */
function subjectOf(check: string, report: ReproduceReport | NumericCompareReport): string {
	return sha256(judgedPayloadKey(check, report) ?? `${report.kind}\0${check}\0`);
}

function keysOf(
	check: string,
	conditions: ClaimConditions,
	declaredCommand: ReadonlyArray<string>,
	run: string | undefined,
): ClaimKeys {
	const paths = new Set<string>();
	if (conditions.kind === "reproduce") for (const input of conditions.inputs) paths.add(input.path);
	if (conditions.reference?.path !== undefined) paths.add(conditions.reference.path);
	// A reproduce check names the argv it ran with its interpreter resolved, on both channels; the declared argv is
	// what a numeric-compare check runs on both. Either way the two channels key one check alike.
	const command = conditions.kind === "reproduce" ? conditions.argv : declaredCommand;
	return { check, command: [...command], paths: [...paths], ...(run !== undefined ? { run } : {}) };
}

function buildClaim(input: {
	project: string;
	at: string;
	check: string;
	declaredCommand: ReadonlyArray<string>;
	conditions: ClaimConditions;
	report: ReproduceReport | NumericCompareReport;
	source: ClaimSource;
	run?: string;
}): ClaimRecordV1 {
	const passed = input.report.passed;
	const text = claimText(checkLabel(input.check, input.run), input.conditions, passed);
	const body: Omit<ClaimRecordV1, "id"> = {
		v: CLAIM_RECORD_VERSION,
		type: "claim",
		at: input.at,
		project: input.project,
		kind: input.conditions.kind,
		verdict: passed ? "agrees" : "disagrees",
		text,
		subject: subjectOf(input.check, input.report),
		keys: keysOf(input.check, input.conditions, input.declaredCommand, input.run),
		conditions: input.conditions,
		source: input.source,
		evidence: "grounded",
		...(containsInstructionMarkers(text) ? { flagged: "instruction-markers" as const } : {}),
	};
	return { ...body, id: claimRecordId(body) };
}

function judgedReport(value: unknown): ReproduceReport | NumericCompareReport | null {
	if (!isRecord(value) || typeof value.passed !== "boolean") return null;
	if (value.kind === "reproduce" && isRecord(value.conditions) && Array.isArray(value.metrics))
		return value as unknown as ReproduceReport;
	if (value.kind === "numeric-compare" && Array.isArray(value.keys)) return value as unknown as NumericCompareReport;
	return null;
}

/**
 * The claim a verify tool result carries, or null. Only a declared check that ran to completion and was judged
 * yields one: a refusal, a crash, a timeout or an unjudgeable payload concluded nothing, so it records nothing.
 */
export function claimFromVerifyResult(input: {
	details: Readonly<Record<string, unknown>> | undefined;
	project: string;
	at: string;
	source: Extract<ClaimSource, { channel: "verify" }>;
}): ClaimRecordV1 | null {
	const details = input.details;
	if (details === undefined) return null;
	const judgement = details.judgement;
	if (!isRecord(judgement) || judgement.execution !== "succeeded") return null;
	if (judgement.validation !== "passed" && judgement.validation !== "failed") return null;
	const report = judgedReport(details.report);
	const check = typeof details.check === "string" ? details.check : null;
	if (report === null || check === null) return null;
	// The verdict is the report's; a judgement word that disagrees with it is a result this reader does not trust.
	if (report.passed !== (judgement.validation === "passed")) return null;
	const run = typeof details.run === "string" && details.run.length > 0 ? details.run : undefined;
	const declaredCommand = Array.isArray(details.declaredCommand)
		? details.declaredCommand.filter((part): part is string => typeof part === "string")
		: [];
	const conditions =
		report.kind === "reproduce"
			? reproduceConditions(input.project, report)
			: numericConditions(input.project, report, declaredCommand, undefined, checkoutOf(details.checkout));
	return buildClaim({
		project: input.project,
		at: input.at,
		check,
		declaredCommand,
		conditions,
		report,
		source: input.source,
		...(run !== undefined ? { run } : {}),
	});
}

function checkoutOf(value: unknown): { commit: string; trackedTreeClean: boolean } | undefined {
	return isRecord(value) && typeof value.commit === "string" && typeof value.trackedTreeClean === "boolean"
		? { commit: value.commit, trackedTreeClean: value.trackedTreeClean }
		: undefined;
}

/** One host verification check as its sealed receipt carries it. */
export interface SealedHostCheck {
	check: string;
	argv: ReadonlyArray<string>;
	memo: boolean;
	/** The check's exit code; a judged check that failed its judgement after a clean exit reads 1. */
	exitCode: number;
	/** Set when the check never started (refused before launch, no parameters, no executable); it judged nothing. */
	notRun?: string;
	report?: { kind: string; passed: boolean };
	evidenceRunId?: string;
	tree?: { head: string; fingerprint: string };
}

/**
 * The claims a settled run's host verification yields. A check whose evidence belongs to another run (a memo hit, or
 * a batch member's shared check) is that run's claim, already captured when it ran, so it is skipped here.
 */
export function claimsFromHostVerification(input: {
	runId: string;
	receiptDigest: string;
	checks: ReadonlyArray<SealedHostCheck>;
	project: string;
	at: string;
}): ClaimRecordV1[] {
	const claims: ClaimRecordV1[] = [];
	for (const check of input.checks) {
		if (check.memo || check.evidenceRunId !== undefined) continue;
		const report = judgedReport(check.report);
		if (report === null) continue;
		const conditions =
			report.kind === "reproduce"
				? reproduceConditions(input.project, report)
				: numericConditions(input.project, report, check.argv, check.tree);
		claims.push(
			buildClaim({
				project: input.project,
				at: input.at,
				check: check.check,
				declaredCommand: check.argv,
				conditions,
				report,
				source: { channel: "host-verification", runId: input.runId, receiptDigest: input.receiptDigest },
			}),
		);
	}
	return claims;
}
