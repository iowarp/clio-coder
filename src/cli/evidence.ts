import { clioDataDir } from "../core/xdg.js";
import type { EvidenceOverview } from "../domains/evidence/index.js";
import { buildEvalEvidence, buildEvidence, inspectEvidence, listEvidenceOverviews } from "../domains/evidence/index.js";
import { printError, printOk } from "./shared.js";

const HELP = `clio evidence build --run <runId>
clio evidence build --session <sessionId>
clio evidence build --eval <evalId>
clio evidence inspect <evidenceId>
clio evidence list

Build or inspect deterministic Clio evidence artifacts.
`;

type EvidenceCommand = "build" | "inspect" | "list";

interface ParsedEvidenceArgs {
	command?: EvidenceCommand;
	runId?: string;
	sessionId?: string;
	evalId?: string;
	evidenceId?: string;
	help: boolean;
}

function parseEvidenceArgs(args: ReadonlyArray<string>): ParsedEvidenceArgs {
	const parsed: ParsedEvidenceArgs = { help: false };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (parsed.command === undefined) {
			if (arg === "build" || arg === "inspect" || arg === "list") {
				parsed.command = arg;
				continue;
			}
			throw new Error(`unknown evidence command: ${arg}`);
		}
		if (parsed.command === "build") {
			if (arg === "--run") {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("-")) throw new Error("--run requires a run id");
				parsed.runId = value;
				index += 1;
				continue;
			}
			if (arg === "--session") {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("-")) throw new Error("--session requires a session id");
				parsed.sessionId = value;
				index += 1;
				continue;
			}
			if (arg === "--eval") {
				const value = args[index + 1];
				if (value === undefined || value.startsWith("-")) throw new Error("--eval requires an eval id");
				parsed.evalId = value;
				index += 1;
				continue;
			}
			throw new Error(`unknown evidence build argument: ${arg}`);
		}
		if (parsed.command === "inspect" && parsed.evidenceId === undefined) {
			if (arg.startsWith("-")) throw new Error("inspect requires an evidence id");
			parsed.evidenceId = arg;
			continue;
		}
		throw new Error(`unexpected evidence argument: ${arg}`);
	}
	if (parsed.help) return parsed;
	if (parsed.command === undefined) throw new Error("evidence requires build, inspect, or list");
	if (parsed.command === "build") {
		const selectorCount = [parsed.runId, parsed.sessionId, parsed.evalId].filter((value) => value !== undefined).length;
		if (selectorCount > 1) {
			throw new Error("build accepts only one of --run, --session, or --eval");
		}
		if (selectorCount === 0) {
			throw new Error("build requires --run <runId>, --session <sessionId>, or --eval <evalId>");
		}
	}
	if (parsed.command === "inspect" && parsed.evidenceId === undefined)
		throw new Error("inspect requires an evidence id");
	if (
		parsed.command === "list" &&
		(parsed.runId !== undefined ||
			parsed.sessionId !== undefined ||
			parsed.evalId !== undefined ||
			parsed.evidenceId !== undefined)
	) {
		throw new Error("list does not accept extra arguments");
	}
	return parsed;
}

export async function runEvidenceCommand(args: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedEvidenceArgs;
	try {
		parsed = parseEvidenceArgs(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	const dataDir = clioDataDir();
	try {
		if (parsed.command === "build") {
			const result =
				parsed.evalId === undefined
					? await buildEvidence({
							dataDir,
							...(parsed.runId === undefined ? {} : { runId: parsed.runId }),
							...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
						})
					: await buildEvalEvidence({ dataDir, evalId: parsed.evalId });
			printOk(`wrote ${result.evidenceId} ${result.directory}`);
			return 0;
		}
		if (parsed.command === "inspect") {
			const evidenceId = parsed.evidenceId;
			if (evidenceId === undefined) {
				printError("inspect requires an evidence id");
				return 2;
			}
			renderEvidence(await inspectEvidence(dataDir, evidenceId));
			return 0;
		}
		if (parsed.command === "list") {
			renderEvidenceList(await listEvidenceOverviews(dataDir));
			return 0;
		}
		printError("evidence requires build, inspect, or list");
		return 2;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

function renderEvidence(input: Awaited<ReturnType<typeof inspectEvidence>>): void {
	const { overview, findings } = input;
	process.stdout.write(`evidence: ${overview.evidenceId}\n`);
	process.stdout.write(`source: ${formatSource(overview)}\n`);
	process.stdout.write(`generated: ${overview.generatedAt}\n`);
	process.stdout.write(`runs: ${overview.totals.runs}\n`);
	process.stdout.write(`receipts: ${overview.totals.receipts}\n`);
	process.stdout.write(`tool calls: ${overview.totals.toolCalls}\n`);
	process.stdout.write(`blocked tools: ${overview.totals.blockedToolCalls}\n`);
	process.stdout.write(`tags: ${formatList(overview.tags)}\n`);
	process.stdout.write(`findings: ${findings.length}\n`);
	process.stdout.write(`files: ${formatList(overview.files)}\n`);
}

function renderEvidenceList(overviews: ReadonlyArray<EvidenceOverview>): void {
	process.stdout.write(`${overviews.length} evidence artifacts\n`);
	if (overviews.length === 0) return;
	process.stdout.write("\n");
	for (const overview of overviews) {
		process.stdout.write(
			[
				overview.evidenceId.padEnd(28),
				formatSource(overview).padEnd(24),
				`${overview.totals.runs} run${overview.totals.runs === 1 ? "" : "s"}`.padEnd(8),
				formatList(overview.tags),
			].join(""),
		);
		process.stdout.write("\n");
	}
}

function formatSource(overview: EvidenceOverview): string {
	if (overview.source.kind === "run") return `run ${overview.source.runId}`;
	if (overview.source.kind === "session") return `session ${overview.source.sessionId}`;
	return `eval ${overview.source.evalId}`;
}

function formatList(values: ReadonlyArray<string>): string {
	return values.length === 0 ? "none" : values.join(", ");
}
