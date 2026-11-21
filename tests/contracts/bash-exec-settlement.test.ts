import { deepStrictEqual, doesNotThrow, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type BashCommandProgress,
	type BashProgressScheduler,
	createBashOutputProgressController,
	killLiveCommandGroups,
	runBashCommand,
} from "../../src/core/bash-exec.js";
import { bashShellEnvironment, POSIX_BASH, resolveBashShell } from "../../src/core/bash-shell.js";
import { runCommandVector } from "../../src/core/safe-exec.js";
import { setRunDeadline } from "../../src/core/termination-phase.js";
import { bashTool } from "../../src/tools/bash.js";

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
describe("bash abort settlement (#445)", () => {
	const abortedRun = async (abortCause?: () => string | null) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		return bashTool.run(
			{ command: "sleep 30", timeout_ms: 3_600_000 },
			{ signal: controller.signal, ...(abortCause === undefined ? {} : { abortCause }) },
		);
	};

	it("names the host's stop reason and the unspent timeout", async () => {
		const result = await abortedRun(() => "Scheduled job occurrence ended: execution timeout.");
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		match(result.message, /bash: command aborted after \d+s of its 1h time limit/u);
		match(result.message, /The host ended the run: Scheduled job occurrence ended: execution timeout\./u);
		strictEqual(result.details?.outcome, "abort");
		strictEqual(result.details?.abortCause, "Scheduled job occurrence ended: execution timeout.");
	});

	it("says so when the host recorded no cause", async () => {
		const result = await abortedRun();
		strictEqual(result.kind, "error");
		if (result.kind !== "error") return;
		match(result.message, /The host ended the run and recorded no cause\./u);
		strictEqual(result.details?.abortCause, null);
	});

	it("clamps timeout_ms to the run's remaining --timeout (XR-12)", async () => {
		setRunDeadline(performance.now() + 300);
		try {
			const result = await bashTool.run({ command: "sleep 3", timeout_ms: 604_800_000 }, {});
			strictEqual(result.kind, "error");
			if (result.kind !== "error") return;
			strictEqual(result.details?.outcome, "timeout");
			match(result.message, /run's --timeout/u);
			// The executor arms its timer against the deadline itself, after spawn preparation, and names the limit it armed.
			const raw = await runBashCommand("sleep 3", { timeoutMs: 604_800_000, deadlineAt: performance.now() + 300 });
			strictEqual(raw.timedOut, true);
			strictEqual(raw.timeoutLimit?.by, "run-deadline");
			const own = await runBashCommand("sleep 3", { timeoutMs: 200, deadlineAt: performance.now() + 600_000 });
			strictEqual(own.timeoutLimit?.by, "timeout");
		} finally {
			setRunDeadline(null);
		}
		// A deadline already passed before spawn starts no command.
		const dir = mkdtempSync(join(tmpdir(), "clio-coder-bash-expired-"));
		const marker = join(dir, "ran");
		try {
			const raw = await runBashCommand(`touch '${marker}'`, { timeoutMs: 60_000, deadlineAt: performance.now() - 1 });
			strictEqual(raw.timedOut, true);
			deepStrictEqual(raw.timeoutLimit, { by: "run-deadline", ms: 0 });
			setRunDeadline(performance.now() - 1);
			const result = await bashTool.run({ command: `touch '${marker}'` }, {});
			strictEqual(result.kind, "error");
			if (result.kind === "error") {
				match(result.message, /before this command started, so it did not run/u);
				// It never ran, so it neither printed nothing nor leaves a next call to run in this run.
				ok(!/printed nothing|next call runs normally/u.test(result.message), result.message);
			}
			strictEqual(existsSync(marker), false);
		} finally {
			setRunDeadline(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// The run's --timeout aborts the run at the instant the command's deadline timer fires; whichever lands first, the
	// result names the deadline, never "recorded no cause" or a time span past its own limit (wave-10 live result).
	it("names the run's --timeout deadline when the run's abort and the deadline race on a spawned command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-coder-bash-deadline-"));
		const marker = join(dir, "started");
		const controller = new AbortController();
		const deadlineAt = performance.now() + 1_000;
		setRunDeadline(deadlineAt);
		// The run's shutdown abort, armed before the command's timer as `--timeout` arms its timer at boot.
		setTimeout(() => controller.abort(), Math.ceil(deadlineAt - performance.now()));
		try {
			const result = await bashTool.run(
				{ command: `touch '${marker}'; sleep 30`, timeout_ms: 604_800_000 },
				{ signal: controller.signal },
			);
			strictEqual(existsSync(marker), true, "the child never spawned");
			strictEqual(result.kind, "error");
			if (result.kind !== "error") return;
			strictEqual(result.details?.outcome, "timeout");
			match(result.message, /stopped at the run's --timeout deadline \(\d+ s\)/u);
			ok(!/recorded no cause|aborted after|next call runs normally/u.test(result.message), result.message);
		} finally {
			setRunDeadline(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const hasSetsid = process.platform !== "win32" && spawnSync("setsid", ["--version"]).status === 0;
	it("settles an abort when a descendant outside the group keeps the pipes", { skip: !hasSetsid }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-coder-bash-holder-"));
		const pidFile = join(dir, "holder.pid");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const settled = await Promise.race([
			runBashCommand(`echo kept; setsid sleep 60 & echo $! > ${pidFile}; sleep 60`, {
				timeoutMs: 3_600_000,
				signal: controller.signal,
			}),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000).unref()),
		]);
		try {
			ok(settled !== null, "the abort never settled while the descendant held the pipes");
			strictEqual(settled.aborted, true);
			strictEqual(settled.stdout, "kept\n");
		} finally {
			try {
				process.kill(Number(readFileSync(pidFile, "utf8")));
			} catch {
				// The holder already exited, which leaves nothing to clean up.
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// FX-32: a hung command held a lane for minutes with no output; safety.limits.bashIdleSeconds (off by default) ends it.
	it("stops a silent, CPU-idle command as a typed idle timeout and spares one that keeps the CPU busy", async () => {
		const idle = await bashTool.run({ command: "echo started; sleep 30", timeout_ms: 3_600_000 }, { bashIdleMs: 400 });
		strictEqual(idle.kind, "error");
		if (idle.kind !== "error") return;
		strictEqual(idle.details?.outcome, "timeout");
		strictEqual(idle.details?.timedOut, true);
		strictEqual(idle.details?.timedOutBy, "idle");
		match(
			idle.message,
			/started[\s\S]*stopped as idle \(safety\.limits\.bashIdleSeconds\)[\s\S]*next call runs normally/u,
		);
		if (process.platform !== "linux") return;
		// Silent for five idle windows, but busy: CPU in the process tree counts as activity.
		const busy = await bashTool.run(
			{ command: "end=$((SECONDS+2)); while [ $SECONDS -lt $end ]; do :; done; echo done" },
			{ bashIdleMs: 400 },
		);
		strictEqual(busy.kind, "ok", busy.kind === "error" ? busy.message : "");
		// The shell leaves a silent, busy child holding stdout and exits: once the shell is reaped the child still counts.
		const orphan = await bashTool.run(
			{ command: "(end=$((SECONDS+2)); while [ $SECONDS -lt $end ]; do :; done; echo done) & exit 0" },
			{ bashIdleMs: 400 },
		);
		strictEqual(orphan.kind, "ok", orphan.kind === "error" ? orphan.message : "");
		match(JSON.stringify(orphan), /done/u);
	});
});

describe("worker cancel stops running commands", () => {
	it("kills a command group that ignores SIGTERM, which would outlive a cancelled worker", async () => {
		const controller = new AbortController();
		let spawned!: () => void;
		const started = new Promise<void>((resolve) => {
			spawned = resolve;
		});
		const run = runBashCommand(`trap "" TERM; echo up; sleep 30`, {
			timeoutMs: 3_600_000,
			signal: controller.signal,
			onUpdate: () => spawned(),
		});
		await started;
		controller.abort();
		killLiveCommandGroups();
		const settled = await Promise.race([run, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000))]);
		ok(settled !== null, "the command outlived the kill");
	});
});

// M-12: a tool command that inherited the TUI's terminal or its pane host's coordinates typed into the composer and
// hung the TUI up. Each command leads a session of its own with none of them, and a timeout still stops its whole tree.
describe("tool commands never reach the TUI's terminal (M-12)", { skip: process.platform === "win32" }, () => {
	it("runs bash and safe-exec children without a controlling terminal or the host's pane coordinates", async () => {
		const host: Record<string, string> = {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: "/run/user/0/clio-coder/clio-coder-000000000000.sock",
			HERDR_PANE_ID: "w1:p1",
			TMUX: "/tmp/tmux-0/default,1,0",
			TMUX_PANE: "%0",
			GPG_TTY: "/dev/pts/0",
		};
		const saved = new Map(Object.keys(host).map((key) => [key, process.env[key]]));
		Object.assign(process.env, host);
		const probe = [
			'printf "env=%s|%s|%s|%s|%s|%s\\n" "${HERDR_ENV-}" "${HERDR_SOCKET_PATH-}" "${HERDR_PANE_ID-}" "${TMUX-}" "${TMUX_PANE-}" "${GPG_TTY-}"',
			'printf "tmux=%s\\n" "${TMUX_TMPDIR-}"',
			'printf "sid=%s pid=%s\\n" "$(ps -o sid= -p $$ | tr -d " ")" "$$"',
			"if (exec 3<>/dev/tty) 2>/dev/null; then echo tty=open; else echo tty=none; fi",
		].join("; ");
		const dir = mkdtempSync(join(tmpdir(), "clio-coder-bash-tree-"));
		const pidFile = join(dir, "child.pid");
		try {
			const bash = await runBashCommand(probe, { timeoutMs: 30_000 });
			const vector = await runCommandVector("/bin/sh", ["-c", probe], { baseEnv: { ...process.env }, timeoutMs: 30_000 });
			for (const out of [bash.stdout, vector.stdout]) {
				match(out, /^env=\|\|\|\|\|$/mu);
				match(out, /^tmux=\S*clio-coder-tool-tmux-/mu);
				const ids = /^sid=(\d+) pid=(\d+)$/mu.exec(out);
				ok(ids !== null && ids[1] === ids[2], `the command leads its own session: ${out}`);
				match(out, /^tty=none$/mu);
			}
			// What needs a terminal fails with the reason, instead of reaching the TUI's.
			const hinted = await bashTool.run({ command: "printf x > /dev/tty" }, {});
			strictEqual(hinted.kind, "error");
			if (hinted.kind === "error") match(hinted.message, /needed a terminal[\s\S]*cannot reach the TUI's terminal/u);
			// A timeout signals the command's group, so a background child dies with the shell.
			const stopped = await runBashCommand(`sleep 60 & echo $! > '${pidFile}'; wait`, { timeoutMs: 300 });
			strictEqual(stopped.timedOut, true);
			const pid = Number(readFileSync(pidFile, "utf8"));
			const running = (): boolean => {
				try {
					process.kill(pid, 0);
				} catch {
					return false;
				}
				if (process.platform !== "linux") return true;
				try {
					const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
					return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
				} catch {
					return false;
				}
			};
			for (let attempt = 0; attempt < 80 && running(); attempt += 1) await new Promise((r) => setTimeout(r, 25));
			ok(!running(), `background child ${pid} outlived the timeout`);
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) Reflect.deleteProperty(process.env, key);
				else process.env[key] = value;
			}
			if (existsSync(pidFile)) {
				try {
					process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

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

	it("runs Git for Windows' usr\\bin bash with the wrapper's tool directories so the git shim stays first", () => {
		const usrBash = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";
		const ucrtGit = "C:\\Program Files\\Git\\ucrt64\\bin\\git.exe";
		const env = { Path: "C:\\Program Files\\Git\\bin;C:\\Windows", ProgramFiles: "C:\\Program Files", msystem: "MSYS" };
		const files = [gitBash, usrBash, ucrtGit];
		strictEqual(windows(env, files), usrBash);
		const host = { platform: "win32" as const, env, isFile: (file: string) => files.includes(file) };
		deepStrictEqual(bashShellEnvironment(usrBash, env, host), {
			Path: "C:\\Program Files\\Git\\ucrt64\\bin;C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\bin;C:\\Windows",
			ProgramFiles: "C:\\Program Files",
			MSYSTEM: "UCRT64",
		});
		strictEqual(bashShellEnvironment(gitBash, env, host), env);
	});

	it("reports none when only the WSL launcher exists", () => {
		strictEqual(windows({ PATH: "C:\\Windows\\System32" }, ["C:\\Windows\\System32\\bash.exe"]), null);
	});
});
