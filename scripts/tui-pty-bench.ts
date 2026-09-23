#!/usr/bin/env node
/**
 * Real-PTY latency bench for the built binary.
 *
 * Spawns `dist/cli/index.js` in a pseudo-terminal against a local
 * OpenAI-compatible fixture that streams a reply one token-sized chunk at a
 * time, with `CLIO_CODER_RENDER_TRACE` and `CLIO_CODER_TRACE_BOOT` on. Every
 * number comes from the trace or the boot marks; endpoints follow
 * docs/process/performance-methodology.md and stop at stdout commit. None of
 * them is glass latency.
 *
 *   node --import tsx scripts/tui-pty-bench.ts [--samples 5] [--cache disabled|warm]
 *        [--cols 120] [--rows 40] [--tokens 400] [--token-delay-ms 8]
 *        [--history-lines 0] [--json]
 *
 * `--history-lines N` first settles one turn whose answer is N lines, so the
 * keystroke and streaming measurements run against a transcript that tall.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn as spawnPty } from "node-pty";
import { DEFAULT_SETTINGS_YAML } from "../src/core/defaults.js";
import type { RenderTraceFrameRecord, RenderTraceRecord } from "../src/interactive/render-trace.js";
import { closeServer, seedOpenAICompatToolOrchestrator } from "../tests/harness/openai-compat-fixture.js";

const ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(ROOT, "dist", "cli", "index.js");
const CTRL_C = String.fromCharCode(3);

function arg(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const SAMPLES = Number(arg("samples", "5"));
const CACHE = arg("cache", "disabled");
const COLS = Number(arg("cols", "120"));
const ROWS = Number(arg("rows", "40"));
const TOKENS = Number(arg("tokens", "400"));
const TOKEN_DELAY_MS = Number(arg("token-delay-ms", "8"));
const HISTORY_LINES = Number(arg("history-lines", "0"));
const JSON_OUT = process.argv.includes("--json");

function readTrace(path: string): RenderTraceRecord[] {
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const out: RenderTraceRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line) as RenderTraceRecord);
		} catch {
			// The bounded async writer may be mid-line.
		}
	}
	return out;
}

const frames = (records: RenderTraceRecord[]) =>
	records.filter((record): record is RenderTraceFrameRecord => record.type === "frame" && record.commits.length > 0);

async function until<T>(probe: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const value = probe();
		if (value !== undefined) return value;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Sample {
	stage0CommitMs: number | null;
	stage1HydrationMs: number | null;
	ptyFirstBytesMs: number;
	keyIdle: number[];
	keyStreaming: number[];
	firstTokenToCommitMs: number | null;
	bytesPerToken: number | null;
	textIngress: number;
	backpressureEvents: number;
	fullFrameMsDuringStream: number[];
}

/** Commit latency for every editor keystroke admitted after `afterSeq`. */
function keystrokeLatencies(records: RenderTraceRecord[], afterSeq: number): number[] {
	const committed = frames(records);
	const out: number[] = [];
	for (const record of records) {
		if (record.type !== "input_ingress" || record.action !== "editor" || record.inputSeq <= afterSeq) continue;
		const frame = committed.find((candidate) => candidate.inputHighWater >= record.inputSeq);
		const commit = frame?.commits[0];
		if (commit !== undefined) out.push(commit.at - record.at);
	}
	return out;
}

