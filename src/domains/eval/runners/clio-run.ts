import { isAbsolute, relative, resolve, sep } from "node:path";
import { normalizeClioCoderEventRecord } from "../../../core/naming-events.js";
import { shellQuote } from "../../../core/shell-quote.js";
import { clioStateDir } from "../../../core/xdg.js";
import {
	evidenceMetricsFromReceipt,
	readRunEnvelopeForReceipt,
	receiptFromRunJsonStdout,
} from "../metrics/evidence.js";
import { streamInvariantMetrics } from "../metrics/invariants.js";
import { tokenMetricEntries } from "../metrics/token-stream.js";
import type { EvalRunnerV2, EvalSuiteTargetV2 } from "../schema/suite.js";
import { type EvalRunnerOutput, runShellCommand } from "./external-command.js";

export async function runClioRunRunner(
	runner: EvalRunnerV2,
	cwd: string,
	clioEntry: string,
	timeoutMs: number,
	target: EvalSuiteTargetV2,
	env?: NodeJS.ProcessEnv,
	readObservation?: { allowedPaths: string[]; decoyPaths: string[] },
): Promise<EvalRunnerOutput> {
	const prompt = runner.prompt ?? "";
	const args = [
		shellQuote(clioEntry),
		"run",
		"--json",
		...(runner.agent === undefined ? [] : ["--agent", shellQuote(runner.agent)]),
		"--target",
		shellQuote(target.id),
		...(target.model === undefined ? [] : ["--model", shellQuote(target.model)]),
		...(target.thinking === undefined ? [] : ["--thinking", shellQuote(target.thinking)]),
		...(runner.autonomy === undefined ? [] : ["--autonomy", runner.autonomy]),
		shellQuote(prompt),
	];
	const result = await runShellCommand(`${process.execPath} ${args.join(" ")}`, cwd, runner.timeoutMs ?? timeoutMs, env);
	// Usage is folded from the live stream, not from the bounded stdout
	// artifact: a verbose run's `message_end` events do not survive truncation.
	const tokens = result.usage;
	const toolMetricStream = result.metricJsonl.length > 0 ? result.metricJsonl : result.stdout;
	const tools = toolCallMetricsFromJsonl(toolMetricStream);
	const behavioralTools = toolBehaviorMetricEntriesFromJsonl(toolMetricStream, cwd, readObservation);
	// Evidence metrics resolve only from the sealed receipt the --agent path
	// prints; a runner without a receipt leaves them absent so any gate on
	// them fails closed instead of reading prose labels.
	const receipt = receiptFromRunJsonStdout(result.stdout);
	// The canonical trust metrics authenticate the receipt against the ledger
	// row the child wrote; a stdout receipt on its own only ever reads as an
	// unchecked seal.
	const envelope =
		receipt === null ? null : readRunEnvelopeForReceipt(receipt, env?.CLIO_CODER_STATE_DIR ?? clioStateDir());
	return {
		assignmentId: receipt === null ? null : (receipt.lineage?.rootRunId ?? receipt.runId),
		terminalReceiptDigest: receipt?.integrity.digest ?? null,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		wallTimeMs: result.wallTimeMs,
		metrics: {
			"latency.wallMs": result.wallTimeMs,
			...tokenMetricEntries(tokens),
			// Folded live for the same reason the usage is: the structural
			// promise these check is broken by a run whose middle is truncated.
			...streamInvariantMetrics(result.streamInvariants),
			"tools.totalCalls": tools.totalCalls,
			"tools.failed": tools.failed,
			"tools.blocked": tools.blocked,
			...behavioralTools,
			"verifier.exitCode": result.exitCode,
			...(receipt === null ? {} : evidenceMetricsFromReceipt(receipt, { envelope })),
			...(receipt === null
				? {}
				: { "evidence.qualityLabel": receipt.quality.typedValidations.length > 0 ? "measured" : "unmeasured" }),
		},
		artifacts: {
			stdout: result.stdout,
			stderr: result.stderr,
			callLedger: JSON.stringify(result.ledgerEntries),
			...(receipt === null ? {} : { receipt: JSON.stringify(receipt) }),
		},
		receipt,
		ledgerEntries: result.ledgerEntries,
	};
}

