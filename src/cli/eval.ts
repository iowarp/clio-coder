import { resolve } from "node:path";
import { InvalidIdError } from "../core/safe-id.js";
import { clioDataDir } from "../core/xdg.js";
import { loadEvalArtifactV4, writeEvalArtifactV4 } from "../domains/eval/artifacts/store.js";
import { compareEvalArtifactsV4 } from "../domains/eval/compare/compare.js";
import { evaluateGate, renderGateFailure, renderInformationalBudget } from "../domains/eval/compare/gates.js";
import { loadThresholds } from "../domains/eval/compare/thresholds.js";
import { type EvalComparisonReportFormat, renderEvalComparisonReportV1 } from "../domains/eval/reports/comparison.js";
import { renderEvalJsonReportV4 } from "../domains/eval/reports/json.js";
import { renderEvalJunitReportV4 } from "../domains/eval/reports/junit.js";
import { renderEvalMarkdownReportV4 } from "../domains/eval/reports/markdown.js";
import { renderEvalSweJsonlReportV4 } from "../domains/eval/reports/swe-jsonl.js";
import { renderEvalTextReportV4 } from "../domains/eval/reports/text.js";
import type { EvalArtifactV4 } from "../domains/eval/schema/artifact.js";
import { EvalSuiteFileError, loadEvalSuiteFile, loadV1TaskFileAsSuite } from "../domains/eval/suites/load.js";
import { resolveSuiteForRun } from "../domains/eval/suites/resolve.js";
import { runEvalSuiteV2 } from "../domains/eval/suites/run.js";
import { EvalTaskFileError } from "../domains/eval/task-file.js";
import { printError } from "./shared.js";

const HELP = `clio-coder eval <command>

Commands:
  clio-coder eval validate --suite <suite.yaml>
	  clio-coder eval run --suite <suite.yaml> [--trials <n>] [--target <id>] [--model <id>] [--out <path>] [--clio-coder-entry <path>]
	  clio-coder eval run --task-file <tasks.yaml> [--repeat <n>] [--out <path>] [--clio-coder-entry <path>]
  clio-coder eval report <evalId> --format text|json|md|swe-jsonl|junit
	  clio-coder eval compare <baselineEvalId> <candidateEvalId> [--metric <name>] [--format text|json|md|junit] [--allow-config-drift]
  clio-coder eval gate <candidateEvalId> --baseline <baselineEvalId> [--thresholds <file>]
  clio-coder eval inventory --json

inventory is the fixed machine-readable read a GUI host may run. Unlike report
and compare it names no eval id, so the process it starts cannot be steered to a
different report or a wider window. It carries each stored report's identity,
provenance, serving facts, accounting, and per-scenario outcomes, and none of
the runner attachments a report holds.
`;

type EvalCommand = "validate" | "run" | "report" | "compare" | "gate";
type EvalReportFormat = "text" | "json" | "md" | "swe-jsonl" | "junit";

interface ParsedEvalArgs {
	command?: EvalCommand;
	suite?: string;
	taskFile?: string;
	repeat: number;
	trials?: number;
	target?: string;
	model?: string;
	out?: string;
	clioEntry?: string;
	evalId?: string;
	format: EvalReportFormat;
	compareIds: string[];
	metric?: string;
	allowConfigDrift: boolean;
	baseline?: string;
	thresholds?: string;
	help: boolean;
}

