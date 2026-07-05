import { spawn } from "node:child_process";
import type { EvalRunnerV2 } from "../schema/suite.js";

export interface EvalRunnerOutput {
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
	stderr: string;
	wallTimeMs: number;
	timedOut: boolean;
}

const OUTPUT_LIMIT = 200_000;

export async function runExternalCommandRunner(
	runner: EvalRunnerV2,
	cwd: string,
	timeoutMs: number,
): Promise<EvalRunnerOutput> {
	const runnerCommands = runner.commands ?? [];
	const commands = runnerCommands.length > 0 ? runnerCommands : runner.command === undefined ? [] : [runner.command];
	let stdout = "";
	let stderr = "";
	let wallTimeMs = 0;
	for (const command of commands) {
		const result = await runShellCommand(command, cwd, runner.timeoutMs ?? timeoutMs);
		stdout = appendLimited(stdout, result.stdout);
		stderr = appendLimited(stderr, result.stderr);
		wallTimeMs += result.wallTimeMs;
		if (result.exitCode !== 0) {
			return {
				exitCode: result.exitCode,
				stdout,
				stderr,
				wallTimeMs,
				metrics: { "latency.wallMs": wallTimeMs, "verifier.exitCode": result.exitCode },
				artifacts: {},
			};
		}
	}
	return {
		exitCode: 0,
		stdout,
		stderr,
		wallTimeMs,
		metrics: { "latency.wallMs": wallTimeMs, "verifier.exitCode": 0 },
		artifacts: {},
	};
}

export function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<ShellCommandResult> {
	const started = Date.now();
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout = appendLimited(stdout, chunk);
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

function appendLimited(current: string, chunk: string): string {
	const next = `${current}${chunk}`;
	if (next.length <= OUTPUT_LIMIT) return next;
	return `${next.slice(0, OUTPUT_LIMIT)}\n[truncated]\n`;
}
