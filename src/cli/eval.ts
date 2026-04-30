import { clioDataDir } from "../core/xdg.js";
import type { EvalRunArtifact } from "../domains/eval/index.js";
import {
	compareEvalArtifacts,
	createEvalId,
	EvalTaskFileError,
	evalArtifactPath,
	loadEvalArtifact,
	loadEvalTaskFile,
	renderEvalComparison,
	renderEvalReport,
	runEvalTasks,
	writeEvalArtifact,
} from "../domains/eval/index.js";
import { buildEvalEvidence, evalEvidenceId } from "../domains/evidence/index.js";
import { printError } from "./shared.js";

const HELP = `clio eval run --task-file <tasks.yaml> [--repeat <n>]
clio eval report <evalId>
clio eval compare <baselineEvalId> <candidateEvalId>

Run repo-local YAML eval tasks, reports, or baseline/candidate comparisons.
`;

type EvalCommand = "run" | "report" | "compare";

interface ParsedEvalArgs {
	command?: EvalCommand;
	taskFile?: string;
	repeat: number;
	evalId?: string;
	compareIds: string[];
	help: boolean;
}

function parseEvalArgs(args: ReadonlyArray<string>): ParsedEvalArgs {
	const parsed: ParsedEvalArgs = { repeat: 1, compareIds: [], help: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (arg === "run" || arg === "report" || arg === "compare") {
				parsed.command = arg;
				continue;
			}
			throw new Error(`unknown eval command: ${arg}`);
		}
		if (parsed.command === "run") {
			if (arg === "--task-file") {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("-")) throw new Error("--task-file requires a path");
				parsed.taskFile = value;
				index += 1;
				continue;
			}
			if (arg === "--repeat") {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("-")) throw new Error("--repeat requires a positive integer");
				const repeat = Number.parseInt(value, 10);
				if (!Number.isInteger(repeat) || repeat <= 0 || String(repeat) !== value) {
					throw new Error("--repeat requires a positive integer");
				}
				parsed.repeat = repeat;
				index += 1;
				continue;
			}
			throw new Error(`unknown eval run argument: ${arg}`);
		}
		if (parsed.command === "report") {
			if (parsed.evalId === undefined && !arg.startsWith("-")) {
				parsed.evalId = arg;
				continue;
			}
			throw new Error(`unexpected eval report argument: ${arg}`);
		}
		if (parsed.command === "compare") {
			if (!arg.startsWith("-")) {
				parsed.compareIds.push(arg);
				continue;
			}
			throw new Error(`unexpected eval compare argument: ${arg}`);
		}
	}
	if (parsed.help) return parsed;
	if (parsed.command === undefined) throw new Error("eval requires run, report, or compare");
	if (parsed.command === "run" && parsed.taskFile === undefined) throw new Error("run requires --task-file <path>");
	if (parsed.command === "report" && parsed.evalId === undefined) throw new Error("report requires an eval id");
	if (parsed.command === "compare" && parsed.compareIds.length !== 2) {
		throw new Error("compare requires <baselineEvalId> <candidateEvalId>");
	}
	return parsed;
}

export async function runEvalCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedEvalArgs;
	try {
		parsed = parseEvalArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.command === "run") return runEvalRun(parsed);
	if (parsed.command === "report") return runEvalReportCommand(parsed);
	if (parsed.command === "compare") return runEvalCompareCommand(parsed);
	printError("eval requires run, report, or compare");
	return 2;
}

async function runEvalRun(parsed: ParsedEvalArgs): Promise<number> {
	const taskFile = parsed.taskFile;
	if (taskFile === undefined) {
		printError("run requires --task-file <path>");
		return 2;
	}
	try {
		const loadedTaskFile = await loadEvalTaskFile(taskFile);
		const startedAt = new Date();
		const evalId = createEvalId(startedAt, loadedTaskFile.contentHash);
		const artifact = await runEvalTasks({
			loadedTaskFile,
			repeat: parsed.repeat,
			evalId,
			now: () => new Date(),
		});
		const dataDir = clioDataDir();
		const linkedArtifact = withEvidenceId(artifact, evalEvidenceId(artifact.evalId));
		await buildEvalEvidence({ dataDir, artifact: linkedArtifact });
		const artifactPath = await writeEvalArtifact(dataDir, linkedArtifact);
		process.stdout.write(renderEvalReport(linkedArtifact, artifactPath));
		return linkedArtifact.summary.failed === 0 ? 0 : 1;
	} catch (error) {
		if (error instanceof EvalTaskFileError) {
			printError(error.message);
			for (const issue of error.issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
			return 2;
		}
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

function withEvidenceId(artifact: EvalRunArtifact, evidenceId: string): EvalRunArtifact {
	return {
		...artifact,
		results: artifact.results.map((result) => ({ ...result, evidenceId })),
	};
}

async function runEvalReportCommand(parsed: ParsedEvalArgs): Promise<number> {
	const evalId = parsed.evalId;
	if (evalId === undefined) {
		printError("report requires an eval id");
		return 2;
	}
	try {
		const dataDir = clioDataDir();
		const artifact = await loadEvalArtifact(dataDir, evalId);
		process.stdout.write(renderEvalReport(artifact, evalArtifactPath(dataDir, evalId)));
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function runEvalCompareCommand(parsed: ParsedEvalArgs): Promise<number> {
	const baselineEvalId = parsed.compareIds[0];
	const candidateEvalId = parsed.compareIds[1];
	if (baselineEvalId === undefined || candidateEvalId === undefined) {
		printError("compare requires <baselineEvalId> <candidateEvalId>");
		return 2;
	}
	try {
		const dataDir = clioDataDir();
		const baseline = await loadEvalArtifact(dataDir, baselineEvalId);
		const candidate = await loadEvalArtifact(dataDir, candidateEvalId);
		process.stdout.write(renderEvalComparison(compareEvalArtifacts(baseline, candidate)));
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
