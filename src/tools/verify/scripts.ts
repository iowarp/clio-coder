import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	loadProjectVerifierCatalog,
	PROJECT_VERIFIER_CATALOG_RELATIVE_PATH,
	packageDeclaredCheck,
	resolveProjectVerifierExecutionCwd,
} from "./catalog.js";
import { compareNumeric, type NumericCompareReport, parseNumericPayload, renderNumericReport } from "./numeric.js";
import {
	evaluatePerfBudget,
	type PerfBaseline,
	type PerfBudgetReport,
	parsePerfBaseline,
	renderPerfBaseline,
} from "./perf.js";

/** The structured verdict a numeric-compare or perf-budget check records beside the command facts. */
export type DeclaredCheckReport = NumericCompareReport | PerfBudgetReport;

/**
 * Package scripts and the project catalog meet here as one canonical check
 * projection. Project checks retain their admitted argv/cwd/timeout exactly;
 * package scripts keep the established npm argument-widening behavior.
 */

export type DeclaredCheckDiscoveryResult = { ok: true; sources: DeclaredCheckSource[] } | { ok: false; reason: string };

export interface DeclaredProjectEntry {
	id: string;
	command: string[];
	path: string;
	detail: string;
	kind: "package-script" | "just-recipe" | "make-target";
}

function repositoryRelativeCwd(workspaceRoot: string, resolved: string): string {
	const relative = path.relative(workspaceRoot, resolved);
	return relative.length === 0 ? "." : relative.split(path.sep).join("/");
}

function packageTag(id: string): string[] {
	const separator = id.search(/[:.-]/u);
	return [separator === -1 ? id : id.slice(0, separator)];
}

function packageCheckSource(packageRoot: string, workspaceRoot: string): DeclaredCheckSource | null {
	const packagePath = path.join(packageRoot, "package.json");
	if (!existsSync(packagePath)) return null;
	const pkg = parsePackageJson(packagePath);
	if (!pkg.ok) return null;
	const cwd = repositoryRelativeCwd(workspaceRoot, packageRoot);
	const checks = declaredVerificationScripts(pkg.scripts).map((id) =>
		packageDeclaredCheck(id, packagePath, cwd, packageTag(id)),
	);
	return { kind: "package.json", path: packagePath, checks };
}

/** Discover every exact project-declared entry without promoting it to a verifier check. */
export function discoverDeclaredProjectEntriesAtRoot(workspaceRoot: string): DeclaredProjectEntry[] {
	const entries: DeclaredProjectEntry[] = [];
	const packagePath = path.join(workspaceRoot, "package.json");
	if (existsSync(packagePath)) {
		const pkg = parsePackageJson(packagePath);
		if (pkg.ok) {
			for (const name of Object.keys(pkg.scripts).sort()) {
				if (typeof pkg.scripts[name] !== "string") continue;
				entries.push({
					id: name,
					command: ["npm", "run", name],
					path: "package.json",
					detail: `package.json script '${name}'`,
					kind: "package-script",
				});
			}
		}
	}
	for (const relative of ["justfile", "Justfile"] as const) {
		const filePath = path.join(workspaceRoot, relative);
		if (!existsSync(filePath)) continue;
		const text = readFileSync(filePath, "utf8");
		for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*(?:[^:=\n]*)?:\s*(?:#.*)?$/gmu)) {
			const name = match[1];
			if (name === undefined || name.startsWith("_")) continue;
			entries.push({
				id: name,
				command: ["just", name],
				path: relative,
				detail: `just recipe '${name}'`,
				kind: "just-recipe",
			});
		}
		break;
	}
	const makePath = path.join(workspaceRoot, "Makefile");
	if (existsSync(makePath)) {
		const text = readFileSync(makePath, "utf8");
		for (const match of text.matchAll(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?![=])[^\n]*$/gmu)) {
			const name = match[1];
			if (name === undefined || name.startsWith(".")) continue;
			entries.push({
				id: name,
				command: ["make", name],
				path: "Makefile",
				detail: `Makefile target '${name}'`,
				kind: "make-target",
			});
		}
	}
	return entries;
}

