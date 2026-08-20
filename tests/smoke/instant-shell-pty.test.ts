import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { RenderTraceRecord } from "../../src/interactive/render-trace.js";
import { openPty, ptySupported, stripAnsi } from "../harness/pty.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "dist", "cli", "index.js");
const CTRL_C = String.fromCharCode(3);

function scratch(extraEnv: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "clio-instant-shell-"));
	const configDir = join(dir, "config");
	mkdirSync(configDir, { recursive: true });
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{
			id: "declared",
			runtime: "openai-compat",
			url: "http://127.0.0.1:9",
			defaultModel: "declared-model",
			lifecycle: "user-managed",
		},
	];
	settings.orchestrator = { target: "declared", model: "declared-model", thinkingLevel: "off" };
	writeFileSync(join(configDir, "settings.yaml"), stringify(settings), "utf8");
	const tracePath = join(dir, "render.jsonl");
	return {
		dir,
		tracePath,
		env: {
			...process.env,
			NODE_ENV: "test",
			CLIO_CODER_HOME: dir,
			CLIO_CODER_CONFIG_DIR: configDir,
			CLIO_CODER_DATA_DIR: join(dir, "data"),
			CLIO_CODER_STATE_DIR: join(dir, "state"),
			CLIO_CODER_CACHE_DIR: join(dir, "cache"),
			CLIO_CODER_RESIDENCY: "observe",
			CLIO_CODER_RENDER_TRACE: tracePath,
			CLIO_CODER_TRACE_BOOT: "1",
			TERM: "xterm-256color",
			...extraEnv,
		} as Record<string, string>,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function occurrences(text: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (offset >= 0) {
		offset = text.indexOf(needle, offset);
		if (offset < 0) break;
		count += 1;
		offset += needle.length;
	}
	return count;
}

function readTrace(path: string): RenderTraceRecord[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as RenderTraceRecord];
			} catch {
				return [];
			}
		});
}

function persistedBashEntries(root: string): Array<{ command: string; output: string }> {
	const found: Array<{ command: string; output: string }> = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(path);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const parsed = JSON.parse(line) as Record<string, unknown>;
					if (parsed.kind === "bashExecution" && typeof parsed.command === "string") {
						found.push({ command: parsed.command, output: typeof parsed.output === "string" ? parsed.output : "" });
					}
				} catch {
					// Other bounded writers may be between bytes while the test polls.
				}
			}
		}
	};
	visit(root);
	return found;
}

async function waitForBootBashEntries(root: string): Promise<Array<{ command: string; output: string }>> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const entries = persistedBashEntries(root).filter((entry) => entry.command.startsWith("printf admitted-"));
		if (entries.length === 2) return entries;
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("two persisted boot-admitted bash entries did not settle");
}