function parseEvalArgs(args: ReadonlyArray<string>): ParsedEvalArgs {
	const parsed: ParsedEvalArgs = {
		repeat: 1,
		compareIds: [],
		format: "text",
		allowConfigDrift: false,
		help: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (arg === "validate" || arg === "run" || arg === "report" || arg === "compare" || arg === "gate") {
				parsed.command = arg;
				continue;
			}
			throw new Error(`unknown eval command: ${arg}`);
		}
		if (parsed.command === "validate") {
			if (arg === "--suite") {
				parsed.suite = requiredValue(args, index, "--suite");
				index += 1;
				continue;
			}
			throw new Error(`unknown eval validate argument: ${arg}`);
		}
		if (parsed.command === "run") {
			if (arg === "--suite") {
				parsed.suite = requiredValue(args, index, "--suite");
				index += 1;
				continue;
			}
			if (arg === "--task-file") {
				parsed.taskFile = requiredValue(args, index, "--task-file");
				index += 1;
				continue;
			}
			if (arg === "--target") {
				parsed.target = requiredValue(args, index, "--target");
				index += 1;
				continue;
			}
			if (arg === "--model") {
				parsed.model = requiredValue(args, index, "--model");
				index += 1;
				continue;
			}
			if (arg === "--out") {
				parsed.out = requiredValue(args, index, "--out");
				index += 1;
				continue;
			}
			// `--clio-entry` is the pre-0.3.1 spelling and still parses.
			if (arg === "--clio-coder-entry" || arg === "--clio-entry") {
				parsed.clioEntry = requiredValue(args, index, arg);
				index += 1;
				continue;
			}
			if (arg === "--repeat") {
				parsed.repeat = positiveInteger(requiredValue(args, index, "--repeat"), "--repeat");
				index += 1;
				continue;
			}
			if (arg === "--trials") {
				parsed.trials = positiveInteger(requiredValue(args, index, "--trials"), "--trials");
				index += 1;
				continue;
			}
			throw new Error(`unknown eval run argument: ${arg}`);
		}
		if (parsed.command === "report") {
			if (arg === "--format") {
				parsed.format = reportFormat(requiredValue(args, index, "--format"));
				index += 1;
				continue;
			}
			if (parsed.evalId === undefined && !arg.startsWith("-")) {
				parsed.evalId = arg;
				continue;
			}
			throw new Error(`unexpected eval report argument: ${arg}`);
		}
		if (parsed.command === "compare") {
			if (arg === "--format") {
				parsed.format = comparisonFormat(requiredValue(args, index, "--format"));
				index += 1;
				continue;
			}
			if (arg === "--metric") {
				parsed.metric = requiredValue(args, index, "--metric");
				index += 1;
				continue;
			}
			if (arg === "--allow-config-drift") {
				parsed.allowConfigDrift = true;
				continue;
			}
			if (!arg.startsWith("-")) {
				parsed.compareIds.push(arg);
				continue;
			}
			throw new Error(`unexpected eval compare argument: ${arg}`);
		}
		if (parsed.command === "gate") {
			if (arg === "--baseline") {
				parsed.baseline = requiredValue(args, index, "--baseline");
				index += 1;
				continue;
			}
			if (arg === "--thresholds") {
				parsed.thresholds = requiredValue(args, index, "--thresholds");
				index += 1;
				continue;
			}
			if (parsed.evalId === undefined && !arg.startsWith("-")) {
				parsed.evalId = arg;
				continue;
			}
			throw new Error(`unexpected eval gate argument: ${arg}`);
		}
	}
	if (parsed.help) return parsed;
	if (parsed.command === undefined) throw new Error("eval requires a command");
	if (parsed.command === "validate" && parsed.suite === undefined) throw new Error("validate requires --suite <path>");
	if (parsed.command === "run" && (parsed.suite === undefined) === (parsed.taskFile === undefined)) {
		throw new Error("run requires exactly one of --suite or --task-file");
	}
	if (parsed.command === "report" && parsed.evalId === undefined) throw new Error("report requires an eval id");
	if (parsed.command === "compare" && parsed.compareIds.length !== 2) {
		throw new Error("compare requires <baselineEvalId> <candidateEvalId>");
	}
	if (parsed.command === "gate" && (parsed.evalId === undefined || parsed.baseline === undefined)) {
		throw new Error("gate requires <candidateEvalId> --baseline <baselineEvalId>");
	}
	return parsed;
}

