import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveSafeCwd, runCommandVector, type SafeCommandResult } from "../../core/safe-exec.js";
import { declaredVerificationScripts, VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import type { ToolResult } from "../registry.js";
import { runVectorTool } from "../safe-exec.js";
import {
	type DeclaredCheck,
	type DeclaredCheckSource,
	type DeclaredNumericCompare,
	type DeclaredPerfBudget,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
	resolveProjectVerifierExecutionCwd,
} from "./catalog.js";
import {
	type DeclaredCheckDiscoveryResult,
	discoverDeclaredChecks,
	discoverDeclaredChecksAtRoot,
} from "./discovery.js";
import { compareNumeric, type NumericCompareReport, parseNumericPayload, renderNumericReport } from "./numeric.js";
import {
	capturePerfEnvironment,
	evaluatePerfBudget,
	type PerfBaseline,
	type PerfBudgetReport,
	type PerfEnvironment,
	parsePerfBaseline,
	renderPerfBaseline,
} from "./perf.js";
import { availableToolchainChecks } from "./resolve.js";
import { type DeclaredProjectEntry, discoverDeclaredProjectEntriesAtRoot, parsePackageJson } from "./toolchain.js";
import { TOOLCHAIN_DISCOVERY_SOURCES, type ToolchainCheck } from "./toolchain-checks.js";

/** The structured verdict a numeric-compare or perf-budget check records beside the command facts. */
export type DeclaredCheckReport = NumericCompareReport | PerfBudgetReport;

/**
 * Output ceiling for a judged check's command. A numeric payload may carry up
 * to NUMERIC_PAYLOAD_CAPS.elements numbers, which as printed JSON can exceed
 * the safe-exec default of 600 KB by a wide margin, so the judged path has its
 * own bound. The runner retains the whole capture in memory as a string until
 * judgement, so this constant is also the memory bound one judged check may
 * hold; output past it ends the command before judgement. Baseline recording
 * runs the same command under the same ceiling, and a reference or baseline
 * file is refused past it before being read, so no judged input exceeds it.
 */
export const JUDGED_CHECK_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export type CheckExecutionOutcome = "succeeded" | "failed" | "timed-out" | "aborted" | "output-capped";

/**
 * A verifier result answers three separate questions, and a reader must not
 * fold them into one. Execution says whether the command ran to completion.
 * Validation says what the declared judgement concluded: a tolerance or budget
 * verdict for a judged check, the exit code itself for a command check, or
 * `not-run` when execution ended before any judgement. Scientific validity is
 * never established by a check: a payload within tolerance of its reference
 * says nothing about whether the reference is right.
 */
export interface CheckJudgement {
	execution: CheckExecutionOutcome;
	validation: "passed" | "failed" | "exit-code" | "not-run";
	scientificValidity: typeof SCIENTIFIC_VALIDITY_NOT_ESTABLISHED;
}

export const SCIENTIFIC_VALIDITY_NOT_ESTABLISHED = "not established by this check";

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function executionOutcome(result: Pick<SafeCommandResult, "aborted" | "timedOut" | "outputCapped" | "exitCode">) {
	if (result.aborted) return "aborted" as const;
	if (result.timedOut) return "timed-out" as const;
	if (result.outputCapped) return "output-capped" as const;
	return result.exitCode === 0 ? ("succeeded" as const) : ("failed" as const);
}

function judgement(execution: CheckExecutionOutcome, validation: CheckJudgement["validation"]): CheckJudgement {
	return { execution, validation, scientificValidity: SCIENTIFIC_VALIDITY_NOT_ESTABLISHED };
}

/**
 * Package scripts and the project catalog meet here as one canonical check
 * projection. Project checks retain their admitted argv/cwd/timeout exactly;
 * package scripts keep the established npm argument-widening behavior.
 */

function clonedSources(sources: ReadonlyArray<DeclaredCheckSource>): DeclaredCheckSource[] {
	return sources.map((source) => ({
		kind: source.kind,
		path: source.path,
		checks: source.checks.map((check) => ({
			...check,
			command: [...check.command],
			tags: [...check.tags],
			source: { ...check.source },
		})),
	}));
}

export function listChecks(cwdArg: string | undefined): ToolResult {
	const discovery = discoverDeclaredChecks(cwdArg);
	if (!discovery.ok) return { kind: "error", message: `verify: ${discovery.reason}` };
	const declared = discovery.sources.flatMap((source) => source.checks);
	const derived = availableToolchainChecks(process.cwd(), declared);
	const lines: string[] = [];
	if (declared.length === 0 && derived.length === 0) {
		lines.push(
			`No declared verification checks found (no package.json verification scripts or ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH} entries).`,
			`Nothing derivable either: looked for ${TOOLCHAIN_DISCOVERY_SOURCES}.`,
			"Run the repository's documented test command through bash, or run `clio-coder verifiers author` to create the catalog after confirmation.",
		);
	} else {
		if (declared.length > 0) lines.push("Declared verification checks:");
		for (const source of discovery.sources) {
			if (source.checks.length === 0) continue;
			lines.push(source.kind === "package.json" ? "package.json:" : `${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}:`);
			for (const check of source.checks) {
				const tags = check.tags.length > 0 ? ` [${check.tags.join(", ")}]` : "";
				lines.push(`- ${check.id}${tags}: ${check.description}`);
			}
		}
		if (derived.length > 0) {
			lines.push("Derived from the repository's toolchain and CI files (argv shown is what runs):");
			for (const check of derived) {
				const args = check.argsBase === undefined ? " (takes no args)" : "";
				lines.push(`- ${check.id} [${check.tags.join(", ")}]: ${check.command.join(" ")}${args}  (${check.source.path})`);
			}
		}
	}
	lines.push(
		"",
		'Run one with verify(check="<id>"). verify(check="frontend", path=<file>) validates an HTML/CSS/JS artifact.',
	);
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			sources: clonedSources(discovery.sources),
			derived: derived.map((check) => ({ id: check.id, command: [...check.command], path: check.source.path })),
		},
	};
}