async function sample(index: number): Promise<Sample> {
	const words = Array.from({ length: TOKENS }, (_, i) =>
		i % 40 === 39 ? "word.\n\n" : i % 7 === 6 ? "**bold** " : "word ",
	);
	const history = Array.from({ length: HISTORY_LINES }, (_, i) => `history row ${i} with **some** text`);
	const replies: string[][] = HISTORY_LINES > 0 ? [chunkLines(history, 500), words] : [words];
	const fixture = await startStreamingFixture(replies, TOKEN_DELAY_MS);
	const home = mkdtempSync(join(tmpdir(), "clio-pty-bench-"));
	const configDir = join(home, "config");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(configDir, "settings.yaml"), DEFAULT_SETTINGS_YAML, "utf8");
	seedOpenAICompatToolOrchestrator(configDir, fixture.url);
	const tracePath = join(home, "render.jsonl");
	const workspace = join(home, "workspace");
	mkdirSync(workspace, { recursive: true });
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		CLIO_CODER_HOME: home,
		CLIO_CODER_CONFIG_DIR: configDir,
		CLIO_CODER_DATA_DIR: join(home, "data"),
		CLIO_CODER_STATE_DIR: join(home, "state"),
		CLIO_CODER_CACHE_DIR: join(home, "cache"),
		CLIO_CODER_RENDER_TRACE: tracePath,
		CLIO_CODER_TRACE_BOOT: "1",
		CLIO_CODER_TEST_OPENAI_KEY: "sk-test",
		TERM: "xterm-256color",
		COLORTERM: "truecolor",
	};
	if (CACHE === "disabled") env.NODE_DISABLE_COMPILE_CACHE = "1";
	const spawnedAt = performance.now();
	let firstBytesAt: number | null = null;
	let output = "";
	const pty = spawnPty(process.execPath, [CLI, "--no-context-files"], { cols: COLS, rows: ROWS, cwd: workspace, env });
	pty.onData((data) => {
		firstBytesAt ??= performance.now();
		output += data;
	});
	let exited = false;
	pty.onExit(() => {
		exited = true;
	});
	try {
		// Hydrated: the render trace carries frames and the editor accepts input.
		await until(() => (frames(readTrace(tracePath)).length >= 2 ? true : undefined), "hydrated frames");
		await sleep(1_500);
		if (HISTORY_LINES > 0) {
			pty.write("history");
			await sleep(150);
			pty.write("\r");
			await until(() => (fixture.completed >= 1 ? true : undefined), "history reply", 60_000);
			await sleep(2_500);
		}
		const idleBase = Math.max(
			0,
			...readTrace(tracePath).flatMap((record) => (record.type === "input_ingress" ? [record.inputSeq] : [])),
		);
		for (const ch of "idlekeys") {
			pty.write(ch);
			await sleep(60);
		}
		await sleep(300);
		const afterIdle = readTrace(tracePath);
		const keyIdle = keystrokeLatencies(afterIdle, idleBase);
		// Clear the draft and submit the prompt.
		for (let i = 0; i < 8; i += 1) pty.write("\x7f");
		await sleep(100);
		pty.write("explain the design");
		await sleep(200);
		const eventBase = Math.max(
			0,
			...readTrace(tracePath).flatMap((record) => (record.type === "event_ingress" ? [record.eventSeq] : [])),
		);
		pty.write("\r");
		const firstText = await until(
			() =>
				readTrace(tracePath).find(
					(record) => record.type === "event_ingress" && record.kind === "text" && record.eventSeq > eventBase,
				),
			"first provider text ingress",
		);
		const streamBase = Math.max(
			0,
			...readTrace(tracePath).flatMap((record) => (record.type === "input_ingress" ? [record.inputSeq] : [])),
		);
		for (const ch of "typingwhilestreaming") {
			pty.write(ch);
			await sleep(45);
		}
		await until(() => (fixture.completed >= replies.length ? true : undefined), "stream end", 60_000);
		await sleep(800);
		const records = readTrace(tracePath);
		const committed = frames(records);
		const textIngress = records.filter(
			(record): record is Extract<RenderTraceRecord, { type: "event_ingress" }> =>
				record.type === "event_ingress" && record.kind === "text" && record.eventSeq > eventBase,
		);
		const firstVisible =
			firstText.type === "event_ingress"
				? committed.find((frame) => frame.panelHighWater >= firstText.eventSeq)
				: undefined;
		const lastText = textIngress.at(-1);
		const streamFrames =
			firstText.type === "event_ingress" && lastText !== undefined
				? committed.filter((frame) => frame.beginAt >= firstText.at && frame.beginAt <= lastText.at + 50)
				: [];
		const streamBytes = streamFrames.reduce(
			(sum, frame) => sum + frame.commits.reduce((total, commit) => total + commit.bytes, 0),
			0,
		);
		const boot = output;
		const stage0 = /\[clio-coder:boot\] \+(\d+(?:\.\d+)?)ms Stage 0 shell commit/u.exec(boot);
		const stage1 = /\[clio-coder:boot\] \+(\d+(?:\.\d+)?)ms Stage 1 hydration/u.exec(boot);
		// Ctrl+C clears a draft, arms the exit, then quits; keep pressing until the process is gone.
		for (let press = 0; press < 30 && !exited; press += 1) {
			pty.write(CTRL_C);
			await sleep(250);
		}
		await until(() => (exited ? true : undefined), "exit", 10_000);
		const exitOutput = output;
		const stage0Late = stage0 ?? /\[clio-coder:boot\] \+(\d+(?:\.\d+)?)ms Stage 0 shell commit/u.exec(exitOutput);
		const stage1Late = stage1 ?? /\[clio-coder:boot\] \+(\d+(?:\.\d+)?)ms Stage 1 hydration/u.exec(exitOutput);
		const result: Sample = {
			stage0CommitMs: stage0Late ? Number(stage0Late[1]) : null,
			stage1HydrationMs: stage1Late ? Number(stage1Late[1]) : null,
			ptyFirstBytesMs: (firstBytesAt ?? spawnedAt) - spawnedAt,
			keyIdle,
			keyStreaming: keystrokeLatencies(records, streamBase),
			firstTokenToCommitMs:
				firstVisible !== undefined && firstText.type === "event_ingress"
					? (firstVisible.commits[0]?.at ?? firstVisible.endAt) - firstText.at
					: null,
			bytesPerToken: textIngress.length > 0 ? streamBytes / textIngress.length : null,
			textIngress: textIngress.length,
			backpressureEvents: records.filter((record) => record.type === "terminal_write" && record.backpressured).length,
			fullFrameMsDuringStream: streamFrames.map((frame) => frame.durationMs),
		};
		if (!JSON_OUT) process.stderr.write(`sample ${index + 1}/${SAMPLES} done\n`);
		return result;
	} finally {
		if (!exited) pty.kill();
		await closeServer(fixture.server);
		rmSync(home, { recursive: true, force: true });
	}
}

