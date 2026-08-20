/**
 * Real-PTY acceptance for committed-frame instrumentation.
 *
 * These observations stop at the stdout/PTY boundary. They intentionally do
 * not call an in-process timestamp "glass" latency: a terminal emulator or
 * external observation harness is required to measure a displayed pixel.
 */
import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { RenderTraceFrameRecord, RenderTraceRecord } from "../../src/interactive/render-trace.js";
import { openPty, ptySupported, stripAnsi } from "../harness/pty.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CTRL_C = String.fromCharCode(3);
const READY = /ctx /;

interface Scratch {
	dir: string;
	tracePath: string;
	env: Record<string, string>;
	cleanup(): void;
}

function makeScratch(): Scratch {
	const dir = mkdtempSync(join(tmpdir(), "clio-render-trace-pty-"));
	const configDir = join(dir, "config");
	mkdirSync(configDir, { recursive: true });
	const settings = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
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
			CLIO_CODER_HOME: dir,
			CLIO_CODER_CONFIG_DIR: configDir,
			CLIO_CODER_DATA_DIR: join(dir, "data"),
			CLIO_CODER_STATE_DIR: join(dir, "state"),
			CLIO_CODER_CACHE_DIR: join(dir, "cache"),
			CLIO_CODER_RESIDENCY: "observe",
			CLIO_CODER_RENDER_TRACE: tracePath,
			CLIO_CODER_TRACE_BOOT: "1",
			TERM: "xterm-256color",
		} as Record<string, string>,
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function readTrace(path: string): RenderTraceRecord[] {
	if (!existsSync(path)) return [];
	const records: RenderTraceRecord[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line) continue;
		try {
			records.push(JSON.parse(line) as RenderTraceRecord);
		} catch {
			// The bounded async writer may be between bytes while this process polls.
		}
	}
	return records;
}

async function waitForTrace<T>(
	path: string,
	find: (records: RenderTraceRecord[]) => T | undefined,
	description: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = find(readTrace(path));
		if (found !== undefined) return found;
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`${description} did not appear in the render trace within ${timeoutMs}ms`);
}

function frames(records: RenderTraceRecord[]): RenderTraceFrameRecord[] {
	return records.filter((record): record is RenderTraceFrameRecord => record.type === "frame");
}