type ToolCallMetrics = {
	totalCalls: number;
	failed: number;
	blocked: number;
};

type ToolOutcome = "ok" | "error" | "blocked";

/** Fold the terminal tool events emitted by `clio-coder run --json`. */
function toolCallMetricsFromJsonl(stdout: string): ToolCallMetrics {
	const executionEnds: ToolCallMetrics = { totalCalls: 0, failed: 0, blocked: 0 };
	const canonicalFinishes: ToolCallMetrics = { totalCalls: 0, failed: 0, blocked: 0 };
	const seenExecutionEnds = new Set<string>();
	const seenCanonicalFinishes = new Set<string>();

	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) continue;
			event = normalizeClioCoderEventRecord(parsed);
		} catch {
			continue;
		}

		if (event.type === "tool_execution_end") {
			const callId = stringField(event, "toolCallId");
			if (callId !== undefined) {
				if (seenExecutionEnds.has(callId)) continue;
				seenExecutionEnds.add(callId);
			}
			recordToolOutcome(executionEnds, toolOutcome(event) ?? (event.isError === true ? "error" : "ok"));
			continue;
		}

		if (event.type !== "clio_coder_tool_finish" || !isRecord(event.payload)) continue;
		const outcome = toolOutcome(event.payload);
		if (outcome === undefined) continue;
		const callId = stringField(event.payload, "toolCallId") ?? stringField(event, "toolCallId");
		if (callId !== undefined) {
			if (seenCanonicalFinishes.has(callId)) continue;
			seenCanonicalFinishes.add(callId);
		}
		recordToolOutcome(canonicalFinishes, outcome);
	}

	// Some runtimes emit both pi's execution end and Clio's richer finish
	// event for the same call. Prefer the finish stream wholesale so a call is
	// counted once and blocked admissions stay distinct from execution errors.
	return canonicalFinishes.totalCalls > 0 ? canonicalFinishes : executionEnds;
}

interface BehavioralToolTerminal {
	callId: string | null;
	tool: string;
	outcome: ToolOutcome;
}

/**
 * Reduce the same terminal stream to bounded behavioral facts. Tool names are
 * a dynamic metric suffix because extensions may add tools. Read paths become
 * bounded counters against the suite's explicit public allowlist and decoy
 * list; they never become behavioral fact values or evidence excerpts.
 */