describe("instant shell through a real PTY", {
	concurrency: false,
	skip: ptySupported ? false : "node-pty acceptance is unavailable on Windows",
}, () => {
	it("accepts multiple pre-hydration submits and a later draft across a resize with one terminal owner", async () => {
		const s = scratch({ CLIO_CODER_TEST_STAGE1_DELAY_MS: "600" });
		const session = await openPty(process.execPath, [CLI], { cols: 80, rows: 24, cwd: REPO_ROOT, env: s.env });
		try {
			await session.waitForOutput((output) => stripAnsi(output).includes("Hydrating session services"), 10_000);
			strictEqual(stripAnsi(session.output).includes("Stage 1 hydration"), false);
			session.write("!! printf admitted-one\r");
			await session.waitForOutput((output) => stripAnsi(output).includes("queued !! printf admitted-one"));
			session.write("!! printf admitted-two\rvisible-draft");
			session.resize(101, 31);
			await session.waitForOutput((output) => {
				const visible = stripAnsi(output);
				return visible.includes("queued !! printf admitted-one") && visible.includes("queued !! printf admitted-two");
			});
			await session.waitForOutput((output) => /ctx /u.test(stripAnsi(output)), 30_000);
			await session.waitForOutput((output) => stripAnsi(output).includes("visible-draft"));
			const bashEntries = await waitForBootBashEntries(s.dir);
			deepStrictEqual(
				bashEntries.map((entry) => [entry.command, entry.output]),
				[
					["printf admitted-one", "admitted-one"],
					["printf admitted-two", "admitted-two"],
				],
				"both immutable records execute and persist exactly once in FIFO order",
			);

			// Clear the preserved draft, then use the ordinary armed double Ctrl+C.
			session.write(CTRL_C);
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			session.write(CTRL_C);
			await session.waitForOutput((output) => stripAnsi(output).includes("Ctrl+C again to quit"));
			session.write(CTRL_C);
			const exit = await session.waitForExit(10_000);
			strictEqual(exit.exitCode, 0, stripAnsi(session.output).slice(-800));
			match(stripAnsi(session.output), /\[clio:boot\].*Stage 0 shell commit/u);
			match(stripAnsi(session.output), /\[clio:boot\].*Stage 1 hydration/u);

			const records = readTrace(s.tracePath);
			ok(
				records.some(
					(record) => record.type === "frame" && record.columns === 101 && record.rows === 31 && record.commits.length > 0,
				),
				"the one renderer commits the resize that crossed hydration",
			);
			strictEqual(occurrences(session.output, "\u001b[?2004h"), 1, "bracketed paste initializes once");
			strictEqual(occurrences(session.output, "\u001b[?2004l"), 1, "bracketed paste restores once");
			strictEqual(occurrences(session.output, "\u001b[?25h"), 1, "cursor restores once");
			ok(occurrences(session.output, "\u001b]11;?") <= 1, "background query executes at most once");
			ok(occurrences(session.output, "\u001b[16t") <= 1, "cell-size query executes at most once");
		} finally {
			if (!session.exited) await session.killAndWaitForExit();
			s.cleanup();
		}
	});

	it("restores raw mode and recovers accepted input when Stage 1 import fails", async () => {
		const s = scratch({
			CLIO_CODER_TEST_STAGE1_DELAY_MS: "350",
			CLIO_CODER_TEST_STAGE1_FAIL: "1",
		});
		const session = await openPty(process.execPath, [CLI], { cols: 80, rows: 24, cwd: REPO_ROOT, env: s.env });
		try {
			await session.waitForOutput((output) => stripAnsi(output).includes("Hydrating session services"), 10_000);
			session.write("recover-submit\rrecover-draft");
			await session.waitForOutput((output) => stripAnsi(output).includes("queued recover-submit"));
			const exit = await session.waitForExit(10_000);
			strictEqual(exit.exitCode, 1);
			const visible = stripAnsi(session.output);
			ok(
				session.output.indexOf("\u001b[?2004l") < session.output.indexOf("injected Stage 1 hydration failure"),
				"the boot failure prints only after raw mode and terminal protocols restore",
			);
			match(visible, /injected Stage 1 hydration failure/u);
			match(visible, /\[queued 1\] recover-submit/u);
			match(visible, /\[draft\] recover-draft/u);
			strictEqual(/\[clio:boot\].* Stage 1 hydration/u.test(visible), false);
			strictEqual(occurrences(session.output, "\u001b[?2004l"), 1);
			strictEqual(occurrences(session.output, "\u001b[?25h"), 1);
		} finally {
			if (!session.exited) await session.killAndWaitForExit();
			s.cleanup();
		}
	});

	it("routes SIGTERM through the lease while hydration is pending", async () => {
		const s = scratch({ CLIO_CODER_TEST_STAGE1_DELAY_MS: "1000" });
		const session = await openPty(process.execPath, [CLI], { cols: 80, rows: 24, cwd: REPO_ROOT, env: s.env });
		try {
			await session.waitForOutput((output) => stripAnsi(output).includes("Hydrating session services"), 10_000);
			process.kill(session.pid, "SIGTERM");
			const exit = await session.waitForExit(10_000);
			strictEqual(exit.exitCode, 143, stripAnsi(session.output).slice(-800));
			match(stripAnsi(session.output), /received SIGTERM, shutting down/u);
			strictEqual(occurrences(session.output, "\u001b[?2004l"), 1);
			strictEqual(occurrences(session.output, "\u001b[?25h"), 1);
		} finally {
			if (!session.exited) await session.killAndWaitForExit();
			s.cleanup();
		}
	});

	it("recovers an unsent draft when SIGTERM arrives after hydration", async () => {
		const s = scratch();
		const session = await openPty(process.execPath, [CLI], { cols: 80, rows: 24, cwd: REPO_ROOT, env: s.env });
		try {
			await session.waitForOutput((output) => /ctx /u.test(stripAnsi(output)), 30_000);
			session.write("adopted-sigterm-draft");
			await session.waitForOutput((output) => stripAnsi(output).includes("adopted-sigterm-draft"));
			process.kill(session.pid, "SIGTERM");
			const exit = await session.waitForExit(10_000);
			strictEqual(exit.exitCode, 143, stripAnsi(session.output).slice(-800));
			const visible = stripAnsi(session.output);
			strictEqual(occurrences(visible, "[draft] adopted-sigterm-draft"), 1);
			ok(
				session.output.indexOf("\u001b[?2004l") < session.output.indexOf("[draft] adopted-sigterm-draft"),
				"draft recovery follows terminal restoration",
			);
		} finally {
			if (!session.exited) await session.killAndWaitForExit();
			s.cleanup();
		}
	});

	it("keeps minimal double-Ctrl+C available before hydration attaches", async () => {
		const s = scratch({ CLIO_CODER_TEST_STAGE1_DELAY_MS: "2000" });
		const session = await openPty(process.execPath, [CLI], { cols: 80, rows: 24, cwd: REPO_ROOT, env: s.env });
		try {
			await session.waitForOutput((output) => stripAnsi(output).includes("Hydrating session services"), 10_000);
			session.write(CTRL_C);
			await session.waitForOutput((output) => stripAnsi(output).includes("Ctrl+C again to exit"));
			session.write(CTRL_C);
			const exit = await session.waitForExit(10_000);
			strictEqual(exit.exitCode, 0, stripAnsi(session.output).slice(-800));
			strictEqual(/\[clio:boot\].* Stage 1 hydration/u.test(stripAnsi(session.output)), false);
			strictEqual(occurrences(session.output, "\u001b[?2004l"), 1);
			strictEqual(occurrences(session.output, "\u001b[?25h"), 1);
		} finally {
			if (!session.exited) await session.killAndWaitForExit();
			s.cleanup();
		}
	});
});
