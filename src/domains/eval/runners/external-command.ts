import { spawn } from "node:child_process";
import {
	addTokenStreamUsage,
	createTokenUsageFold,
	type EvalTokenStreamUsage,
	tokenMetricEntries,
	UNMEASURED_TOKEN_USAGE,
} from "../metrics/token-stream.js";
import type { EvalRunnerV2 } from "../schema/suite.js";

export interface EvalRunnerOutput {
	/** Exact terminal assignment/receipt linkage when this runner dispatched Clio. */
	assignmentId: string | null;
	terminalReceiptDigest: string | null;
	exitCode: number;
	stdout: string;
	stderr: string;
	wallTimeMs: number;
	metrics: Record<string, number | string | boolean | null>;
	artifacts: Record<string, string | string[] | null>;
}

export interface ShellCommandResult {
	command: string;
	exitCode: number;
	stdout: string;
	/** Compact, complete tool-event JSONL retained independently of artifact truncation. */
	metricJsonl: string;
	/** Provider usage folded from the live stream, independent of artifact truncation. */
	usage: EvalTokenStreamUsage;
	stderr: string;
	wallTimeMs: number;
	timedOut: boolean;
}

const OUTPUT_LIMIT = 200_000;
const OUTPUT_HEAD_LIMIT = 20_000;
const OUTPUT_TRUNCATION_MARKER = "\n[output middle truncated; tail preserved]\n";
const METRIC_JSONL_LIMIT = 256_000;
const METRIC_JSONL_LINE_LIMIT = 64_000;

export async function runExternalCommandRunner(
	runner: EvalRunnerV2,
	cwd: string,
	timeoutMs: number,
	env?: NodeJS.ProcessEnv,
): Promise<EvalRunnerOutput> {
	const runnerCommands = runner.commands ?? [];
	const commands = runnerCommands.length > 0 ? runnerCommands : runner.command === undefined ? [] : [runner.command];
	let stdout = "";
	let stderr = "";
	let wallTimeMs = 0;
	// An external command is an opaque subprocess: it may be a `clio run --json`
	// whose usage events cross this stdout, or a harness script that runs Clio
	// out of sight. Usage observed on the stream is reported; nothing observed
	// is reported as unmeasured, never as zero cost.
	let usage = UNMEASURED_TOKEN_USAGE;
	for (const command of commands) {
		const result = await runShellCommand(command, cwd, runner.timeoutMs ?? timeoutMs, env);
		stdout = appendLimited(stdout, result.stdout);
		stderr = appendLimited(stderr, result.stderr);
		wallTimeMs += result.wallTimeMs;
		usage = addTokenStreamUsage(usage, result.usage);
		if (result.exitCode !== 0) {
			return {
				assignmentId: null,
				terminalReceiptDigest: null,
				exitCode: result.exitCode,
				stdout,
				stderr,
				wallTimeMs,
				metrics: {
					"latency.wallMs": wallTimeMs,
					...tokenMetricEntries(usage),
					"verifier.exitCode": result.exitCode,
				},
				artifacts: {},
			};
		}
	}
	return {
		assignmentId: null,
		terminalReceiptDigest: null,
		exitCode: 0,
		stdout,
		stderr,
		wallTimeMs,
		metrics: { "latency.wallMs": wallTimeMs, ...tokenMetricEntries(usage), "verifier.exitCode": 0 },
		artifacts: {},
	};
}

export function runShellCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
	env?: NodeJS.ProcessEnv,
): Promise<ShellCommandResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		const metricCapture = createJsonlMetricCapture();
		const usageFold = createTokenUsageFold();
		let timedOut = false;
		let settled = false;
		const child = spawn(command, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			// The overlay is additive: an eval item pins where Clio writes its
			// journal, and inherits everything else the operator's shell provides.
			env: env === undefined ? process.env : { ...process.env, ...env },
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout = appendLimited(stdout, chunk);
			metricCapture.push(chunk);
			usageFold.push(chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = appendLimited(stderr, chunk);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1000);
		}, timeoutMs);
		const finish = (exitCode: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				command,
				exitCode,
				stdout,
				metricJsonl: metricCapture.finish(),
				usage: usageFold.usage(),
				stderr,
				wallTimeMs: Math.max(0, Date.now() - started),
				timedOut,
			});
		};
		child.on("error", (error) => {
			stderr = appendLimited(stderr, error.message);
			finish(1);
		});
		child.on("close", (code) => {
			finish(typeof code === "number" ? code : timedOut ? 124 : 1);
		});
	});
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Bounded head+tail capture: terminal JSON/receipts must survive verbose runs. */
export function appendLimited(current: string, chunk: string): string {
	const next = `${current}${chunk}`;
	if (next.length <= OUTPUT_LIMIT) return next;
	const tailLimit = OUTPUT_LIMIT - OUTPUT_HEAD_LIMIT - OUTPUT_TRUNCATION_MARKER.length;
	return `${next.slice(0, OUTPUT_HEAD_LIMIT)}${OUTPUT_TRUNCATION_MARKER}${next.slice(-tailLimit)}`;
}

