import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";
import { makeScratchHome } from "../harness/scratch-env.js";

// The Stage 0 shell must answer the terminal while Stage 1 hydrates. Boot turns
// the event loop between its phases, so keystrokes, submits, Ctrl+C, resize and
// signals reach the process before the hydrated frame rather than after it.
// These drive the built CLI in a real pseudo-terminal from the first painted
// frame and hold each path to the lease contract: no keystroke lost or
// reordered across the handoff, a submit accepted before hydration admitted
// once and in order, an interrupted boot restoring the terminal once.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "dist", "cli", "index.js");
const CTRL_C = "\x03";
/** The editor placeholder. Both stages paint it; Stage 0 is live once it appears. */
const EDITOR = "Ask Clio";
/** The hydrated footer's idle status. Stage 0 paints no footer. */
const HYDRATED = /\bReady\b/u;
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
const CURSOR_SHOWN = "\x1b[?25h";
/** Typed across the handoff. No character opens a completion or a command mode. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

let endpoint = "";
const server = createServer((request, response) => {
	response.setHeader("content-type", "application/json");
	if (request.url === "/v1/models") response.end(JSON.stringify({ data: [{ id: "handoff-model" }] }));
	else if (request.url === "/lmstudio-greeting") response.end(JSON.stringify({ lmstudio: true }));
	else {
		response.statusCode = 404;
		response.end("{}");
	}
});

before(async () => {
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server.close();
});

interface Fixture {
	readonly home: string;
	readonly project: string;
	readonly renderTrace: string;
	readonly env: NodeJS.ProcessEnv;
	cleanup(): void;
}

function fixture(extra: NodeJS.ProcessEnv = {}): Fixture {
	const home = makeScratchHome("clio-coder-boot-handoff-");
	const project = mkdtempSync(join(tmpdir(), "clio-coder-boot-handoff-project-"));
	mkdirSync(join(home.dir, "config"), { recursive: true });
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		`version: 2
targets:
  - id: handoff-local
    runtime: lmstudio
    url: ${endpoint}
    defaultModel: handoff-model
    lifecycle: user-managed
chat:
  target: handoff-local
  model: handoff-model
interface:
  panes:
    enabled: off
`,
	);
	const renderTrace = join(home.dir, "render.jsonl");
	return {
		home: home.dir,
		project,
		renderTrace,
		env: {
			...process.env,
			...home.env,
			HOME: home.dir,
			TERM: "xterm-256color",
			CLIO_CODER_INTERACTIVE: "1",
			CLIO_CODER_INSTANT_SHELL: "1",
			CLIO_CODER_TRACE_BOOT: "1",
			CLIO_CODER_RENDER_TRACE: renderTrace,
			...extra,
		},
		cleanup() {
			home.cleanup();
			rmSync(project, { recursive: true, force: true });
		},
	};
}

interface Terminal {
	readonly pid: number;
	/** Every byte the terminal received, escape sequences included. */
	raw(): string;
	/** The received stream with escape sequences removed. */
	visible(): string;
	write(data: string): void;
	resize(columns: number, rows: number): void;
	/** Resolves with the visible offset where `cue` first appears at or after `from`. */
	waitFor(cue: string | RegExp, options?: { from?: number; timeoutMs?: number }): Promise<number>;
	exited(timeoutMs?: number): Promise<number>;
	kill(): void;
}

