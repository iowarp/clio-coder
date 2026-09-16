import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	captureFileRef,
	hashFile,
	isRunId,
	RUN_FILE_HASH_MAX_BYTES,
	type RunManifest,
	runRecordsDir,
	sweepRunRecords,
} from "../../src/core/run-records.js";
import type { SafeCommandResult } from "../../src/core/safe-exec.js";
import { findExecutableOnPath } from "../../src/domains/toolchain/resolve.js";
import type { ToolResult } from "../../src/tools/registry.js";
import {
	createRunScriptProgressController,
	createRunScriptTool,
	prepareRunScriptArguments,
	RUN_SCRIPT_CAPS,
	RUN_SCRIPT_INTERPRETERS,
	type RunScriptScheduler,
	runScriptSafetyProjection,
	runScriptToolSurface,
} from "../../src/tools/run-script.js";

const roots: string[] = [];

function workspace(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-run-script-")));
	roots.push(root);
	return root;
}

function scratchOutside(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-run-script-outside-")));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function script(root: string, relative: string, body: string): string {
	const file = join(root, relative);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, body, "utf8");
	return relative;
}

function tool(root: string, extra: Parameters<typeof createRunScriptTool>[0] = {}) {
	return createRunScriptTool({ getWorkspaceRoot: () => root, ...extra });
}

function detailsOf(result: ToolResult): Record<string, unknown> {
	ok(result.details, "result carries details");
	return result.details as Record<string, unknown>;
}

function manifestOf(result: ToolResult): RunManifest {
	const manifestPath = detailsOf(result).manifestPath;
	ok(typeof manifestPath === "string");
	return JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
}

function runDirs(root: string): string[] {
	return existsSync(runRecordsDir(root)) ? readdirSync(runRecordsDir(root)).sort() : [];
}