export interface JsonlMetricCapture {
	push(chunk: string): void;
	finish(): string;
}

/**
 * Preserve the small tool-event facts used by eval metrics even when verbose
 * streaming deltas force the operator-facing stdout artifact to retain only
 * its head and tail. Input is line-buffered because child-process chunks may
 * split JSON arbitrarily; oversized non-metric lines are discarded without
 * growing memory.
 */
export function createJsonlMetricCapture(): JsonlMetricCapture {
	const lines: string[] = [];
	let storedBytes = 0;
	let pending = "";
	let discardingOversizedLine = false;
	let finished = false;

	const store = (line: string): void => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		const compact = compactMetricEvent(parsed);
		if (compact === null) return;
		const encoded = JSON.stringify(compact);
		if (encoded.length > METRIC_JSONL_LINE_LIMIT) return;
		lines.push(encoded);
		storedBytes += encoded.length + 1;
		while (storedBytes > METRIC_JSONL_LIMIT && lines.length > 1) {
			const removed = lines.shift();
			if (removed !== undefined) storedBytes -= removed.length + 1;
		}
	};

	const push = (chunk: string): void => {
		if (finished || chunk.length === 0) return;
		let remaining = chunk;
		if (discardingOversizedLine) {
			const newline = remaining.indexOf("\n");
			if (newline === -1) return;
			remaining = remaining.slice(newline + 1);
			discardingOversizedLine = false;
		}
		pending += remaining;
		for (;;) {
			const newline = pending.indexOf("\n");
			if (newline === -1) break;
			store(pending.slice(0, newline).replace(/\r$/u, ""));
			pending = pending.slice(newline + 1);
		}
		if (pending.length > METRIC_JSONL_LINE_LIMIT) {
			pending = "";
			discardingOversizedLine = true;
		}
	};

	return {
		push,
		finish(): string {
			if (!finished && !discardingOversizedLine && pending.length > 0) store(pending.replace(/\r$/u, ""));
			finished = true;
			pending = "";
			return lines.join("\n");
		},
	};
}

function compactMetricEvent(event: Record<string, unknown>): Record<string, unknown> | null {
	const type = event.type;
	if (type === "tool_execution_start") {
		const toolName = stringField(event, "toolName");
		if (toolName !== "dispatch" && toolName !== "code_nav" && toolName !== "read" && toolName !== "grep") {
			return null;
		}
		return {
			type,
			...(stringField(event, "toolCallId") !== undefined ? { toolCallId: stringField(event, "toolCallId") } : {}),
			toolName,
			...(toolName === "dispatch" && isRecord(event.args)
				? { args: event.args }
				: toolName === "code_nav" && isRecord(event.args)
					? { args: { mode: event.args.mode } }
					: {}),
		};
	}
	if (type === "tool_execution_end") {
		return {
			type,
			...(stringField(event, "toolCallId") !== undefined ? { toolCallId: stringField(event, "toolCallId") } : {}),
			...(stringField(event, "toolName") !== undefined ? { toolName: stringField(event, "toolName") } : {}),
			...(event.isError === true ? { isError: true } : {}),
			...(stringField(event, "outcome") !== undefined ? { outcome: stringField(event, "outcome") } : {}),
		};
	}
	if (type !== "clio_tool_finish" || !isRecord(event.payload)) return null;
	return {
		type,
		payload: {
			...(stringField(event.payload, "tool") !== undefined ? { tool: stringField(event.payload, "tool") } : {}),
			...(stringField(event.payload, "toolCallId") !== undefined
				? { toolCallId: stringField(event.payload, "toolCallId") }
				: stringField(event, "toolCallId") !== undefined
					? { toolCallId: stringField(event, "toolCallId") }
					: {}),
			...(stringField(event.payload, "outcome") !== undefined ? { outcome: stringField(event.payload, "outcome") } : {}),
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
