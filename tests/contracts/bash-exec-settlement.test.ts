import { deepStrictEqual, doesNotThrow, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type BashCommandProgress,
	type BashProgressScheduler,
	createBashOutputProgressController,
} from "../../src/core/bash-exec.js";
import { POSIX_BASH, resolveBashShell } from "../../src/core/bash-shell.js";

class DeterministicScheduler implements BashProgressScheduler {
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

	forceInvoke(id: number): void {
		const job = this.jobs.get(id);
		if (job === undefined) throw new Error(`unknown timer ${id}`);
		this.jobs.delete(id);
		job.callback();
	}
}

describe("bash output settlement", () => {
	it("publishes cumulative stdout/stderr snapshots", () => {
		const scheduler = new DeterministicScheduler();
		const updates: BashCommandProgress[] = [];
		const output = createBashOutputProgressController((progress) => updates.push(progress), scheduler);

		output.start();
		output.append("stdout", Buffer.from("one"));
		scheduler.advanceTo(100);
		output.append("stdout", Buffer.from(" two"));
		output.append("stderr", Buffer.from("warn"));
		scheduler.advanceTo(200);
		const result = output.settle();

		deepStrictEqual(updates, [
			{ stdout: "", stderr: "", outputBytes: 0 },
			{ stdout: "one", stderr: "", outputBytes: 3 },
			{ stdout: "one two", stderr: "warn", outputBytes: 11 },
		]);
		deepStrictEqual(result, {
			stdout: "one two",
			stderr: "warn",
			outputBytes: 11,
			outputCapped: false,
		});
	});

	it("rejects late output and makes an already-queued timer inert after settlement", () => {
		const scheduler = new DeterministicScheduler();
		const updates: BashCommandProgress[] = [];
		const output = createBashOutputProgressController((progress) => updates.push(progress), scheduler);

		output.start();
		output.append("stdout", Buffer.from("final"));
		const timerId = [...scheduler.jobs.keys()][0];
		if (timerId === undefined) throw new Error("expected throttled progress timer");
		const result = output.settle();
		const updateCountAtSettlement = updates.length;

		strictEqual(output.append("stderr", Buffer.from("late")), false);
		// Simulate the event loop having queued the callback just before clearTimeout.
		scheduler.forceInvoke(timerId);

		deepStrictEqual(result, {
			stdout: "final",
			stderr: "",
			outputBytes: 5,
			outputCapped: false,
		});
		strictEqual(updates.length, updateCountAtSettlement);
		deepStrictEqual(updates.at(-1), { stdout: "final", stderr: "", outputBytes: 5 });
	});

	it("keeps progress callback failures advisory", () => {
		const scheduler = new DeterministicScheduler();
		const output = createBashOutputProgressController(() => {
			throw new Error("renderer failed");
		}, scheduler);

		doesNotThrow(() => {
			output.start();
			output.append("stdout", Buffer.from("kept"));
			output.settle();
		});
		deepStrictEqual(output.settle(), {
			stdout: "kept",
			stderr: "",
			outputBytes: 4,
			outputCapped: false,
		});
	});
});

// #421: Windows has no /bin/bash, so the bash tool resolves Git Bash or reports none.
describe("bash shell resolution", () => {
	const windows = (env: NodeJS.ProcessEnv, files: string[]) =>
		resolveBashShell({ platform: "win32", env, isFile: (file) => files.includes(file) });
	const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";

	it("keeps /bin/bash on POSIX hosts", () => {
		strictEqual(resolveBashShell({ platform: "linux", env: {}, isFile: () => false }), POSIX_BASH);
	});

	it("skips the WSL launcher on PATH and picks Git Bash", () => {
		const env = {
			Path: "C:\\Windows\\system32;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;C:\\tools\\git\\usr\\bin",
			SystemRoot: "C:\\Windows",
			ProgramFiles: "C:\\Program Files",
		};
		const launchers = [
			"C:\\Windows\\system32\\bash.exe",
			"C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
		];
		strictEqual(windows(env, [...launchers, gitBash]), gitBash);
		strictEqual(
			windows(env, [...launchers, "C:\\tools\\git\\usr\\bin\\bash.exe", gitBash]),
			"C:\\tools\\git\\usr\\bin\\bash.exe",
		);
	});

	it("reports none when only the WSL launcher exists", () => {
		strictEqual(windows({ PATH: "C:\\Windows\\System32" }, ["C:\\Windows\\System32\\bash.exe"]), null);
	});
});