/**
 * Run a check derived from the repository's toolchain or CI files. The argv
 * was resolved by resolveVerifyCall, the same resolution the safety policy
 * engine scanned, and runs from the workspace root.
 */
export async function runToolchainCheck(
	check: ToolchainCheck,
	argv: ReadonlyArray<string>,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	const [file, ...vector] = argv;
	if (file === undefined) return { kind: "error", message: `verify: derived check '${check.id}' has empty argv` };
	const cwd = resolveProjectVerifierExecutionCwd(check.cwd, process.cwd());
	if (cwd instanceof Error) return { kind: "error", message: `verify: ${cwd.message}` };
	const result = await runVectorTool(
		"verify",
		file,
		vector,
		{ ...args, cwd, timeout_ms: typeof args.timeout_ms === "number" ? args.timeout_ms : check.timeoutMs },
		options,
	);
	return withDeclaredEvidence(result, { ...check, command: [...argv] });
}

/**
 * Attach the judgement facts to a `command` check's result, whose whole
 * verdict is its exit code: a package script or a catalog `command` check.
 * Judged checks attach their own facts before reaching here and keep them; a
 * result without exec facts (a refusal before anything ran) gets none.
 */
function withCommandJudgement(result: ToolResult): ToolResult {
	const details = result.details ?? {};
	if (details.judgement !== undefined) return result;
	// The exec record always names exitCode (a number, or null for a signal
	// death) once the command ran; a refusal before spawning carries none.
	if (!Object.hasOwn(details, "exitCode")) return result;
	const execution = executionOutcome({
		aborted: details.aborted === true,
		timedOut: details.timedOut === true,
		outputCapped: details.outputCapped === true,
		exitCode: typeof details.exitCode === "number" ? details.exitCode : null,
	});
	const validation = execution === "succeeded" || execution === "failed" ? "exit-code" : "not-run";
	return { ...result, details: { ...details, judgement: judgement(execution, validation) } };
}

function withDeclaredEvidence(result: ToolResult, check: DeclaredCheck): ToolResult {
	const judged = check.kind === "command" ? withCommandJudgement(result) : result;
	return {
		...judged,
		details: {
			...judged.details,
			action: "verify",
			check: check.id,
			kind: check.kind,
			source: { ...check.source },
			description: check.description,
			declaredCommand: [...check.command],
			declaredCwd: check.cwd,
			declaredTimeoutMs: check.timeoutMs,
			tags: [...check.tags],
		},
	};
}

/**
 * The JSON object a numeric-compare command printed. The whole text is tried
 * first; when the command also wrote diagnostics around it, the span from the
 * first `{` to the last `}` is tried once more, so a preamble line does not
 * turn a correct payload into a parse failure.
 */
export function extractNumericPayloadText(output: string): string {
	const trimmed = output.trim();
	try {
		JSON.parse(trimmed);
		return trimmed;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
	}
}

