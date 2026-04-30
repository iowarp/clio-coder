import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	EvalCommandPhase,
	EvalCommandResult,
	EvalFailureClass,
	EvalRunArtifact,
	EvalRunRecord,
	EvalSummary,
	EvalTask,
	LoadedEvalTaskFile,
} from "./types.js";

const OUTPUT_LIMIT = 20_000;

export interface RunEvalOptions {
	loadedTaskFile: LoadedEvalTaskFile;
	repeat: number;
	evalId: string;
	now?: () => Date;
}

export async function runEvalTasks(options: RunEvalOptions): Promise<EvalRunArtifact> {
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const records: EvalRunRecord[] = [];
	for (let repeatIndex = 0; repeatIndex < options.repeat; repeatIndex += 1) {
		for (const task of options.loadedTaskFile.taskFile.tasks) {
			records.push(await runOneTask(options.loadedTaskFile, task, options.evalId, repeatIndex, now));
		}
	}
	const endedAt = now().toISOString();
	return {
		version: 1,
		evalId: options.evalId,
		taskFile: options.loadedTaskFile.path,
		taskFileHash: options.loadedTaskFile.contentHash,
		repeat: options.repeat,
		startedAt,
		endedAt,
		summary: summarizeEvalResults(records),
		results: records,
	};
}

export function summarizeEvalResults(records: ReadonlyArray<EvalRunRecord>): EvalSummary {
	const passed = records.filter((record) => record.pass).length;
	const failed = records.length - passed;
	const failureCounts = new Map<EvalFailureClass, number>();
	for (const record of records) {
		if (record.failureClass === undefined) continue;
		failureCounts.set(record.failureClass, (failureCounts.get(record.failureClass) ?? 0) + 1);
	}
	return {
		runs: records.length,
		passed,
		failed,
		passRate: records.length === 0 ? 0 : passed / records.length,
		tokens: records.reduce((total, record) => total + record.tokens, 0),
		costUsd: records.reduce((total, record) => total + record.costUsd, 0),
		wallTimeMs: records.reduce((total, record) => total + record.wallTimeMs, 0),
		failureClasses: [...failureCounts.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([failureClass, count]) => ({ failureClass, count })),
	};
}

async function runOneTask(
	loaded: LoadedEvalTaskFile,
	task: EvalTask,
	evalId: string,
	repeatIndex: number,
	now: () => Date,
): Promise<EvalRunRecord> {
	const runId = `${evalId}-${task.id}-${String(repeatIndex + 1).padStart(3, "0")}`;
	const cwd = resolve(loaded.baseDir, task.cwd);
	const taskStartedMs = now().getTime();
	if (!existsSync(cwd)) {
		return buildRecord(task, runId, repeatIndex, cwd, false, 1, 0, "cwd_missing", []);
	}

	const commands: EvalCommandResult[] = [];
	for (let index = 0; index < task.setup.length; index += 1) {
		const command = task.setup[index];
		if (command === undefined) continue;
		const result = await runCommand({ phase: "setup", index, command, cwd, timeoutMs: task.timeoutMs, now });
		commands.push(result);
		if (result.exitCode !== 0) {
			return buildRecord(
				task,
				runId,
				repeatIndex,
				cwd,
				false,
				result.exitCode,
				now().getTime() - taskStartedMs,
				result.timedOut ? "timeout" : "setup_failed",
				commands,
			);
		}
	}
	for (let index = 0; index < task.verifier.length; index += 1) {
		const command = task.verifier[index];
		if (command === undefined) continue;
		const result = await runCommand({ phase: "verifier", index, command, cwd, timeoutMs: task.timeoutMs, now });
		commands.push(result);
		if (result.exitCode !== 0) {
			return buildRecord(
				task,
				runId,
				repeatIndex,
				cwd,
				false,
				result.exitCode,
				now().getTime() - taskStartedMs,
				result.timedOut ? "timeout" : "verifier_failed",
				commands,
			);
		}
	}
	return buildRecord(task, runId, repeatIndex, cwd, true, 0, now().getTime() - taskStartedMs, undefined, commands);
}

function buildRecord(
	task: EvalTask,
	runId: string,
	repeatIndex: number,
	cwd: string,
	pass: boolean,
	exitCode: number,
	wallTimeMs: number,
	failureClass: EvalFailureClass | undefined,
	commands: ReadonlyArray<EvalCommandResult>,
): EvalRunRecord {
	const record: EvalRunRecord = {
		taskId: task.id,
		runId,
		repeatIndex,
		cwd,
		prompt: task.prompt,
		tags: [...task.tags],
		pass,
		exitCode,
		tokens: 0,
		costUsd: 0,
		wallTimeMs,
		commands: [...commands],
	};
	if (failureClass !== undefined) record.failureClass = failureClass;
	return record;
}

interface RunCommandOptions {
	phase: EvalCommandPhase;
	index: number;
	command: string;
	cwd: string;
	timeoutMs: number;
	now: () => Date;
}

function runCommand(options: RunCommandOptions): Promise<EvalCommandResult> {
	const startedMs = options.now().getTime();
	return new Promise((resolveResult) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let resolved = false;
		const child = spawn(options.command, {
			cwd: options.cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout = appendLimited(stdout, chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = appendLimited(stderr, chunk);
		});
		let killTimer: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				child.kill("SIGKILL");
			}, 1000);
		}, options.timeoutMs);
		const finish = (exitCode: number, signal: NodeJS.Signals | null): void => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			if (killTimer !== undefined) clearTimeout(killTimer);
			resolveResult({
				phase: options.phase,
				index: options.index,
				command: options.command,
				exitCode,
				signal,
				timedOut,
				wallTimeMs: Math.max(0, options.now().getTime() - startedMs),
				stdout,
				stderr,
			});
		};
		child.on("error", (error) => {
			stderr = appendLimited(stderr, error.message);
			finish(1, null);
		});
		child.on("close", (code, signal) => {
			const exitCode = typeof code === "number" ? code : timedOut ? 124 : 1;
			finish(exitCode, signal);
		});
	});
}

function appendLimited(current: string, chunk: string): string {
	if (current.length >= OUTPUT_LIMIT) return current;
	const next = `${current}${chunk}`;
	if (next.length <= OUTPUT_LIMIT) return next;
	return `${next.slice(0, OUTPUT_LIMIT)}\n[truncated]\n`;
}