describe("render trace through a real PTY", {
	concurrency: false,
	skip: ptySupported ? false : "node-pty acceptance is unavailable on Windows",
}, () => {
	it("correlates input and resize with committed frames and survives paused PTY output", async () => {
		const scratch = makeScratch();
		const ptyOpenedAt = performance.now();
		const session = await openPty(process.execPath, [join(REPO_ROOT, "dist", "cli", "index.js")], {
			cols: 80,
			rows: 24,
			cwd: REPO_ROOT,
			env: scratch.env,
		});
		try {
			await session.waitForOutput((output) => READY.test(stripAnsi(output)), 30_000);
			const bootOutput = await session.waitForOutput(/\[clio:boot\] \+\d+(?:\.\d+)?ms first TUI paint/u);
			const ptyObservedFirstFrameMs = performance.now() - ptyOpenedAt;
			const visibleBootOutput = stripAnsi(bootOutput);
			ok(
				visibleBootOutput.indexOf("Clio Coder") < visibleBootOutput.indexOf("first TUI paint"),
				"the boot mark follows the first application-frame bytes at the PTY boundary",
			);
			const firstFrame = await waitForTrace(
				scratch.tracePath,
				(records) => frames(records).find((frame) => frame.commits.length > 0),
				"first stdout-committed TUI frame",
			);
			ok(firstFrame.frameId > 0);
			strictEqual(firstFrame.columns, 80);
			strictEqual(firstFrame.rows, 24);

			const inputBefore = Math.max(
				0,
				...readTrace(scratch.tracePath)
					.filter((record) => record.type === "input_ingress")
					.map((record) => record.inputSeq),
			);
			const editorMarker = "pty-frame-correlation";
			session.write(editorMarker);
			await session.waitForOutput((output) => stripAnsi(output).includes(editorMarker));
			const editorInput = await waitForTrace(
				scratch.tracePath,
				(records) =>
					records.find(
						(record) => record.type === "input_ingress" && record.inputSeq > inputBefore && record.action === "editor",
					),
				"editor input ingress",
			);
			ok(editorInput.type === "input_ingress");
			const editorFrame = await waitForTrace(
				scratch.tracePath,
				(records) =>
					frames(records).find((frame) => frame.inputHighWater >= editorInput.inputSeq && frame.commits.length > 0),
				"first committed frame containing editor state",
			);
			ok(editorFrame.inputHighWater >= editorInput.inputSeq);

			session.resize(103, 31);
			const resizedFrame = await waitForTrace(
				scratch.tracePath,
				(records) =>
					frames(records).find((frame) => frame.columns === 103 && frame.rows === 31 && frame.commits.length > 0),
				"committed resize frame",
			);
			strictEqual(resizedFrame.columns, 103);
			strictEqual(resizedFrame.rows, 31);

			const pausedInputBefore = editorInput.inputSeq;
			session.pauseOutput();
			const pausedAt = session.output.length;
			const pausedMarker = "-paused-output-resumed";
			session.write(pausedMarker);
			const pausedInput = await waitForTrace(
				scratch.tracePath,
				(records) =>
					records.find(
						(record) => record.type === "input_ingress" && record.inputSeq > pausedInputBefore && record.action === "editor",
					),
				"input admitted while PTY output was paused",
			);
			ok(pausedInput.type === "input_ingress");
			await waitForTrace(
				scratch.tracePath,
				(records) =>
					frames(records).find((frame) => frame.inputHighWater >= pausedInput.inputSeq && frame.commits.length > 0),
				"committed frame while the PTY reader was paused",
			);
			strictEqual(session.output.length, pausedAt, "paused PTY output does not leak through the reader");
			session.resumeOutput();
			await session.waitForOutput((output) => stripAnsi(output).includes(pausedMarker));

			const records = readTrace(scratch.tracePath);
			const committedFrames = frames(records).filter((frame) => frame.commits.length > 0);
			const multiWriteFrame = committedFrames.find((frame) => frame.commits.length > 1);
			ok(multiWriteFrame, "a real cursor-bearing TUI frame performs multiple terminal writes");
			const terminalWrites = records.filter((record) => record.type === "terminal_write");
			for (const frame of committedFrames) {
				for (const commit of frame.commits) {
					const standalone = terminalWrites.find((record) => record.writeId === commit.writeId);
					ok(standalone, `frame ${frame.frameId} commit ${commit.writeId} has a terminal-write record`);
					strictEqual(standalone.frameId, frame.frameId, "every write in a frame carries the same frameId");
				}
			}

			session.write(CTRL_C);
			await new Promise<void>((resolve) => setTimeout(resolve, 75));
			session.write(CTRL_C);
			const exit = await session.waitForExit(10_000);
			strictEqual(exit.exitCode, 0, `clean PTY exit; output tail: ${stripAnsi(session.output).slice(-400)}`);
			if (process.env.CLIO_CODER_PERF_REPORT === "1") {
				const bootMatch = /\[clio:boot\] \+(\d+(?:\.\d+)?)ms first TUI paint/u.exec(visibleBootOutput);
				process.stdout.write(
					`${JSON.stringify({
						node: process.versions.node,
						columns: firstFrame.columns,
						rows: firstFrame.rows,
						inProcessFirstCommitMs: Number(bootMatch?.[1]),
						ptyObservedFirstFrameMs: Math.round(ptyObservedFirstFrameMs * 1_000) / 1_000,
						firstFrameDurationMs: firstFrame.durationMs,
						firstFrameWrites: firstFrame.commits.length,
					})}\n`,
				);
			}
		} finally {
			if (!session.exited) {
				session.resumeOutput();
				await session.killAndWaitForExit();
			}
			scratch.cleanup();
		}
	});

	it("makes forced PTY cleanup bounded, reaped, and idempotent", async () => {
		const session = await openPty(
			process.execPath,
			["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
			{
				cols: 80,
				rows: 24,
				cwd: REPO_ROOT,
				env: process.env as Record<string, string>,
			},
		);
		await session.waitForOutput("ready");
		const [first, second] = await Promise.all([session.killAndWaitForExit(), session.killAndWaitForExit()]);
		strictEqual(session.exited, true);
		strictEqual(first.exitCode, second.exitCode);
		strictEqual(first.signal, second.signal);
		const settledAgain = await session.killAndWaitForExit();
		strictEqual(settledAgain.exitCode, first.exitCode);
		strictEqual(settledAgain.signal, first.signal);
	});
});