/**
 * Read a repository-relative check file inside the workspace root, as text.
 * The file is bounded by JUDGED_CHECK_MAX_OUTPUT_BYTES, the same ceiling as
 * the command output it is judged beside, and the size is checked before any
 * byte is read so an oversized file costs nothing but a stat.
 */
function readCheckFile(workspaceRoot: string, relative: string, label: string): string | Error {
	let resolved: string;
	try {
		resolved = resolveSafeCwd(relative, workspaceRoot);
	} catch (error) {
		return new Error(`${label} ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!existsSync(resolved)) return new Error(`${label} '${relative}' does not exist`);
	try {
		const { size } = statSync(resolved);
		if (size > JUDGED_CHECK_MAX_OUTPUT_BYTES) {
			return new Error(`${label} '${relative}' exceeds the ${JUDGED_CHECK_MAX_OUTPUT_BYTES}-byte cap (${size} bytes)`);
		}
		return readFileSync(resolved, "utf8");
	} catch (error) {
		return new Error(`${label} '${relative}' cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
}

/**
 * Judge a numeric-compare command's stdout against reference text already
 * read from disk. Pure. The report records the identity of both texts it
 * judged: the reference's digest and size beside the caller's label (and its
 * path when the caller names one), and the digest and size of the payload
 * text extracted from stdout.
 */
export function judgeNumericTexts(
	stdout: string,
	referenceText: string,
	tolerance: DeclaredNumericCompare["tolerance"],
	referenceLabel: string,
	referencePath?: string,
): NumericCompareReport | Error {
	const reference = parseNumericPayload(referenceText, referenceLabel);
	if (reference instanceof Error) return reference;
	const payloadText = extractNumericPayloadText(stdout);
	const actual = parseNumericPayload(payloadText, "command output");
	if (actual instanceof Error) return actual;
	return {
		...compareNumeric(actual, reference, tolerance),
		reference: {
			source: referenceLabel,
			...(referencePath !== undefined ? { path: referencePath } : {}),
			sha256: sha256(referenceText),
			bytes: Buffer.byteLength(referenceText, "utf8"),
		},
		actual: { sha256: sha256(payloadText), bytes: Buffer.byteLength(payloadText, "utf8") },
	};
}

/** Judge a numeric-compare command's stdout against the declared reference under the workspace root. */
function judgeNumericCompare(
	stdout: string,
	numeric: DeclaredNumericCompare,
	workspaceRoot: string,
): NumericCompareReport | Error {
	const referenceText = readCheckFile(workspaceRoot, numeric.reference, "reference");
	if (referenceText instanceof Error) return referenceText;
	return judgeNumericTexts(
		stdout,
		referenceText,
		numeric.tolerance,
		`reference '${numeric.reference}'`,
		numeric.reference,
	);
}

export interface JudgePerfOptions {
	/** The judging host; captured from this process when omitted. Tests inject one for determinism. */
	environment?: PerfEnvironment;
}

/**
 * Judge a measured wall time against a budget, or against baseline text
 * already read from disk. Pure given `options.environment`. A baseline
 * judgement records the baseline file's identity and compares its recorded
 * host against the judging host; that comparison is reported, never enforced.
 */
export function judgePerfTexts(
	measuredMs: number,
	perf: DeclaredPerfBudget,
	baselineText: string | undefined,
	baselineLabel: string,
	options: JudgePerfOptions = {},
): PerfBudgetReport | Error {
	let baseline: PerfBaseline | undefined;
	let provenance: PerfBudgetReport["baseline"];
	if (perf.baseline !== undefined) {
		if (baselineText === undefined) {
			return new Error(`${baselineLabel} is missing; record it with \`clio-coder verifiers baseline <id>\``);
		}
		const parsed = parsePerfBaseline(baselineText, baselineLabel);
		if (parsed instanceof Error) return parsed;
		baseline = parsed;
		provenance = {
			path: perf.baseline,
			sha256: sha256(baselineText),
			bytes: Buffer.byteLength(baselineText, "utf8"),
			...(parsed.recordedAt !== undefined ? { recordedAt: parsed.recordedAt } : {}),
			...(parsed.check !== undefined ? { check: parsed.check } : {}),
		};
	}
	const report = evaluatePerfBudget(measuredMs, {
		...(perf.budget !== undefined ? { budget: perf.budget } : {}),
		...(baseline !== undefined ? { baseline, environment: options.environment ?? capturePerfEnvironment() } : {}),
		...(perf.tolerance?.relative !== undefined ? { relative: perf.tolerance.relative } : {}),
	});
	if (report instanceof Error || provenance === undefined) return report;
	return { ...report, baseline: provenance };
}

/** Judge a measured wall time against the declared budget or the recorded baseline under the workspace root. */
function judgePerfBudget(
	measuredMs: number,
	perf: DeclaredPerfBudget,
	workspaceRoot: string,
): PerfBudgetReport | Error {
	let baselineText: string | undefined;
	if (perf.baseline !== undefined) {
		const text = readCheckFile(workspaceRoot, perf.baseline, "baseline");
		if (text instanceof Error) {
			return new Error(`${text.message}; record it with \`clio-coder verifiers baseline <id>\``);
		}
		baselineText = text;
	}
	return judgePerfTexts(measuredMs, perf, baselineText, `baseline '${perf.baseline ?? ""}'`);
}

function commandFacts(result: SafeCommandResult): Record<string, unknown> {
	return {
		command: [result.file, ...result.args].join(" "),
		argv: [result.file, ...result.args],
		cwd: result.cwd,
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		aborted: result.aborted,
		timedOut: result.timedOut,
		outputCapped: result.outputCapped,
	};
}

/**
 * Run a numeric-compare or perf-budget check: the command through the same
 * safe-exec spine as a command check, then the pure judgement. A command that
 * exits non-zero, times out, is aborted, or overruns the output ceiling fails
 * before any comparison, so a crashed or truncated validator never reads as a
 * tolerance verdict. Every result carries the three-part judgement so a
 * reader can tell execution failure, validation failure, and the unanswered
 * question of scientific validity apart.
 */
async function runJudgedCheck(
	check: DeclaredCheck,
	file: string,
	vector: ReadonlyArray<string>,
	cwd: string,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	let result: SafeCommandResult;
	try {
		result = await runCommandVector(file, vector, {
			cwd,
			timeoutMs: check.timeoutMs,
			maxOutputBytes: JUDGED_CHECK_MAX_OUTPUT_BYTES,
			...(options?.signal !== undefined ? { signal: options.signal } : {}),
		});
	} catch (error) {
		return { kind: "error", message: `verify: ${error instanceof Error ? error.message : String(error)}` };
	}
	const execution = executionOutcome(result);
	const facts = { ...commandFacts(result), judgement: judgement(execution, "not-run") };
	if (result.aborted) return { kind: "error", message: "verify: aborted", details: facts };
	if (result.timedOut) return { kind: "error", message: `verify: timed out after ${check.timeoutMs}ms`, details: facts };
	if (result.outputCapped) {
		return {
			kind: "error",
			message: `verify: ${check.kind} command output exceeded ${JUDGED_CHECK_MAX_OUTPUT_BYTES} bytes before judgement`,
			details: facts,
		};
	}
	if (result.exitCode !== 0) {
		const tail = `${result.stdout}${result.stderr}`.trim().slice(-2_000);
		return {
			kind: "error",
			message: `verify: ${check.kind} command exited with code ${result.exitCode ?? "?"} before judgement: ${tail}`,
			details: facts,
		};
	}
	const report =
		check.kind === "numeric-compare" && check.numeric !== undefined
			? judgeNumericCompare(result.stdout, check.numeric, process.cwd())
			: check.kind === "perf-budget" && check.perf !== undefined
				? judgePerfBudget(result.durationMs, check.perf, process.cwd())
				: new Error(`declared check '${check.id}' has kind ${check.kind} without its parameters`);
	if (report instanceof Error) return { kind: "error", message: `verify: ${report.message}`, details: facts };
	const rendered = report.kind === "numeric-compare" ? renderNumericReport(report) : report.summary;
	const details = { ...facts, report, judgement: judgement(execution, report.passed ? "passed" : "failed") };
	if (!report.passed) return { kind: "error", message: `verify: ${rendered}`, details };
	return { kind: "ok", output: `${rendered}\n`, details };
}

export async function runProjectCheck(check: DeclaredCheck, options?: { signal?: AbortSignal }): Promise<ToolResult> {
	const [file, ...vector] = check.command;
	if (file === undefined) return { kind: "error", message: `verify: declared check '${check.id}' has empty argv` };
	const cwd = resolveProjectVerifierExecutionCwd(check.cwd, process.cwd());
	if (cwd instanceof Error) return { kind: "error", message: `verify: ${cwd.message}` };
	if (check.kind !== "command") {
		return withDeclaredEvidence(await runJudgedCheck(check, file, vector, cwd, options), check);
	}
	const result = await runVectorTool("verify", file, vector, { cwd, timeout_ms: check.timeoutMs }, options);
	return withDeclaredEvidence(result, check);
}

/**
 * Run a perf-budget check once and write its wall time as the baseline the
 * check's `baseline` path names. The command runs under the judged check's
 * output ceiling, so the recording run and the judged run are the same run.
 * The command must exit cleanly; a failed, timed-out, aborted, or
 * output-capped run records nothing, so a baseline never encodes a broken
 * command's timing.
 */
export async function recordPerfBaseline(
	check: DeclaredCheck,
	options?: { signal?: AbortSignal; now?: () => Date; environment?: PerfEnvironment },
): Promise<{ ok: true; path: string; wallTimeMs: number } | { ok: false; message: string }> {
	if (check.kind !== "perf-budget" || check.perf?.baseline === undefined) {
		return { ok: false, message: `check '${check.id}' is not a perf-budget check with a baseline path` };
	}
	const [file, ...vector] = check.command;
	if (file === undefined) return { ok: false, message: `declared check '${check.id}' has empty argv` };
	const cwd = resolveProjectVerifierExecutionCwd(check.cwd, process.cwd());
	if (cwd instanceof Error) return { ok: false, message: cwd.message };
	let result: SafeCommandResult;
	try {
		result = await runCommandVector(file, vector, {
			cwd,
			timeoutMs: check.timeoutMs,
			maxOutputBytes: JUDGED_CHECK_MAX_OUTPUT_BYTES,
			...(options?.signal !== undefined ? { signal: options.signal } : {}),
		});
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	const execution = executionOutcome(result);
	if (execution !== "succeeded") {
		const ended =
			execution === "aborted"
				? "was aborted"
				: execution === "timed-out"
					? "timed out"
					: execution === "output-capped"
						? `output exceeded ${JUDGED_CHECK_MAX_OUTPUT_BYTES} bytes`
						: `exited with code ${result.exitCode ?? "?"}`;
		return { ok: false, message: `command ${ended}; no baseline recorded` };
	}
	let target: string;
	try {
		target = resolveSafeCwd(check.perf.baseline, process.cwd());
	} catch (error) {
		return { ok: false, message: `baseline ${error instanceof Error ? error.message : String(error)}` };
	}
	const recordedAt = (options?.now?.() ?? new Date()).toISOString();
	const environment = options?.environment ?? capturePerfEnvironment();
	try {
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(
			target,
			renderPerfBaseline({ wallTimeMs: result.durationMs, check: check.id, recordedAt, environment }),
			"utf8",
		);
	} catch (error) {
		return {
			ok: false,
			message: `cannot write baseline '${check.perf.baseline}' (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	return { ok: true, path: check.perf.baseline, wallTimeMs: result.durationMs };
}

export async function runScriptCheck(
	check: string,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<ToolResult> {
	let cwd: string;
	try {
		cwd = resolveSafeCwd(typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined, process.cwd());
	} catch (error) {
		return { kind: "error", message: `verify: ${error instanceof Error ? error.message : String(error)}` };
	}
	const packagePath = path.join(cwd, "package.json");
	if (!existsSync(packagePath)) return { kind: "error", message: `verify: package.json not found in ${cwd}` };
	const pkg = parsePackageJson(packagePath);
	if (!pkg.ok) return { kind: "error", message: `verify: ${pkg.reason}` };
	if (!Object.hasOwn(pkg.scripts, check)) {
		const declared = declaredVerificationScripts(pkg.scripts);
		const list = declared.length > 0 ? declared.join(", ") : "(none)";
		return {
			kind: "error",
			message: `verify: package.json has no '${check}' script. Declared verification checks: ${list}.`,
		};
	}
	const extraArgs = Array.isArray(args.args)
		? args.args.filter((entry): entry is string => typeof entry === "string")
		: [];
	const vector = ["run", check];
	if (extraArgs.length > 0) vector.push("--", ...extraArgs);
	return withCommandJudgement(await runVectorTool("verify", "npm", vector, { ...args, cwd }, options));
}

export {
	type DeclaredCheckDiscoveryResult,
	type DeclaredProjectEntry,
	discoverDeclaredChecks,
	discoverDeclaredChecksAtRoot,
	discoverDeclaredProjectEntriesAtRoot,
	VERIFICATION_SCRIPT_FAMILY_HINT,
};