function chunkLines(lines: readonly string[], per: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < lines.length; i += per) out.push(`${lines.slice(i, i + per).join("\n\n")}\n\n`);
	return out;
}

/**
 * A minimal OpenAI-compatible stream: request N answers with `replies[N]`,
 * one SSE delta per chunk, `delayMs` apart. The last reply repeats.
 */
async function startStreamingFixture(
	replies: ReadonlyArray<ReadonlyArray<string>>,
	delayMs: number,
): Promise<{ server: Server; url: string; completed: number }> {
	const state = { server: undefined as unknown as Server, url: "", completed: 0 };
	let request = 0;
	const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
		`data: ${JSON.stringify({ id: "bench", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
	state.server = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
			return;
		}
		let body = "";
		req.on("data", (part) => {
			body += part;
		});
		req.on("end", async () => {
			const parsed = JSON.parse(body) as { stream?: boolean };
			if (parsed.stream === false) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
				);
				return;
			}
			const pieces = replies[Math.min(request, replies.length - 1)] ?? [];
			request += 1;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			for (const piece of pieces) {
				res.write(chunk({ content: piece }));
				if (delayMs > 0) await sleep(delayMs);
			}
			res.write(chunk({}, { finish_reason: "stop" }));
			res.end("data: [DONE]\n\n");
			state.completed += 1;
		});
	});
	await new Promise<void>((resolve) => state.server.listen(0, "127.0.0.1", resolve));
	state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}`;
	return state;
}

function median(values: readonly number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
}

function p99(values: readonly number[]): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(0.99 * (sorted.length - 1)))] ?? Number.NaN;
}

const results: Sample[] = [];
for (let i = 0; i < SAMPLES; i += 1) results.push(await sample(i));
const nums = (pick: (s: Sample) => number | null) => results.map(pick).filter((v): v is number => v !== null);
const summary = {
	node: process.versions.node,
	cache: CACHE,
	cols: COLS,
	rows: ROWS,
	samples: SAMPLES,
	tokens: TOKENS,
	tokenDelayMs: TOKEN_DELAY_MS,
	historyLines: HISTORY_LINES,
	stage0CommitMs: { median: median(nums((s) => s.stage0CommitMs)), max: Math.max(...nums((s) => s.stage0CommitMs)) },
	stage1HydrationMs: {
		median: median(nums((s) => s.stage1HydrationMs)),
		max: Math.max(...nums((s) => s.stage1HydrationMs)),
	},
	keyIdleMs: { p50: median(results.flatMap((s) => s.keyIdle)), p99: p99(results.flatMap((s) => s.keyIdle)) },
	keyStreamingMs: {
		p50: median(results.flatMap((s) => s.keyStreaming)),
		p99: p99(results.flatMap((s) => s.keyStreaming)),
	},
	firstTokenToCommitMs: { median: median(nums((s) => s.firstTokenToCommitMs)) },
	streamFrameMs: {
		p50: median(results.flatMap((s) => s.fullFrameMsDuringStream)),
		p99: p99(results.flatMap((s) => s.fullFrameMsDuringStream)),
	},
	bytesPerToken: { median: median(nums((s) => s.bytesPerToken)) },
	textIngressPerSample: median(results.map((s) => s.textIngress)),
	backpressureEvents: results.reduce((sum, s) => sum + s.backpressureEvents, 0),
};
if (JSON_OUT) process.stdout.write(`${JSON.stringify({ summary, results }, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