function launch(env: NodeJS.ProcessEnv, cwd: string): Terminal {
	const child = spawn(process.execPath, [CLI], { cols: 100, rows: 30, cwd, env, name: "xterm-256color" });
	let raw = "";
	let exitCode: number | null = null;
	child.onData((data) => {
		raw += data;
	});
	const exit = new Promise<number>((settle) =>
		child.onExit((event) => {
			exitCode = event.exitCode;
			settle(event.exitCode);
		}),
	);
	const visible = () => stripVTControlCharacters(raw);
	const find = (cue: string | RegExp, from: number): number => {
		const text = visible();
		if (typeof cue === "string") return text.indexOf(cue, from);
		const match = new RegExp(cue.source, cue.flags.includes("g") ? cue.flags : `${cue.flags}g`);
		match.lastIndex = from;
		return match.exec(text)?.index ?? -1;
	};
	return {
		pid: child.pid,
		raw: () => raw,
		visible,
		write: (data) => child.write(data),
		resize: (columns, rows) => child.resize(columns, rows),
		async waitFor(cue, options = {}) {
			const deadline = Date.now() + (options.timeoutMs ?? 20_000);
			for (;;) {
				const index = find(cue, options.from ?? 0);
				if (index >= 0) return index;
				ok(exitCode === null, `exited ${exitCode} before ${String(cue)}:\n${visible().slice(-2_000)}`);
				ok(Date.now() < deadline, `timed out waiting for ${String(cue)}:\n${visible().slice(-2_000)}`);
				await new Promise((settle) => setTimeout(settle, 5));
			}
		},
		async exited(timeoutMs = 15_000) {
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`no exit within ${timeoutMs}ms:\n${visible().slice(-2_000)}`)),
					timeoutMs,
				);
			});
			try {
				return await Promise.race([exit, timeout]);
			} finally {
				clearTimeout(timer);
			}
		},
		kill() {
			if (exitCode === null) child.kill("SIGKILL");
		},
	};
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

/** One boot trace phase, in milliseconds since the child process started. */
function bootTrace(output: string, phase: string): { at: number; detail: string | undefined } | undefined {
	const match = stripVTControlCharacters(output).match(
		new RegExp(`\\[clio-coder:boot\\] \\+([\\d.]+)ms ${phase}(?: \\(([^)]*)\\))?`, "u"),
	);
	return match ? { at: Number(match[1]), detail: match[2] } : undefined;
}

/** The terminal is handed back once: raw input, bracketed paste and the cursor. */
function assertRestoredOnce(output: string): void {
	strictEqual(occurrences(output, BRACKETED_PASTE_OFF), 1, "bracketed paste restores once");
	strictEqual(occurrences(output, CURSOR_SHOWN), 1, "the cursor restores once");
}

function assertNoFailure(output: string): void {
	const visible = stripVTControlCharacters(output);
	ok(!/^error:/mu.test(visible), `boot reported an error:\n${visible.slice(-2_000)}`);
	ok(!/terminal shutdown failed|cleanup also failed|submission failed/u.test(visible), visible.slice(-2_000));
}

/** Local bash runs persisted by any session under `root`, in file order. */
function persistedBashCommands(root: string): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				for (const line of readFileSync(path, "utf8").split("\n")) {
					try {
						const parsed = JSON.parse(line) as { kind?: unknown; command?: unknown };
						if (parsed.kind === "bashExecution" && typeof parsed.command === "string") found.push(parsed.command);
					} catch {
						// A writer may be mid-line while this polls.
					}
				}
			}
		}
	};
	visit(root);
	return found;
}

async function waitForBashCommands(root: string, count: number): Promise<string[]> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		const commands = persistedBashCommands(root).filter((command) => command.startsWith("printf admitted-"));
		if (commands.length >= count) return commands;
		ok(Date.now() < deadline, `only ${commands.length} of ${count} admitted commands persisted`);
		await new Promise((settle) => setTimeout(settle, 20));
	}
}

interface FrameRecord {
	type: string;
	frameId: number;
	columns: number;
	rows: number;
}

function committedFrames(tracePath: string): FrameRecord[] {
	if (!existsSync(tracePath)) return [];
	return readFileSync(tracePath, "utf8")
		.split("\n")
		.flatMap((line) => {
			try {
				const record = JSON.parse(line) as FrameRecord;
				return record.type === "frame" ? [record] : [];
			} catch {
				return [];
			}
		});
}