export async function runEvalCommand(args: ReadonlyArray<string>): Promise<number> {
	// Routed before the shared parser so the fixed read stays exactly fixed: no
	// eval flag can reach it, and no flag it does not name can be spent on it.
	if (args[0] === "inventory") {
		const { runEvalInventory } = await import("./eval-inventory.js");
		return runEvalInventory(args.slice(1));
	}
	let parsed: ParsedEvalArgs;
	try {
		parsed = parseEvalArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.command === "validate") return runEvalValidate(parsed);
	if (parsed.command === "run") return runEvalRun(parsed);
	if (parsed.command === "report") return runEvalReportCommand(parsed);
	if (parsed.command === "compare") return runEvalCompareCommand(parsed);
	if (parsed.command === "gate") return runEvalGateCommand(parsed);
	printError("eval requires a command");
	return 2;
}

async function runEvalValidate(parsed: ParsedEvalArgs): Promise<number> {
	try {
		const loaded = await loadEvalSuiteFile(parsed.suite ?? "");
		process.stdout.write(`valid suite: ${loaded.suite.suite.id}\n`);
		return 0;
	} catch (error) {
		return handleEvalLoadError(error);
	}
}

async function runEvalRun(parsed: ParsedEvalArgs): Promise<number> {
	try {
		const loaded =
			parsed.suite !== undefined
				? await loadEvalSuiteFile(parsed.suite)
				: await loadV1TaskFileAsSuite(parsed.taskFile ?? "", parsed.trials ?? parsed.repeat);
		const resolveOptions: { target?: string; model?: string } = {};
		if (parsed.target !== undefined) resolveOptions.target = parsed.target;
		if (parsed.model !== undefined) resolveOptions.model = parsed.model;
		const suite = resolveSuiteForRun(loaded.suite, {
			...resolveOptions,
			...(parsed.trials ? { trials: parsed.trials } : {}),
		});
		// Runner commands execute with cwd inside prepared eval workspaces, so a
		// relative --clio-coder-entry must be pinned to the invoking directory here.
		const clioEntry = resolve(parsed.clioEntry ?? process.argv[1] ?? "dist/cli/index.js");
		const artifact = await runEvalSuiteV2(
			{ ...loaded, suite },
			{ clioEntry, freshWorkspaces: parsed.trials !== undefined },
		);
		const artifactPath = await writeEvalArtifactV4(clioDataDir(), artifact, parsed.out);
		process.stdout.write(`${renderEvalTextReportV4(artifact)}artifact: ${artifactPath}\n`);
		// A suite that declares thresholds is gated by them here, on the artifact
		// it just produced. Declaring a gate that only a later `eval gate`
		// invocation enforces means the run that broke it still exited zero.
		const gate = suite.thresholds === undefined ? null : evaluateGate(artifact, suite.thresholds);
		if (gate !== null && !gate.pass) {
			process.stdout.write(`gate: fail (${gate.failures.length} threshold failure)\n`);
			for (const failure of gate.failures) process.stdout.write(renderGateFailure(failure));
		}
		if (gate !== null && gate.informational.length > 0) {
			process.stdout.write(`informational budgets: ${gate.informational.length} notice\n`);
			for (const finding of gate.informational) process.stdout.write(renderInformationalBudget(finding));
		}
		return artifact.summary.failed === 0 && (gate === null || gate.pass) ? 0 : 1;
	} catch (error) {
		return handleEvalLoadError(error, 1);
	}
}

async function runEvalReportCommand(parsed: ParsedEvalArgs): Promise<number> {
	try {
		const dataDir = clioDataDir();
		const artifact = await loadEvalArtifactV4(dataDir, parsed.evalId ?? "");
		process.stdout.write(renderArtifactReport(artifact, parsed.format, dataDir));
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return error instanceof InvalidIdError ? 2 : 1;
	}
}