function providerCollision(sources: ReadonlyArray<DeclaredCheckSource>): string | null {
	const seen = new Map<string, DeclaredCheck>();
	for (const source of sources) {
		for (const check of source.checks) {
			const prior = seen.get(check.id);
			if (prior !== undefined) {
				return (
					`duplicate declared check id '${check.id}' from ` +
					`${prior.source.kind} (${prior.source.path}) and ${check.source.kind} (${check.source.path})`
				);
			}
			seen.set(check.id, check);
		}
	}
	return null;
}

export function discoverDeclaredChecksAtRoot(
	workspaceRoot: string,
	cwdArg: string | undefined,
): DeclaredCheckDiscoveryResult {
	let packageRoot: string;
	try {
		packageRoot = resolveSafeCwd(cwdArg, workspaceRoot);
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	const sources: DeclaredCheckSource[] = [];
	const packageSource = packageCheckSource(packageRoot, workspaceRoot);
	if (packageSource !== null) sources.push(packageSource);
	const projectCatalog = loadProjectVerifierCatalog(workspaceRoot);
	if (!projectCatalog.ok) return projectCatalog;
	if (projectCatalog.source !== null) sources.push(projectCatalog.source);
	const collision = providerCollision(sources);
	if (collision !== null) return { ok: false, reason: collision };
	return { ok: true, sources };
}

export function discoverDeclaredChecks(cwdArg: string | undefined): DeclaredCheckDiscoveryResult {
	return discoverDeclaredChecksAtRoot(process.cwd(), cwdArg);
}

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
	const lines: string[] = [];
	if (discovery.sources.length === 0 || discovery.sources.every((source) => source.checks.length === 0)) {
		lines.push(
			`No declared verification checks found (no package.json verification scripts or ${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH} entries).`,
			"Run `clio-coder verifiers author` to inspect declared project tooling, preview exact argv checks, and create the catalog after confirmation.",
		);
	} else {
		lines.push("Declared verification checks:");
		for (const source of discovery.sources) {
			lines.push(source.kind === "package.json" ? "package.json:" : `${PROJECT_VERIFIER_CATALOG_RELATIVE_PATH}:`);
			for (const check of source.checks) {
				const tags = check.tags.length > 0 ? ` [${check.tags.join(", ")}]` : "";
				lines.push(`- ${check.id}${tags}: ${check.description}`);
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
		details: { sources: clonedSources(discovery.sources) },
	};
}

function withDeclaredEvidence(result: ToolResult, check: DeclaredCheck): ToolResult {
	return {
		...result,
		details: {
			...result.details,
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

/** Read a repository-relative check file inside the workspace root, as text. */
function readCheckFile(workspaceRoot: string, relative: string, label: string): string | Error {
	let resolved: string;
	try {
		resolved = resolveSafeCwd(relative, workspaceRoot);
	} catch (error) {
		return new Error(`${label} ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!existsSync(resolved)) return new Error(`${label} '${relative}' does not exist`);
	try {
		return readFileSync(resolved, "utf8");
	} catch (error) {
		return new Error(`${label} '${relative}' cannot be read (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** Judge a numeric-compare command's stdout against reference text already read from disk. Pure. */
export function judgeNumericTexts(
	stdout: string,
	referenceText: string,
	tolerance: DeclaredNumericCompare["tolerance"],
	referenceLabel: string,
): NumericCompareReport | Error {
	const reference = parseNumericPayload(referenceText, referenceLabel);
	if (reference instanceof Error) return reference;
	const actual = parseNumericPayload(extractNumericPayloadText(stdout), "command output");
	if (actual instanceof Error) return actual;
	return compareNumeric(actual, reference, tolerance);
}

/** Judge a numeric-compare command's stdout against the declared reference under the workspace root. */
function judgeNumericCompare(
	stdout: string,
	numeric: DeclaredNumericCompare,
	workspaceRoot: string,
): NumericCompareReport | Error {
	const referenceText = readCheckFile(workspaceRoot, numeric.reference, "reference");
	if (referenceText instanceof Error) return referenceText;
	return judgeNumericTexts(stdout, referenceText, numeric.tolerance, `reference '${numeric.reference}'`);
}

/** Judge a measured wall time against a budget, or against baseline text already read from disk. Pure. */
export function judgePerfTexts(
	measuredMs: number,
	perf: DeclaredPerfBudget,
	baselineText: string | undefined,
	baselineLabel: string,
): PerfBudgetReport | Error {
	let baseline: PerfBaseline | undefined;
	if (perf.baseline !== undefined) {
		if (baselineText === undefined) {
			return new Error(`${baselineLabel} is missing; record it with \`clio-coder verifiers baseline <id>\``);
		}
		const parsed = parsePerfBaseline(baselineText, baselineLabel);
		if (parsed instanceof Error) return parsed;
		baseline = parsed;
	}
	return evaluatePerfBudget(measuredMs, {
		...(perf.budget !== undefined ? { budget: perf.budget } : {}),
		...(baseline !== undefined ? { baseline } : {}),
		...(perf.tolerance?.relative !== undefined ? { relative: perf.tolerance.relative } : {}),
	});
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
 * exits non-zero, times out, or is aborted fails before any comparison, so a
 * crashed validator never reads as a tolerance verdict.
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
			...(options?.signal !== undefined ? { signal: options.signal } : {}),
		});
	} catch (error) {
		return { kind: "error", message: `verify: ${error instanceof Error ? error.message : String(error)}` };
	}
	const facts = commandFacts(result);
	const tail = `${result.stdout}${result.stderr}`.trim().slice(-2_000);
	if (result.aborted) return { kind: "error", message: "verify: aborted", details: facts };
	if (result.timedOut) return { kind: "error", message: `verify: timed out after ${check.timeoutMs}ms`, details: facts };
	if (result.exitCode !== 0) {
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
	const details = { ...facts, report };
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
 * check's `baseline` path names. The command must exit cleanly; a failed run
 * records nothing, so a baseline never encodes a broken command's timing.
 */
export async function recordPerfBaseline(
	check: DeclaredCheck,
	options?: { signal?: AbortSignal; now?: () => Date },
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
			...(options?.signal !== undefined ? { signal: options.signal } : {}),
		});
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	if (result.aborted || result.timedOut || result.exitCode !== 0) {
		return {
			ok: false,
			message: `command ${result.timedOut ? "timed out" : result.aborted ? "was aborted" : `exited with code ${result.exitCode ?? "?"}`}; no baseline recorded`,
		};
	}
	let target: string;
	try {
		target = resolveSafeCwd(check.perf.baseline, process.cwd());
	} catch (error) {
		return { ok: false, message: `baseline ${error instanceof Error ? error.message : String(error)}` };
	}
	const recordedAt = (options?.now?.() ?? new Date()).toISOString();
	try {
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, renderPerfBaseline({ wallTimeMs: result.durationMs, check: check.id, recordedAt }), "utf8");
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
	return runVectorTool("verify", "npm", vector, { ...args, cwd }, options);
}

export { VERIFICATION_SCRIPT_FAMILY_HINT };

function parsePackageJson(
	packagePath: string,
): { ok: true; scripts: Record<string, unknown> } | { ok: false; reason: string } {
	try {
		const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { ok: false, reason: "package.json root must be an object" };
		}
		const scripts = (parsed as Record<string, unknown>).scripts;
		if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
			return { ok: false, reason: "package.json has no scripts object" };
		}
		return { ok: true, scripts: scripts as Record<string, unknown> };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