/** A sparse regular file of `bytes` bytes, created without writing them. */
function sparseFile(file: string, bytes: number): void {
	const fd = openSync(file, "w");
	try {
		ftruncateSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

/** Open descriptors of this process, where the platform exposes them; null elsewhere. */
function openDescriptorCount(): number | null {
	try {
		return readdirSync("/proc/self/fd").length;
	} catch {
		return null;
	}
}

/** The quoted entries of a safety projection, unquoted. */
function projectedArgv(command: string): string[] {
	return [...command.matchAll(/'((?:[^']|'\\'')*)'/gu)].map((entry) => (entry[1] as string).replaceAll("'\\''", "'"));
}

function stdoutTailOf(text: string): string {
	const start = text.indexOf("--- stdout tail ---\n");
	const end = text.indexOf("\n--- stderr tail ---");
	ok(start >= 0 && end > start, "the result carries both tail sections");
	return text.slice(start + "--- stdout tail ---\n".length, end);
}

class DeterministicScheduler implements RunScriptScheduler {
	#nowMs = 0;
	#nextId = 1;
	readonly jobs = new Map<number, { callback: () => void; dueAt: number; canceled: boolean }>();

	now(): number {
		return this.#nowMs;
	}

	setTimeout(callback: () => void, delayMs: number): number {
		const id = this.#nextId++;
		this.jobs.set(id, { callback, dueAt: this.#nowMs + delayMs, canceled: false });
		return id;
	}

	clearTimeout(timer: unknown): void {
		const job = this.jobs.get(timer as number);
		if (job !== undefined) job.canceled = true;
	}

	advanceTo(nowMs: number): void {
		this.#nowMs = nowMs;
		for (const [id, job] of this.jobs) {
			if (job.canceled || job.dueAt > nowMs) continue;
			this.jobs.delete(id);
			job.callback();
		}
	}
}

describe("run_script: a successful observable run", () => {
	it("streams both outputs to logs, records the manifest, and reports declared inputs and outputs", async () => {
		const root = workspace();
		mkdirSync(join(root, "data"));
		writeFileSync(join(root, "data", "in.txt"), "1,2,3\n");
		const relative = script(
			root,
			"scripts/process.js",
			`const fs = require("node:fs");
const input = fs.readFileSync("data/in.txt", "utf8");
for (let i = 0; i < 4000; i += 1) process.stdout.write("line " + i + " " + "x".repeat(40) + "\\n");
for (let i = 0; i < 600; i += 1) process.stderr.write("warn " + i + " " + "y".repeat(40) + "\\n");
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/result.txt", "sum=" + input.trim().split(",").map(Number).reduce((a, b) => a + b, 0) + " " + process.argv.slice(2).join("|") + " " + process.env.RUN_LABEL);
`,
		);
		const result = await tool(root).run({
			interpreter: "node",
			script: relative,
			args: ["alpha", "beta gamma"],
			inputs: ["data/in.txt"],
			outputs: ["out/result.txt", "out/never.txt"],
			env: { RUN_LABEL: "trial-1", API_TOKEN: "secret-value" },
		});
		strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
		if (result.kind !== "ok") return;
		const details = detailsOf(result);
		strictEqual(details.outcome, "succeeded");
		strictEqual(details.exitCode, 0);
		ok(isRunId(details.runId as string));
		const manifest = manifestOf(result);
		strictEqual(manifest.version, 1);
		strictEqual(manifest.tool, "run_script");
		strictEqual(manifest.outcome, "succeeded");
		strictEqual(manifest.script.path, "scripts/process.js");
		strictEqual(manifest.script.realPath, join(root, "scripts", "process.js"));
		strictEqual(
			manifest.script.sha256,
			createHash("sha256")
				.update(readFileSync(join(root, "scripts", "process.js")))
				.digest("hex"),
		);
		strictEqual(manifest.script.bytes, statSync(join(root, "scripts", "process.js")).size);
		strictEqual(manifest.interpreter.name, "node");
		strictEqual(manifest.interpreter.resolvedPath, findExecutableOnPath("node"));
		deepStrictEqual(manifest.interpreter.args, []);
		deepStrictEqual(manifest.argv, [manifest.interpreter.resolvedPath, manifest.script.realPath, "alpha", "beta gamma"]);
		strictEqual(manifest.cwd, ".");
		deepStrictEqual(manifest.env, { declaredKeys: ["API_TOKEN", "RUN_LABEL"], redactedKeys: ["API_TOKEN"] });
		ok(
			!readFileSync(details.manifestPath as string, "utf8").includes("secret-value"),
			"env values never reach the manifest",
		);
		strictEqual(manifest.timeoutMs, 600_000);
		strictEqual(manifest.exitCode, 0);
		deepStrictEqual(manifest.leaderExit, { code: 0, signal: null });
		strictEqual(manifest.signal, null);
		match(manifest.startedAt, /^\d{4}-\d{2}-\d{2}T/u);
		ok(Date.parse(manifest.finishedAt) >= Date.parse(manifest.startedAt));
		ok(manifest.durationMs >= 0);
		const stdoutBytes = statSync(details.stdoutPath as string).size;
		const stderrBytes = statSync(details.stderrPath as string).size;
		strictEqual(manifest.stdoutBytes, stdoutBytes);
		strictEqual(manifest.stderrBytes, stderrBytes);
		strictEqual(
			stdoutBytes,
			4000 * ("line 0 ".length + 40 + 1) + [...Array(4000).keys()].reduce((n, i) => n + String(i).length - 1, 0),
		);
		ok(stderrBytes > 20_000);
		deepStrictEqual(manifest.logs, { stdout: "stdout.log", stderr: "stderr.log" });
		deepStrictEqual(manifest.cleanup, { descendantsCleaned: false, incomplete: false });
		strictEqual(manifest.inputs.length, 1);
		strictEqual(manifest.inputs[0]?.path, "data/in.txt");
		strictEqual(manifest.inputs[0]?.exists, true);
		strictEqual(manifest.inputs[0]?.bytes, 6);
		match(manifest.inputs[0]?.sha256 ?? "", /^[0-9a-f]{64}$/u);
		deepStrictEqual(
			manifest.outputs.map((entry) => [entry.path, entry.status, entry.exists]),
			[
				["out/result.txt", "created", true],
				["out/never.txt", "absent", false],
			],
		);
		strictEqual(readFileSync(join(root, "out", "result.txt"), "utf8"), "sum=6 alpha|beta gamma trial-1");
		match(result.output, /^run_script succeeded: node scripts\/process\.js alpha beta gamma \(exit 0, /u);
		match(result.output, /^run: \.clio-coder\/runs\/\d{8}T\d{6}Z-[0-9a-f]{6}$/mu);
		match(result.output, /^stdout: \d+ bytes \(last 8\.0KB below; full log: \.clio-coder\/runs\/[^/]+\/stdout\.log\)$/mu);
		match(result.output, /^stderr: \d+ bytes \(last 8\.0KB below; full log: /mu);
		match(result.output, /^inputs:\n {2}data\/in\.txt {2}present 6 bytes$/mu);
		match(result.output, /^outputs:\n {2}out\/result\.txt {2}created \d+ bytes\n {2}out\/never\.txt {2}absent$/mu);
		match(result.output, /^--- stdout tail ---\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/mu);
		ok(result.output.includes("line 3999 "), "the stdout tail carries the last lines");
		ok(result.output.includes("warn 599 "), "the stderr tail carries the last lines");
		ok(!result.output.includes("may be partial"), "a clean exit does not warn about partial outputs");
		ok(!result.output.includes("process group"), "a run that left nothing behind carries no cleanup note");
		ok(Buffer.byteLength(result.output) < 2 * 8 * 1024 + 2048, "the result stays bounded");
		strictEqual(readFileSync(details.stdoutPath as string, "utf8").split("\n")[0], `line 0 ${"x".repeat(40)}`);
	});

	it("marks small complete output and unchanged or modified declared outputs", async () => {
		const root = workspace();
		mkdirSync(join(root, "out"));
		writeFileSync(join(root, "out", "same.txt"), "stable");
		writeFileSync(join(root, "out", "changed.txt"), "before");
		const relative = script(
			root,
			"hello.js",
			'process.stdout.write("hi"); require("node:fs").writeFileSync("out/changed.txt", "after!")',
		);
		const result = await tool(root).run({
			interpreter: "node",
			script: relative,
			outputs: ["out/same.txt", "out/changed.txt"],
		});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		match(result.output, /^stdout: 2 bytes \(complete below\)$/mu);
		match(result.output, /^stderr: 0 bytes \(empty\)$/mu);
		match(result.output, /^--- stdout tail ---\nhi\n--- stderr tail ---\n\(empty\)$/mu);
		deepStrictEqual(
			manifestOf(result).outputs.map((entry) => [entry.path, entry.status]),
			[
				["out/same.txt", "unchanged"],
				["out/changed.txt", "modified"],
			],
		);
	});

	it("runs from a workspace root reached through a symbolic link and records under the canonical root", async () => {
		const real = workspace();
		const link = join(scratchOutside(), "workspace-link");
		symlinkSync(real, link);
		const relative = script(real, "nested/here.js", "process.stdout.write(process.cwd())");
		const result = await tool(link).run({ interpreter: "node", script: relative, cwd: "nested", outputs: ["x"] });
		strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
		if (result.kind !== "ok") return;
		const details = detailsOf(result);
		ok((details.runDir as string).startsWith(join(real, ".clio-coder", "runs")), details.runDir as string);
		ok(existsSync(details.manifestPath as string), "the manifest exists under the canonical root");
		const manifest = manifestOf(result);
		strictEqual(manifest.cwd, "nested");
		strictEqual(manifest.script.path, "nested/here.js");
		strictEqual(manifest.script.realPath, join(real, "nested", "here.js"));
		strictEqual(readFileSync(details.stdoutPath as string, "utf8"), join(real, "nested"));
		deepStrictEqual(runDirs(link), runDirs(real));
	});

	it("keeps the stream's final bytes in the result tail", async () => {
		const root = workspace();
		const sentinel = `FINAL-${randomBytes(6).toString("hex")}`;
		const relative = script(
			root,
			"long.js",
			`for (let i = 0; i < 3000; i += 1) process.stdout.write("line " + i + " " + "x".repeat(40) + "\\n");
process.stdout.write("${sentinel}");`,
		);
		const result = await tool(root).run({ interpreter: "node", script: relative });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const tail = stdoutTailOf(result.output);
		ok(tail.endsWith(sentinel), `the tail ends with the stream's last bytes: ...${tail.slice(-64)}`);
		match(tail, /^\[\.\.\. \d+ bytes omitted \.\.\.\]\n/u);
		const marker = tail.slice(0, tail.indexOf("\n") + 1);
		strictEqual(Buffer.byteLength(tail) - Buffer.byteLength(marker), RUN_SCRIPT_CAPS.resultTailBytes);
		const log = readFileSync(detailsOf(result).stdoutPath as string);
		strictEqual(
			tail.slice(marker.length),
			log.subarray(log.byteLength - RUN_SCRIPT_CAPS.resultTailBytes).toString("utf8"),
			"the tail is exactly the last 8 KiB of the log",
		);
	});
});

describe("run_script: honest failure outcomes", () => {
	it("returns an error with the run directory and partial-output notice on a nonzero exit", async () => {
		const root = workspace();
		const relative = script(
			root,
			"fail.js",
			'require("node:fs").writeFileSync("partial.csv", "a,b\\n1,"); process.stdout.write("half done\\n"); process.stderr.write("boom\\n"); process.exit(3);',
		);
		const result = await tool(root).run({ interpreter: "node", script: relative, outputs: ["partial.csv"] });
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		match(result.message, /^run_script failed: node fail\.js \(exit 3, /u);
		match(result.message, /^run: \.clio-coder\/runs\//mu);
		match(result.message, /^ {2}partial\.csv {2}created 6 bytes$/mu);
		ok(result.message.endsWith("outputs listed above may be partial; the script did not exit 0"));
		const details = detailsOf(result);
		strictEqual(details.outcome, "failed");
		strictEqual(details.exitCode, 3);
		strictEqual(manifestOf(result).outcome, "failed");
		strictEqual(readFileSync(details.stderrPath as string, "utf8"), "boom\n");
	});

	it("times out, terminates the process group, and keeps the logs written so far", async () => {
		const root = workspace();
		const relative = script(
			root,
			"slow.js",
			'process.stdout.write("started\\n"); setTimeout(() => process.stdout.write("never\\n"), 5000);',
		);
		const started = Date.now();
		const result = await tool(root).run({ interpreter: "node", script: relative, timeout_ms: 300, outputs: ["x"] });
		ok(Date.now() - started < 4000, "the timeout ends the run promptly");
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		match(result.message, /^run_script timed-out: node slow\.js \(signal SIGTERM, /u);
		ok(result.message.includes("the run timed out after 300ms (SIGTERM, then SIGKILL)"));
		const details = detailsOf(result);
		strictEqual(details.outcome, "timed-out");
		strictEqual(details.timedOut, true);
		const manifest = manifestOf(result);
		strictEqual(manifest.outcome, "timed-out");
		strictEqual(manifest.signal, "SIGTERM");
		strictEqual(readFileSync(details.stdoutPath as string, "utf8"), "started\n");
	});

	it("reports a cancelled run as aborted with its logs written", async () => {
		const root = workspace();
		const relative = script(
			root,
			"wait.js",
			'process.stdout.write("waiting\\n"); setInterval(() => process.stdout.write("tick\\n"), 50);',
		);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const result = await tool(root).run({ interpreter: "node", script: relative }, { signal: controller.signal });
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		match(result.message, /^run_script aborted: /u);
		ok(result.message.includes("the run was cancelled"));
		const details = detailsOf(result);
		strictEqual(details.aborted, true);
		strictEqual(manifestOf(result).outcome, "aborted");
		ok(readFileSync(details.stdoutPath as string, "utf8").startsWith("waiting\n"));
	});

	it("reports declared outputs honestly when cancellation follows leader exit 0 during group cleanup", async (t) => {
		if (process.platform !== "linux") return t.skip("process-group fixture and reaping checks require Linux");
		const root = workspace();
		const relative = script(
			root,
			"post-exit.js",
			`const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e",
	"process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('descendant.pid', String(process.pid)); setInterval(() => {}, 1000)"
], { stdio: "ignore" });
child.unref();
const ready = setInterval(() => {
	if (!existsSync("descendant.pid")) return;
	clearInterval(ready);
	writeFileSync("output.txt", "complete");
	process.stdout.end("leader done");
}, 10);`,
		);
		const controller = new AbortController();
		const originalKill = process.kill;
		let abortTimer: ReturnType<typeof setTimeout> | undefined;
		let sawCleanup = false;
		process.kill = ((pid: number, signal?: string | number) => {
			const result = originalKill.call(process, pid, signal as NodeJS.Signals);
			if (pid < 0 && signal === "SIGTERM" && !sawCleanup) {
				sawCleanup = true;
				// No timeout or cancellation has fired. This signal comes from
				// cleanup after leader exit; allow its pipes to reach EOF first.
				abortTimer = setTimeout(() => controller.abort(), 100);
			}
			return result;
		}) as typeof process.kill;
		try {
			const result = await tool(root).run(
				{ interpreter: "node", script: relative, outputs: ["output.txt"], timeout_ms: 10_000 },
				{ signal: controller.signal },
			);
			strictEqual(sawCleanup, true);
			strictEqual(result.kind, "error");
			if (result.kind !== "error") return;
			match(result.message, /^run_script aborted: node post-exit\.js \(exit 0, /u);
			match(result.message, /^ {2}output\.txt {2}created 8 bytes \(hash omitted: cancelled\)$/mu);
			ok(result.message.endsWith("outputs listed above may be partial; the run did not complete successfully"));
			ok(!result.message.includes("the script did not exit 0"));
			const details = detailsOf(result);
			strictEqual(details.aborted, true);
			strictEqual(details.timedOut, false);
			strictEqual(details.exitCode, 0);
			deepStrictEqual(details.leaderExit, { code: 0, signal: null });
			strictEqual(details.pipeDrainIncomplete, false, "pipes reached EOF before cancellation");
			deepStrictEqual(details.cleanup, { descendantsCleaned: true, incomplete: false });
			const manifest = manifestOf(result);
			strictEqual(manifest.outcome, "aborted");
			strictEqual(manifest.exitCode, 0);
			deepStrictEqual(manifest.leaderExit, { code: 0, signal: null });
			strictEqual(manifest.pipeDrainIncomplete, false);
			deepStrictEqual(manifest.cleanup, { descendantsCleaned: true, incomplete: false });
			strictEqual(readFileSync(details.stdoutPath as string, "utf8"), "leader done");
			strictEqual(readFileSync(join(root, "output.txt"), "utf8"), "complete");
		} finally {
			clearTimeout(abortTimer);
			process.kill = originalKill;
			const pidPath = join(root, "descendant.pid");
			if (existsSync(pidPath)) {
				const pid = Number(readFileSync(pidPath, "utf8"));
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* Already gone. */
				}
				for (let attempt = 0; attempt < 40 && existsSync(`/proc/${pid}`); attempt += 1) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				ok(!existsSync(`/proc/${pid}`), "fixture was actually reaped, not left as a zombie");
			}
		}
	});

	it("refuses to start when the signal is already aborted", async () => {
		const root = workspace();
		const relative = script(root, "noop.js", "");
		const controller = new AbortController();
		controller.abort();
		const result = await tool(root).run({ interpreter: "node", script: relative }, { signal: controller.signal });
		strictEqual(result.kind, "error");
		if (result.kind === "error") strictEqual(result.message, "run_script: aborted before execution");
		deepStrictEqual(runDirs(root), []);
	});

	it("closes both logs and writes a failure manifest when the runner throws or rejects", async () => {
		const root = workspace();
		const relative = script(root, "never.js", "");
		type Runner = NonNullable<NonNullable<Parameters<typeof createRunScriptTool>[0]>["runCommand"]>;
		const runners: Array<[string, Runner]> = [
			["rejects", () => Promise.reject(new Error("spawn exploded")) as Promise<SafeCommandResult>],
			[
				"throws",
				() => {
					throw new Error("spawn exploded");
				},
			],
		];
		for (const [mode, runCommand] of runners) {
			const before = openDescriptorCount();
			const result = await tool(root, { runCommand }).run({ interpreter: "node", script: relative, outputs: ["o"] });
			const after = openDescriptorCount();
			strictEqual(result.kind, "error", mode);
			if (result.kind !== "error") continue;
			match(result.message, /^run_script spawn-failed: node never\.js \(did not start, /u);
			ok(result.message.includes("the interpreter did not start: spawn exploded"), result.message);
			const details = detailsOf(result);
			strictEqual(details.outcome, "spawn-failed");
			strictEqual(details.failure, "spawn exploded");
			strictEqual(details.exitCode, null);
			const manifest = manifestOf(result);
			strictEqual(manifest.outcome, "spawn-failed");
			strictEqual(manifest.failure, "spawn exploded");
			strictEqual(manifest.exitCode, null);
			strictEqual(manifest.stdoutBytes, 0);
			deepStrictEqual(
				manifest.outputs.map((entry) => entry.status),
				["absent"],
			);
			ok(existsSync(details.stdoutPath as string) && existsSync(details.stderrPath as string), "both logs exist");
			if (before !== null && after !== null) ok(after <= before, `${mode}: descriptors leaked: ${before} -> ${after}`);
		}
	});
});

describe("run_script: process group cleanup reporting", () => {
	it("records descendant cleanup as a note and an incomplete teardown as an unsuccessful outcome", async () => {
		const root = workspace();
		const relative = script(root, "leaves.js", "");
		type Runner = NonNullable<NonNullable<Parameters<typeof createRunScriptTool>[0]>["runCommand"]>;
		const runnerReturning =
			(flags: Partial<SafeCommandResult>): Runner =>
			async (file, args, options) => ({
				file,
				args: [...args],
				cwd: options?.cwd ?? root,
				stdout: "",
				stderr: "",
				exitCode: 0,
				signal: null,
				aborted: false,
				timedOut: false,
				outputCapped: false,
				durationMs: 5,
				startedAt: Date.now(),
				stdoutBytes: 0,
				stderrBytes: 0,
				stdoutRetained: true,
				stderrRetained: true,
				descendantsCleaned: false,
				cleanupIncomplete: false,
				failure: null,
				...flags,
			});
		const request = { interpreter: "node", script: relative, outputs: ["o"] };

		// Descendants that were cleaned within the bound: the run succeeded and says what it had to do.
		const cleaned = await tool(root, { runCommand: runnerReturning({ descendantsCleaned: true }) }).run(request);
		strictEqual(cleaned.kind, "ok", "descendants cleaned within the bound leave the outcome a success");
		if (cleaned.kind !== "ok") return;
		match(
			cleaned.output,
			/^processes the script started were still running in its process group after it ended; they were sent SIGTERM, then SIGKILL$/mu,
		);
		ok(!/cleanup incomplete/u.test(cleaned.output));
		deepStrictEqual(manifestOf(cleaned).cleanup, { descendantsCleaned: true, incomplete: false });
		strictEqual(manifestOf(cleaned).outcome, "succeeded");
		deepStrictEqual(detailsOf(cleaned).cleanup, manifestOf(cleaned).cleanup);

		// Members that survived SIGKILL and the bound: exit 0 is preserved, the outcome is not a success.
		const failureText = "process group cleanup incomplete: members were still present 1000ms after SIGKILL";
		const incomplete = await tool(root, {
			runCommand: runnerReturning({
				exitCode: 1,
				leaderExit: { code: 0, signal: null },
				descendantsCleaned: true,
				cleanupIncomplete: true,
				failure: failureText,
			}),
		}).run(request);
		strictEqual(incomplete.kind, "error", "an incomplete teardown is an unsuccessful run");
		if (incomplete.kind !== "error") return;
		match(incomplete.message, /^run_script cleanup-incomplete: node leaves\.js \(exit 0, /u);
		match(incomplete.message, /^run: \.clio-coder\/runs\//mu);
		match(incomplete.message, /^outputs:\n {2}o {2}absent$/mu);
		match(incomplete.message, /they were sent SIGTERM, then SIGKILL$/mu);
		ok(incomplete.message.includes(`${failureText}; check for stuck processes before trusting the outputs`));
		ok(
			incomplete.message.endsWith("outputs listed above may still change; processes the script started are still present"),
		);
		ok(!incomplete.message.includes("did not exit 0"), "the leader did exit 0 and the notes do not claim otherwise");
		const details = detailsOf(incomplete);
		strictEqual(details.outcome, "cleanup-incomplete");
		strictEqual(details.exitCode, 1, "the effective exit code reports failure");
		deepStrictEqual(details.leaderExit, { code: 0, signal: null });
		deepStrictEqual(details.cleanup, { descendantsCleaned: true, incomplete: true });
		const manifest = manifestOf(incomplete);
		strictEqual(manifest.outcome, "cleanup-incomplete");
		strictEqual(manifest.exitCode, 1);
		deepStrictEqual(manifest.leaderExit, { code: 0, signal: null });
		strictEqual(manifest.signal, null);
		deepStrictEqual(manifest.cleanup, { descendantsCleaned: true, incomplete: true });

		// A nonzero exit stays a plain failure even when the teardown was incomplete; the note still appears.
		const failed = await tool(root, {
			runCommand: runnerReturning({ exitCode: 3, cleanupIncomplete: true, failure: failureText }),
		}).run(request);
		strictEqual(failed.kind, "error");
		if (failed.kind !== "error") return;
		strictEqual(detailsOf(failed).outcome, "failed");
		strictEqual(detailsOf(failed).exitCode, 3);
		ok(failed.message.includes(failureText));
	});

	it("reports pipe draining separately from process group cleanup and preserves leader identity", async () => {
		const root = workspace();
		const relative = script(root, "escaped.js", "");
		const result = await tool(root, {
			runCommand: async (file, args) => ({
				file,
				args: [...args],
				cwd: root,
				stdout: "partial",
				stderr: "",
				exitCode: 1,
				signal: null,
				leaderExit: { code: 0, signal: null },
				pipeDrainIncomplete: true,
				cleanupIncomplete: false,
				aborted: false,
				timedOut: false,
				outputCapped: false,
				durationMs: 1000,
			}),
		}).run({ interpreter: "node", script: relative, outputs: ["o"] });
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		strictEqual(manifestOf(result).outcome, "pipe-drain-incomplete");
		strictEqual(manifestOf(result).pipeDrainIncomplete, true);
		strictEqual(detailsOf(result).pipeDrainIncomplete, true);
		deepStrictEqual(manifestOf(result).leaderExit, { code: 0, signal: null });
		match(result.message, /escaped processes are not contained/u);
		ok(!result.message.includes("did not exit 0"));
	});

	it("cleans up and reaps a TERM-resistant descendant a script leaves behind", async (t) => {
		if (process.platform === "win32") {
			t.skip("process groups are a POSIX mechanism");
			return;
		}
		const root = workspace();
		const relative = script(
			root,
			"daemonish.js",
			`const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const child = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('descendant.pid', String(process.pid)); setInterval(() => {}, 1000)"],
	{ stdio: "ignore" },
);
child.unref();
const ready = setInterval(() => {
	if (!existsSync("descendant.pid")) return;
	clearInterval(ready);
	process.stdout.write("leaving " + child.pid + "\\n");
}, 10);`,
		);
		const result = await tool(root).run({ interpreter: "node", script: relative, outputs: ["descendant.pid"] });
		strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
		if (result.kind !== "ok") return;
		const pid = Number(readFileSync(join(root, "descendant.pid"), "utf8"));
		let state: "running" | "zombie" | "gone" = "running";
		for (let attempt = 0; attempt < 40; attempt += 1) {
			try {
				process.kill(pid, 0);
			} catch {
				state = "gone";
				break;
			}
			try {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z" ? "zombie" : "running";
			} catch {
				state = "gone";
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (state !== "gone") {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		strictEqual(state, "gone", `descendant ${pid} was reaped after the script ended`);
		deepStrictEqual(manifestOf(result).cleanup, { descendantsCleaned: true, incomplete: false });
		match(result.output, /they were sent SIGTERM, then SIGKILL$/mu);
	});
});

describe("run_script: refusals before anything runs", () => {
	it("refuses interpreters outside the allowlist and never creates a run record", async () => {
		const root = workspace();
		const relative = script(root, "a.js", "");
		for (const interpreter of ["/usr/bin/env", "python3.12", "perl5", "./node", "NODE", ""]) {
			const result = await tool(root).run({ interpreter, script: relative });
			strictEqual(result.kind, "error", interpreter);
			if (result.kind !== "error") continue;
			if (interpreter.length === 0) strictEqual(result.message, "run_script: missing interpreter argument");
			else ok(result.message.includes(RUN_SCRIPT_INTERPRETERS.join(", ")), result.message);
		}
		deepStrictEqual(runDirs(root), []);
	});

	it("refuses scripts outside the workspace, directly and through a symlink", async () => {
		const root = workspace();
		const outside = scratchOutside();
		writeFileSync(join(outside, "evil.js"), "");
		symlinkSync(join(outside, "evil.js"), join(root, "link.js"));
		mkdirSync(join(root, "sub"));
		symlinkSync(outside, join(root, "sub", "escape"));
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ interpreter: "node", script: join(outside, "evil.js") }, /resolves outside the workspace root/u],
			[{ interpreter: "node", script: "link.js" }, /resolves outside the workspace root/u],
			[{ interpreter: "node", script: "sub/escape/evil.js" }, /resolves outside the workspace root/u],
			[{ interpreter: "node", script: "../evil.js" }, /not found|outside the workspace root/u],
			[{ interpreter: "node", script: "missing.js" }, /script not found: missing\.js/u],
			[{ interpreter: "node", script: "sub" }, /not a regular file/u],
		];
		for (const [args, expected] of cases) {
			const result = await tool(root).run(args);
			strictEqual(result.kind, "error", JSON.stringify(args));
			if (result.kind === "error") match(result.message, expected);
		}
		deepStrictEqual(runDirs(root), []);
	});

	it("refuses escaping cwd, declared references, and malformed environment", async () => {
		const root = workspace();
		const outside = scratchOutside();
		const relative = script(root, "a.js", "");
		symlinkSync(outside, join(root, "escape"));
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ interpreter: "node", script: relative, cwd: ".." }, /cwd escapes the workspace root/u],
			[
				{ interpreter: "node", script: relative, cwd: "escape" },
				/cwd escapes the workspace root through a symbolic link/u,
			],
			[{ interpreter: "node", script: relative, cwd: "a.js" }, /cwd is not a directory/u],
			[{ interpreter: "node", script: relative, inputs: ["../x"] }, /inputs\[0\] escapes the workspace root/u],
			[
				{ interpreter: "node", script: relative, outputs: [join(outside, "y")] },
				/outputs\[0\] must be workspace-relative/u,
			],
			[{ interpreter: "node", script: relative, env: { "bad-key": "v" } }, /env key 'bad-key'/u],
			[{ interpreter: "node", script: relative, env: { OK: 1 } }, /env\.OK must be a string/u],
			[{ interpreter: "node", script: relative, timeout_ms: -1 }, /timeout_ms must be a positive integer/u],
		];
		for (const [args, expected] of cases) {
			const result = await tool(root).run(args);
			strictEqual(result.kind, "error", JSON.stringify(args));
			if (result.kind === "error") match(result.message, expected);
		}
		deepStrictEqual(runDirs(root), []);
	});

	it("accepts only whole-millisecond timeouts from 1 ms up and clamps at the maximum", async () => {
		const root = workspace();
		const relative = script(root, "t.js", "");
		for (const timeout_ms of [0.5, 0, 0.999, Number.NaN, Number.POSITIVE_INFINITY, "1000", 1.5]) {
			const result = await tool(root).run({ interpreter: "node", script: relative, timeout_ms });
			strictEqual(result.kind, "error", String(timeout_ms));
			if (result.kind === "error") match(result.message, /timeout_ms must be a positive integer number of milliseconds/u);
		}
		deepStrictEqual(runDirs(root), [], "refused timeouts never start a run");
		const shortest = await tool(root).run({ interpreter: "node", script: relative, timeout_ms: 1 });
		strictEqual(shortest.kind, "error", "one millisecond is a real limit, not no limit");
		if (shortest.kind === "error") {
			strictEqual(detailsOf(shortest).timedOut, true);
			strictEqual(manifestOf(shortest).timeoutMs, 1);
		}
		const clamped = await tool(root).run({
			interpreter: "node",
			script: relative,
			timeout_ms: RUN_SCRIPT_CAPS.maxTimeoutMs + 1,
		});
		strictEqual(clamped.kind, "ok");
		if (clamped.kind === "ok") strictEqual(manifestOf(clamped).timeoutMs, RUN_SCRIPT_CAPS.maxTimeoutMs);
	});
});

describe("run_script: argument normalization and safety projection", () => {
	it("accepts JSON-string and single-string array shapes", () => {
		deepStrictEqual(prepareRunScriptArguments({ args: '["a", "b"]', inputs: "one.txt", outputs: "", env: '{"K":"v"}' }), {
			args: ["a", "b"],
			inputs: ["one.txt"],
			outputs: [],
			env: { K: "v" },
		});
		const already = { args: ["x"], env: { A: "1" } };
		deepStrictEqual(prepareRunScriptArguments(already), already);
	});

	it("projects the run as one quoted shell command for the policy engine", () => {
		deepStrictEqual(runScriptSafetyProjection({ interpreter: "python3", script: "a b.py", args: ["x'y"], cwd: "sub" }), {
			command: "'python3' '-u' 'a b.py' 'x'\\''y'",
			cwd: "sub",
		});
		deepStrictEqual(runScriptSafetyProjection({ interpreter: "node", script: "run.js", interpreter_args: ["--check"] }), {
			command: "'node' '--check' 'run.js'",
		});
		deepStrictEqual(runScriptToolSurface.safetyCall?.({ interpreter: "node", script: "run.js" }), {
			tool: "bash",
			args: { command: "'node' 'run.js'" },
		});
		strictEqual(runScriptToolSurface.baseActionClass, "execute");
		strictEqual(runScriptToolSurface.executionMode, "sequential");
	});

	it("preserves empty arguments in the projection exactly as execution spawns them", async () => {
		deepStrictEqual(
			runScriptSafetyProjection({ interpreter: "node", script: "run.js", interpreter_args: [""], args: ["", "x", ""] }),
			{ command: "'node' '' 'run.js' '' 'x' ''" },
		);
		const root = workspace();
		const relative = script(root, "argv.js", "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
		const request = { interpreter: "node", script: relative, args: ["", "b", ""] };
		const result = await tool(root).run(request);
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		ok(result.output.includes('["","b",""]'), "the script received the empty arguments");
		const argv = manifestOf(result).argv;
		deepStrictEqual(argv.slice(2), ["", "b", ""]);
		const projected = projectedArgv(runScriptSafetyProjection(request).command);
		strictEqual(projected.length, argv.length, "the policy sees one entry per spawned argument");
		deepStrictEqual(projected.slice(2), argv.slice(2));
	});
});

describe("run_script: provenance hashing", () => {
	it("hashes with bounded asynchronous reads that keep the event loop turning", async () => {
		const root = workspace();
		const size = 32 * 1024 * 1024;
		const content = Buffer.alloc(size);
		for (let offset = 0; offset < size; offset += 4096) content.writeUInt32LE(offset, offset);
		writeFileSync(join(root, "big.bin"), content);
		const expected = createHash("sha256").update(content).digest("hex");
		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 1);
		const digest = await hashFile(join(root, "big.bin"));
		clearInterval(timer);
		strictEqual(digest, expected);
		ok(ticks >= 3, `timers fired while the file was being hashed: ${ticks} ticks`);
	});

	it("records an explicit omission instead of a hash when a file is too large or the scan is cancelled", async () => {
		const root = workspace();
		sparseFile(join(root, "huge.bin"), RUN_FILE_HASH_MAX_BYTES + 1);
		const huge = await captureFileRef(root, "huge.bin");
		deepStrictEqual(
			{ exists: huge.exists, bytes: huge.bytes, sha256: huge.sha256, hashOmitted: huge.hashOmitted },
			{ exists: true, bytes: RUN_FILE_HASH_MAX_BYTES + 1, sha256: null, hashOmitted: "too-large" },
		);
		const size = 32 * 1024 * 1024;
		writeFileSync(join(root, "medium.bin"), Buffer.alloc(size, 0x7a));
		const already = new AbortController();
		already.abort();
		const skipped = await captureFileRef(root, "medium.bin", { signal: already.signal });
		deepStrictEqual([skipped.sha256, skipped.hashOmitted, skipped.bytes], [null, "cancelled", size]);
		const midway = new AbortController();
		setTimeout(() => midway.abort(), 1);
		const interrupted = await captureFileRef(root, "medium.bin", { signal: midway.signal });
		deepStrictEqual([interrupted.sha256, interrupted.hashOmitted, interrupted.bytes], [null, "cancelled", size]);
		const complete = await captureFileRef(root, "medium.bin");
		strictEqual(complete.sha256, createHash("sha256").update(Buffer.alloc(size, 0x7a)).digest("hex"));
		strictEqual(complete.hashOmitted, undefined);
		const relative = script(root, "touch.js", "");
		const result = await tool(root).run({ interpreter: "node", script: relative, inputs: ["huge.bin"] });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const manifest = manifestOf(result);
		deepStrictEqual(
			[manifest.inputs[0]?.sha256, manifest.inputs[0]?.hashOmitted, manifest.inputs[0]?.bytes],
			[null, "too-large", RUN_FILE_HASH_MAX_BYTES + 1],
		);
		match(result.output, /^ {2}huge\.bin {2}present 67108865 bytes \(hash omitted: too-large\)$/mu);
	});
});

describe("run_script: python defaults and run record sweep", () => {
	it("records the default -u interpreter flag for python and honors explicit interpreter args", async (t) => {
		const root = workspace();
		if (findExecutableOnPath("python3") === null) {
			t.skip("python3 is not on PATH");
			return;
		}
		const relative = script(root, "p.py", 'import sys\nsys.stdout.write("py " + " ".join(sys.argv[1:]))\n');
		const result = await tool(root).run({ interpreter: "python3", script: relative, args: ["q"] });
		strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
		if (result.kind !== "ok") return;
		const manifest = manifestOf(result);
		deepStrictEqual(manifest.interpreter.args, ["-u"]);
		strictEqual(manifest.argv[1], "-u");
		ok(result.output.includes("py q"));
		const explicit = await tool(root).run({ interpreter: "python3", script: relative, interpreter_args: [] });
		strictEqual(explicit.kind, "ok");
		if (explicit.kind === "ok") deepStrictEqual(manifestOf(explicit).interpreter.args, []);
	});

	it("keeps only the newest completed run records after each run", async () => {
		const root = workspace();
		const relative = script(root, "n.js", "");
		const runs = runRecordsDir(root);
		mkdirSync(runs, { recursive: true });
		for (const [id, finishedAt] of [
			["20200101T000000Z-aaaaaa", "2020-01-01T00:00:00.000Z"],
			["20200102T000000Z-bbbbbb", "2020-01-02T00:00:00.000Z"],
			["20200103T000000Z-cccccc", "2020-01-03T00:00:00.000Z"],
		]) {
			mkdirSync(join(runs, id as string));
			writeFileSync(join(runs, id as string, "run.json"), JSON.stringify({ finishedAt }));
		}
		mkdirSync(join(runs, "not-a-run"));
		const result = await tool(root, { keepRuns: 2 }).run({ interpreter: "node", script: relative });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		const remaining = runDirs(root);
		strictEqual(remaining.length, 3, remaining.join(","));
		ok(remaining.includes("not-a-run"), "foreign entries are never removed");
		ok(remaining.includes("20200103T000000Z-cccccc"));
		ok(!remaining.includes("20200101T000000Z-aaaaaa"));
		ok(!remaining.includes("20200102T000000Z-bbbbbb"));
		deepStrictEqual(detailsOf(result).sweep, { removed: 2, kept: 2, active: 0, skipped: 1 });
		deepStrictEqual(sweepRunRecords(join(root, "nowhere")), { removed: 0, kept: 0, active: 0, skipped: 0 });
	});

	it("orders same-second runs by manifest completion and leaves in-flight runs alone", () => {
		const root = workspace();
		const runs = runRecordsDir(root);
		mkdirSync(runs, { recursive: true });
		// Two runs from the same second whose random suffixes sort against
		// their completion order; the later finisher must be the survivor.
		mkdirSync(join(runs, "20200101T000000Z-ffffff"));
		writeFileSync(join(runs, "20200101T000000Z-ffffff", "run.json"), '{"finishedAt":"2020-01-01T00:00:00.100Z"}');
		mkdirSync(join(runs, "20200101T000000Z-000000"));
		writeFileSync(join(runs, "20200101T000000Z-000000", "run.json"), '{"finishedAt":"2020-01-01T00:00:00.900Z"}');
		// A run in flight: no manifest yet, directory touched just now.
		mkdirSync(join(runs, "20200101T000000Z-aaaaaa"));
		writeFileSync(join(runs, "20200101T000000Z-aaaaaa", "stdout.log"), "");
		// A dead run: no manifest, untouched since long before any run could still be alive.
		mkdirSync(join(runs, "20190601T000000Z-bbbbbb"));
		const stale = new Date("2019-06-01T00:00:00Z");
		utimesSync(join(runs, "20190601T000000Z-bbbbbb"), stale, stale);
		deepStrictEqual(sweepRunRecords(root, { keep: 1 }), { removed: 2, kept: 1, active: 1, skipped: 0 });
		deepStrictEqual(runDirs(root), ["20200101T000000Z-000000", "20200101T000000Z-aaaaaa"]);
	});

	it("uses mtime for oversized and malformed manifests without allocating their contents", () => {
		const root = workspace();
		const runs = runRecordsDir(root);
		const ids = ["20200101T000000Z-aaaaaa", "20200101T000000Z-bbbbbb", "20200101T000000Z-cccccc"];
		for (const id of ids) mkdirSync(join(runs, id), { recursive: true });
		const huge = join(runs, ids[0] as string, "run.json");
		const fd = openSync(huge, "w");
		try {
			ftruncateSync(fd, 1024 * 1024 * 1024);
		} finally {
			closeSync(fd);
		}
		const old = new Date("2020-01-01");
		utimesSync(huge, old, old);
		const malformed = join(runs, ids[1] as string, "run.json");
		writeFileSync(malformed, "null");
		utimesSync(malformed, old, old);
		writeFileSync(join(runs, ids[2] as string, "run.json"), '{"finishedAt":"2021-01-01"}');
		const rss = process.memoryUsage().rss;
		deepStrictEqual(sweepRunRecords(root, { keep: 1 }), { removed: 2, kept: 1, active: 0, skipped: 0 });
		ok(process.memoryUsage().rss - rss < 32 * 1024 * 1024, "a 1 GiB sparse manifest is not read into memory");
		deepStrictEqual(runDirs(root), [ids[2]]);
	});

	it("skips FIFO, directory, and symlink manifests without blocking or following targets", (t) => {
		if (process.platform === "win32") return t.skip("FIFO fixture requires POSIX");
		const root = workspace();
		const runs = runRecordsDir(root);
		const ids = ["20200101T000000Z-aaaaaa", "20200101T000000Z-bbbbbb", "20200101T000000Z-cccccc"];
		for (const id of ids) mkdirSync(join(runs, id), { recursive: true });
		const fifo = join(runs, ids[0] as string, "run.json");
		strictEqual(spawnSync("mkfifo", [fifo]).status, 0);
		mkdirSync(join(runs, ids[1] as string, "run.json"));
		const target = join(root, "target.json");
		writeFileSync(target, '{"finishedAt":"2000-01-01"}');
		symlinkSync(target, join(runs, ids[2] as string, "run.json"));
		const probe = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				'import { sweepRunRecords } from "./src/core/run-records.ts"; console.log(JSON.stringify(sweepRunRecords(process.argv[1], {keep:0})));',
				root,
			],
			{ cwd: process.cwd(), timeout: 5000, encoding: "utf8" },
		);
		strictEqual(probe.status, 0, probe.error?.message ?? probe.stderr);
		deepStrictEqual(JSON.parse(probe.stdout), { removed: 0, kept: 0, active: 0, skipped: 3 });
		deepStrictEqual(runDirs(root), ids);
		strictEqual(readFileSync(target, "utf8"), '{"finishedAt":"2000-01-01"}');
	});

	it("never sweeps a run that is still in flight when an overlapping run completes first", async () => {
		const root = workspace();
		const slow = script(root, "slow.js", 'setTimeout(() => process.stdout.write("slow done"), 600)');
		const fast = script(root, "fast.js", 'process.stdout.write("fast done")');
		const runner = tool(root, { keepRuns: 1 });
		const slowRun = runner.run({ interpreter: "node", script: slow });
		await new Promise((resolve) => setTimeout(resolve, 150));
		const fastResult = await runner.run({ interpreter: "node", script: fast });
		strictEqual(fastResult.kind, "ok", fastResult.kind === "error" ? fastResult.message : "");
		deepStrictEqual(detailsOf(fastResult).sweep, { removed: 0, kept: 1, active: 1, skipped: 0 });
		const slowResult = await slowRun;
		strictEqual(slowResult.kind, "ok", slowResult.kind === "error" ? slowResult.message : "");
		const slowDetails = detailsOf(slowResult);
		deepStrictEqual(slowDetails.sweep, { removed: 1, kept: 1, active: 0, skipped: 0 });
		deepStrictEqual(runDirs(root), [slowDetails.runId], "the earlier finisher was swept, the later one kept");
		strictEqual(manifestOf(slowResult).outcome, "succeeded");
		strictEqual(readFileSync(slowDetails.stdoutPath as string, "utf8"), "slow done");
	});
});

describe("run_script: live progress", () => {
	it("throttles snapshots deterministically and separates the two stream tails", () => {
		const scheduler = new DeterministicScheduler();
		const updates: ToolResult[] = [];
		const progress = createRunScriptProgressController({
			onUpdate: (partial) => updates.push(partial),
			label: "node demo.js",
			scheduler,
			throttleMs: 250,
			tailBytes: 8,
		});
		progress.start();
		strictEqual(updates.length, 1, "start publishes the initial snapshot");
		match(
			(updates[0] as { output: string }).output,
			/^run_script: running node demo\.js \(0ms elapsed\)\nstdout: 0 bytes \| stderr: 0 bytes\n--- stdout tail ---\n\(no output yet\)\n--- stderr tail ---\n\(no output yet\)$/u,
		);
		progress.append("stdout", Buffer.from("0123456789"));
		progress.append("stderr", Buffer.from("err"));
		strictEqual(updates.length, 1, "appends inside the throttle window coalesce");
		scheduler.advanceTo(100);
		strictEqual(updates.length, 1);
		scheduler.advanceTo(250);
		strictEqual(updates.length, 2, "the timer publishes once the window elapses");
		const second = updates[1] as { output: string; details?: Record<string, unknown> };
		ok(second.output.includes("stdout: 10 bytes | stderr: 3 bytes"));
		ok(second.output.includes("--- stdout tail ---\n[... 2 bytes omitted ...]\n23456789\n--- stderr tail ---\nerr"));
		deepStrictEqual(second.details?.progress, { elapsedMs: 250, stdoutBytes: 10, stderrBytes: 3 });
		scheduler.advanceTo(600);
		progress.append("stdout", Buffer.from("!"));
		strictEqual(updates.length, 3, "an append past the window publishes immediately");
		progress.settle();
		strictEqual(updates.length, 3, "settle with nothing pending publishes nothing");
		progress.append("stderr", Buffer.from("late"));
		scheduler.advanceTo(2000);
		strictEqual(updates.length, 3, "a settled controller ignores late output");
	});

	it("publishes settle-time output that arrived inside the window", () => {
		const scheduler = new DeterministicScheduler();
		const updates: ToolResult[] = [];
		const progress = createRunScriptProgressController({
			onUpdate: (partial) => updates.push(partial),
			label: "node demo.js",
			scheduler,
		});
		progress.start();
		progress.append("stdout", Buffer.from("final"));
		progress.settle();
		strictEqual(updates.length, 2);
		ok((updates[1] as { output: string }).output.includes("--- stdout tail ---\nfinal"));
		scheduler.advanceTo(10_000);
		strictEqual(updates.length, 2, "the cleared timer never fires after settle");
	});

	it("delivers at least one live snapshot from a real child", async () => {
		const root = workspace();
		const relative = script(
			root,
			"chatty.js",
			'for (let i = 0; i < 50; i += 1) process.stdout.write("row " + i + "\\n");',
		);
		const updates: ToolResult[] = [];
		const result = await tool(root).run({ interpreter: "node", script: relative }, { onUpdate: (p) => updates.push(p) });
		strictEqual(result.kind, "ok");
		ok(updates.length >= 1);
		for (const update of updates) {
			strictEqual(update.kind, "ok");
			if (update.kind === "ok") match(update.output, /^run_script: running node chatty\.js \(/u);
		}
	});
});