export function toolBehaviorMetricEntriesFromJsonl(
	stdout: string,
	cwd: string,
	readObservation?: { allowedPaths: string[]; decoyPaths: string[] },
): Record<string, number> {
	const starts = new Map<string, { tool: string; path: string | null }>();
	const readPaths = new Set<string>();
	const executionEnds: BehavioralToolTerminal[] = [];
	const canonicalFinishes: BehavioralToolTerminal[] = [];
	const seenExecution = new Set<string>();
	const seenCanonical = new Set<string>();

	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) continue;
			event = normalizeClioCoderEventRecord(parsed);
		} catch {
			continue;
		}
		if (event.type === "tool_execution_start") {
			const callId = stringField(event, "toolCallId");
			const tool = stringField(event, "toolName");
			if (callId === undefined || tool === undefined) continue;
			const path = tool === "read" && isRecord(event.args) ? toolPath(event.args) : null;
			starts.set(callId, { tool, path });
			if (path !== null) readPaths.add(normalizeObservedPath(cwd, path));
			continue;
		}
		if (event.type === "tool_execution_end") {
			const callId = stringField(event, "toolCallId") ?? null;
			if (callId !== null && seenExecution.has(callId)) continue;
			if (callId !== null) seenExecution.add(callId);
			const tool = stringField(event, "toolName") ?? (callId === null ? undefined : starts.get(callId)?.tool);
			if (tool === undefined) continue;
			executionEnds.push({ callId, tool, outcome: toolOutcome(event) ?? (event.isError === true ? "error" : "ok") });
			continue;
		}
		if (event.type !== "clio_coder_tool_finish" || !isRecord(event.payload)) continue;
		const outcome = toolOutcome(event.payload);
		const tool = stringField(event.payload, "tool");
		if (outcome === undefined || tool === undefined) continue;
		const callId = stringField(event.payload, "toolCallId") ?? stringField(event, "toolCallId") ?? null;
		if (callId !== null && seenCanonical.has(callId)) continue;
		if (callId !== null) seenCanonical.add(callId);
		canonicalFinishes.push({ callId, tool, outcome });
	}

	const terminals = canonicalFinishes.length > 0 ? canonicalFinishes : executionEnds;
	const calls = new Map<string, number>();
	const succeeded = new Map<string, number>();
	const blocked = new Map<string, number>();
	for (const terminal of terminals) {
		const tool = metricToolName(terminal.tool);
		calls.set(tool, (calls.get(tool) ?? 0) + 1);
		if (terminal.outcome === "ok") succeeded.set(tool, (succeeded.get(tool) ?? 0) + 1);
		if (terminal.outcome === "blocked") blocked.set(tool, (blocked.get(tool) ?? 0) + 1);
	}
	const namedTools = new Set(["bash", "dispatch", "read", ...calls.keys(), ...succeeded.keys(), ...blocked.keys()]);
	const entries: Record<string, number> = { "tools.read.distinctPaths": readPaths.size };
	for (const tool of [...namedTools].sort()) {
		entries[`tools.calls.${tool}`] = calls.get(tool) ?? 0;
		entries[`tools.succeeded.${tool}`] = succeeded.get(tool) ?? 0;
		entries[`tools.blocked.${tool}`] = blocked.get(tool) ?? 0;
	}
	if (readObservation !== undefined) {
		const allowed = readObservation.allowedPaths.map((path) => normalizeObservedPath(cwd, path));
		const decoys = readObservation.decoyPaths.map((path) => normalizeObservedPath(cwd, path));
		entries["tools.read.outsideAllowed"] = [...readPaths].filter(
			(path) => !allowed.some((root) => pathWithin(path, root)),
		).length;
		entries["tools.read.decoyHits"] = [...readPaths].filter((path) =>
			decoys.some((root) => pathWithin(path, root)),
		).length;
	}
	return entries;
}

function toolPath(args: Record<string, unknown>): string | null {
	for (const field of ["path", "filePath", "file_path"]) {
		const value = args[field];
		if (typeof value === "string" && value.length > 0 && value.length <= 4_096) return value;
	}
	return null;
}

function normalizeObservedPath(cwd: string, path: string): string {
	const absolute = resolve(cwd, path);
	const local = relative(cwd, absolute);
	return (isAbsolute(path) && (local.startsWith("..") || isAbsolute(local)) ? absolute : local || ".")
		.split(sep)
		.join("/");
}

function pathWithin(path: string, root: string): boolean {
	if (root === ".") return !isAbsolute(path) && path !== ".." && !path.startsWith("../");
	return path === root || path.startsWith(`${root}/`);
}

function metricToolName(tool: string): string {
	return (
		tool
			.toLowerCase()
			.replaceAll(/[^a-z0-9_-]/gu, "_")
			.slice(0, 64) || "unknown"
	);
}

function recordToolOutcome(metrics: ToolCallMetrics, outcome: ToolOutcome): void {
	metrics.totalCalls += 1;
	if (outcome === "error") metrics.failed += 1;
	else if (outcome === "blocked") metrics.blocked += 1;
}

function toolOutcome(record: Record<string, unknown>): ToolOutcome | undefined {
	const outcome = record.outcome;
	return outcome === "ok" || outcome === "error" || outcome === "blocked" ? outcome : undefined;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