describe("boot handoff through a real terminal", { concurrency: false, skip: process.platform === "win32" }, () => {
	it("keeps every keystroke typed across the Stage 0 to Stage 1 handoff, in order", async () => {
		const scratch = fixture();
		const terminal = launch(scratch.env, scratch.project);
		const spawnedAt = performance.now();
		let typed = "";
		const typedAt: number[] = [];
		try {
			await terminal.waitFor(EDITOR);
			let hydratedAt: number | null = null;
			// Type from the first painted frame until the hydrated footer has been
			// on screen for a while, so the keys straddle the delegate swap.
			while (hydratedAt === null || performance.now() - hydratedAt < 400) {
				const key = ALPHABET[typed.length % ALPHABET.length] as string;
				typedAt.push(performance.now() - spawnedAt);
				terminal.write(key);
				typed += key;
				await new Promise((settle) => setTimeout(settle, 15));
				if (hydratedAt === null && HYDRATED.test(terminal.visible())) hydratedAt = performance.now();
				ok(typed.length < 2_000, "the hydrated footer never appeared");
			}
			await new Promise((settle) => setTimeout(settle, 300));
			process.kill(terminal.pid, "SIGTERM");
			strictEqual(await terminal.exited(), 143, terminal.visible().slice(-2_000));
			const output = terminal.raw();
			const hydration = bootTrace(output, "Stage 1 hydration");
			ok(hydration, "the boot trace names the hydrated frame");
			ok(
				(typedAt[0] as number) < hydration.at && (typedAt.at(-1) as number) > hydration.at,
				`typing spans hydration: ${typedAt[0]?.toFixed(0)}..${typedAt.at(-1)?.toFixed(0)}ms around ${hydration.at}ms`,
			);
			const recovered = stripVTControlCharacters(output).match(/^\[draft\] (.*)$/mu)?.[1];
			strictEqual(recovered, typed, "the recovered draft is every key, once, in typing order");
			assertRestoredOnce(output);
			assertNoFailure(output);
		} finally {
			terminal.kill();
			scratch.cleanup();
		}
	});

	it("queues submits accepted before hydration and admits each once, in order", async () => {
		const scratch = fixture();
		const terminal = launch(scratch.env, scratch.project);
		try {
			await terminal.waitFor(EDITOR);
			terminal.write("!! printf admitted-one\r!! printf admitted-two\r");
			const hydrated = await terminal.waitFor(HYDRATED);
			const first = await terminal.waitFor("queued !! printf admitted-one");
			const second = await terminal.waitFor("queued !! printf admitted-two");
			ok(first < hydrated && second < hydrated, "Stage 0 queued both submits before the hydrated frame");
			deepStrictEqual(
				await waitForBashCommands(scratch.home, 2),
				["printf admitted-one", "printf admitted-two"],
				"each queued submit ran and persisted exactly once, in submission order",
			);
			process.kill(terminal.pid, "SIGTERM");
			strictEqual(await terminal.exited(), 143, terminal.visible().slice(-2_000));
			deepStrictEqual(
				persistedBashCommands(scratch.home).filter((command) => command.startsWith("printf admitted-")),
				["printf admitted-one", "printf admitted-two"],
			);
			assertRestoredOnce(terminal.raw());
			assertNoFailure(terminal.raw());
		} finally {
			terminal.kill();
			scratch.cleanup();
		}
	});

	it("exits cleanly on a double Ctrl+C before hydration", async () => {
		const scratch = fixture();
		const terminal = launch(scratch.env, scratch.project);
		try {
			await terminal.waitFor(EDITOR);
			terminal.write(CTRL_C);
			await new Promise((settle) => setTimeout(settle, 30));
			terminal.write(CTRL_C);
			strictEqual(await terminal.exited(), 0, terminal.visible().slice(-2_000));
			const output = terminal.raw();
			ok(bootTrace(output, "Stage 0 shell commit"), "Stage 0 painted");
			strictEqual(bootTrace(output, "Stage 1 hydration"), undefined, "boot stopped before hydrating");
			assertRestoredOnce(output);
			assertNoFailure(output);
		} finally {
			terminal.kill();
			scratch.cleanup();
		}
	});

	it("recovers the Stage 0 draft when SIGTERM arrives mid-boot", async () => {
		const scratch = fixture();
		const terminal = launch(scratch.env, scratch.project);
		try {
			const painted = await terminal.waitFor(EDITOR);
			terminal.write("sigterm-draft");
			// The echo proves the loop turned inside boot; the signal lands at a
			// later phase boundary, before the hydrated frame.
			await terminal.waitFor("sigterm-draft", { from: painted });
			ok(!HYDRATED.test(terminal.visible()), "Stage 0 echoed the draft before the hydrated frame");
			process.kill(terminal.pid, "SIGTERM");
			strictEqual(await terminal.exited(10_000), 143, terminal.visible().slice(-2_000));
			const output = terminal.raw();
			const visible = stripVTControlCharacters(output);
			strictEqual(bootTrace(output, "Stage 1 hydration"), undefined, "boot stopped before hydrating");
			strictEqual(occurrences(visible, "[draft] sigterm-draft"), 1, "the draft is recovered once");
			ok(
				output.indexOf(BRACKETED_PASTE_OFF) < output.indexOf("[draft] sigterm-draft"),
				"recovery prints after the terminal is restored",
			);
			ok(visible.includes("received SIGTERM, shutting down"), visible.slice(-2_000));
			assertRestoredOnce(output);
			assertNoFailure(output);
		} finally {
			terminal.kill();
			scratch.cleanup();
		}
	});

	it("carries a resize at Stage 0 into the hydrated frame", async () => {
		const scratch = fixture();
		const terminal = launch(scratch.env, scratch.project);
		try {
			await terminal.waitFor(EDITOR);
			terminal.resize(120, 36);
			await terminal.waitFor(HYDRATED);
			await new Promise((settle) => setTimeout(settle, 300));
			process.kill(terminal.pid, "SIGTERM");
			strictEqual(await terminal.exited(), 143, terminal.visible().slice(-2_000));
			const output = terminal.raw();
			const hydratedFrame = Number(bootTrace(output, "Stage 1 hydration")?.detail?.match(/frameId=(\d+)/u)?.[1]);
			ok(Number.isInteger(hydratedFrame), "the boot trace names the hydrated frame id");
			const frames = committedFrames(scratch.renderTrace);
			ok(
				frames.some((frame) => frame.frameId < hydratedFrame && frame.columns === 120 && frame.rows === 36),
				`Stage 0 repainted at the new size before hydration: ${JSON.stringify(frames.map((frame) => [frame.frameId, frame.columns, frame.rows]))}`,
			);
			const hydrated = frames.find((frame) => frame.frameId === hydratedFrame);
			deepStrictEqual(hydrated && [hydrated.columns, hydrated.rows], [120, 36], "the hydrated frame uses the new size");
			assertRestoredOnce(output);
			assertNoFailure(output);
		} finally {
			terminal.kill();
			scratch.cleanup();
		}
	});

	it("boots straight to the hydrated shell with the instant shell rolled back", async () => {
		const scratch = fixture({ CLIO_CODER_INSTANT_SHELL: "0" });
		const terminal = launch(scratch.env, scratch.project);
		try {
			const hydrated = await terminal.waitFor(HYDRATED);
			terminal.write("rollback-draft");
			await terminal.waitFor("rollback-draft", { from: hydrated });
			process.kill(terminal.pid, "SIGTERM");
			strictEqual(await terminal.exited(), 143, terminal.visible().slice(-2_000));
			const output = terminal.raw();
			strictEqual(bootTrace(output, "Stage 0 shell commit"), undefined, "no Stage 0 shell mounts");
			ok(bootTrace(output, "first TUI paint"), "the legacy first paint is traced");
			assertRestoredOnce(output);
			assertNoFailure(output);
		} finally {
			terminal.kill();
			scratch.cleanup();
		}
	});
});