async function runEvalCompareCommand(parsed: ParsedEvalArgs): Promise<number> {
	const baselineEvalId = parsed.compareIds[0] ?? "";
	const candidateEvalId = parsed.compareIds[1] ?? "";
	try {
		const dataDir = clioDataDir();
		const baseline = await loadEvalArtifactV4(dataDir, baselineEvalId);
		const candidate = await loadEvalArtifactV4(dataDir, candidateEvalId);
		const summary = compareEvalArtifactsV4(baseline, candidate, {
			allowConfigDrift: parsed.allowConfigDrift,
			...(parsed.metric === undefined ? {} : { metric: parsed.metric }),
		});
		process.stdout.write(renderEvalComparisonReportV1(summary, parsed.format as EvalComparisonReportFormat));
		return summary.hardGate.pass ? 0 : 1;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return error instanceof InvalidIdError ? 2 : 1;
	}
}

async function runEvalGateCommand(parsed: ParsedEvalArgs): Promise<number> {
	try {
		const dataDir = clioDataDir();
		const candidate = await loadEvalArtifactV4(dataDir, parsed.evalId ?? "");
		const baseline = await loadEvalArtifactV4(dataDir, parsed.baseline ?? "");
		const thresholds =
			parsed.thresholds === undefined
				? { fail: [{ metric: "result.pass", op: "eq" as const, value: false }], informational: [] }
				: loadThresholds(parsed.thresholds);
		const gate = evaluateGate(candidate, thresholds);
		const comparison = compareEvalArtifactsV4(baseline, candidate);
		if (gate.informational.length > 0) {
			process.stdout.write(`informational budgets: ${gate.informational.length} notice\n`);
			for (const finding of gate.informational) process.stdout.write(renderInformationalBudget(finding));
		}
		if (gate.pass && comparison.hardGate.pass) {
			process.stdout.write("gate: pass\n");
			return 0;
		}
		const failureCount =
			gate.failures.length + comparison.hardGate.failures.length + comparison.hardGate.envelopeFailures.length;
		process.stdout.write(`gate: fail (${failureCount} hard failure)\n`);
		for (const failure of gate.failures) process.stdout.write(renderGateFailure(failure));
		for (const failure of comparison.hardGate.failures) {
			process.stdout.write(
				`  ${failure.metric} [${failure.scenarioId}:${failure.role}:${failure.target.id}/${failure.target.model ?? "none"}]: ${failure.change} (hard behavioral gate)\n`,
			);
		}
		for (const failure of comparison.hardGate.envelopeFailures) {
			process.stdout.write(
				`  execution envelope [${failure.scenarioId}:${failure.role}:${failure.target.id}/${failure.target.model ?? "none"}]: incomparable fields ${failure.fields.join(", ")}\n`,
			);
		}
		return 1;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return error instanceof InvalidIdError ? 2 : 1;
	}
}

function renderArtifactReport(artifact: EvalArtifactV4, format: EvalReportFormat, _dataDir: string): string {
	if (format === "json") return renderEvalJsonReportV4(artifact);
	if (format === "md") return renderEvalMarkdownReportV4(artifact);
	if (format === "swe-jsonl") return renderEvalSweJsonlReportV4(artifact);
	if (format === "junit") return renderEvalJunitReportV4(artifact);
	return renderEvalTextReportV4(artifact);
}

function handleEvalLoadError(error: unknown, fallback = 2): number {
	if (error instanceof EvalSuiteFileError || error instanceof EvalTaskFileError) {
		printError(error.message);
		for (const issue of error.issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
		return 2;
	}
	printError(error instanceof Error ? error.message : String(error));
	return fallback;
}

function requiredValue(args: ReadonlyArray<string>, index: number, flag: string): string {
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) throw new Error(`${flag} requires a value`);
	return value;
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
		throw new Error(`${flag} requires a positive integer`);
	}
	return parsed;
}

function reportFormat(value: string): EvalReportFormat {
	if (value === "text" || value === "json" || value === "md" || value === "swe-jsonl" || value === "junit") return value;
	throw new Error("--format must be text, json, md, swe-jsonl, or junit");
}

function comparisonFormat(value: string): EvalComparisonReportFormat {
	if (value === "text" || value === "json" || value === "md" || value === "junit") return value;
	throw new Error("eval compare --format must be text, json, md, or junit");
}
