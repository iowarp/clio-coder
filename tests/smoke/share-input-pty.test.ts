/**
 * Real-PTY regression for #224: the TUI still accepts input after `/share`.
 *
 * The reported wedge was an interactive session that stopped answering the
 * keyboard after a `/share` of a council member run, and a thirty-share soak
 * against a live server never reproduced it. What the soak did establish is the
 * shape of the evidence: an `input_ingress` record proves the stdin reader
 * still delivers bytes to the application listener, and a committed frame whose
 * `inputHighWater` covers that record proves the consumer still paints them.
 * This test pins both halves for both share paths, against the in-process
 * OpenAI-compatible fixture rather than a live endpoint, so it is deterministic
 * and finishes in seconds.
 */
import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { stringify } from "yaml";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	INPUT_WEDGE_RING_CAPACITY,
	type InputWedgeSnapshot,
	type RenderTraceFrameRecord,
	type RenderTraceRecord,
} from "../../src/interactive/render-trace.js";
import { closeServer, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";
import { openPty, type PtySession, ptySupported, stripAnsi } from "../harness/pty.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CTRL_C = String.fromCharCode(3);
const READY = /ctx /;

/**
 * The fixture answers every completion with this, so the worker recipe below
 * and the council's `researcher` members both declare `research-report` and
 * both settle on their first round. A worker that failed its contract would
 * still be shareable, but it would spend two repair rounds getting there.
 *
 * It is deliberately short and the PTY below is deliberately wide, so the wedge
 * case stays about the keyboard and nothing else.
 */
const RESEARCH_REPORT = '{"source":"local","findings":[{"claim":"up","evidence":"pty"}]}';

/**
 * The answer the narrow case shares. The pending user turn echoes a worker note
 * as `  <body> · preparing`, so this 70-character body spends
 * 2 + 70 + 12 = 84 cells of an 80-column terminal, and JSON gives the fold
 * nowhere to break. That row used to be emitted at its full length and pi-tui's
 * `doRender` threw on it, which killed the process outright rather than wedging
 * it (#257).
 */
const WIDE_RESEARCH_REPORT = '{"source":"local","findings":[{"claim":"up","evidence":"eighty-col"}]}';

/** A project recipe whose postcondition the fixture reply already satisfies. */
const PROBE_RECIPE = [
	"---",
	"version: 1",
	"name: Probe",
	"description: Deterministic fixture worker for the share regression test.",
	"tools:",
	"  required: [read]",
	"  optional: []",
	"skills: []",
	"audience: custom",
	"category: research",
	"capabilityClass: read-only",
	"latencyClass: fast",
	"projectContextTier: bounded",
	"budget: {toolCalls: 4, readReserve: 0, synthesis: true}",
	"resultContract: {kind: research-report}",
	"tags: [fixture]",
	"---",
	"",
	"You are Probe. Answer with the research report you were given, and nothing else.",
].join("\n");

interface Scratch {
	dir: string;
	tracePath: string;
	env: Record<string, string>;
	cleanup(): void;
}

function makeScratch(providerUrl: string): Scratch {
	const dir = mkdtempSync(join(tmpdir(), "clio-share-input-pty-"));
	const configDir = join(dir, "config");
	mkdirSync(configDir, { recursive: true });
	mkdirSync(join(dir, ".clio-coder", "agents"), { recursive: true });
	writeFileSync(join(dir, ".clio-coder", "agents", "probe.md"), PROBE_RECIPE, "utf8");
	const settings = structuredClone(DEFAULT_SETTINGS) as Record<string, unknown>;
	settings.targets = [
		{
			id: "mock-chat",
			runtime: "openai-compat",
			url: providerUrl,
			defaultModel: "mock-model",
			lifecycle: "user-managed",
			auth: { apiKeyEnvVar: "CLIO_CODER_TEST_OPENAI_KEY" },
			wireModels: ["mock-model"],
			// A council seats two members beside the orchestrator's own turn, and
			// reservation planning denies a council that needs more endpoint slots
			// than the endpoint advertises.
			maxConcurrentRequests: 4,
			capabilities: { chat: true, tools: true, toolCallFormat: "openai", contextWindow: 32768, maxTokens: 4096 },
		},
	];
	settings.orchestrator = { target: "mock-chat", model: "mock-model", thinkingLevel: "off" };
	// Full autonomy so the council dispatch is admitted without parking on the
	// approval overlay. The overlay is covered elsewhere; this test is about what
	// the keyboard does after the share.
	settings.autonomy = "full-auto";
	const workers = settings.workers as Record<string, unknown>;
	workers.default = { target: "mock-chat", model: "mock-model", thinkingLevel: "off" };
	workers.rosters = {
		default: {
			members: [
				{ label: "alpha", target: "mock-chat", model: "mock-model" },
				{ label: "beta", target: "mock-chat", model: "mock-model" },
			],
		},
	};
	(settings.terminal as Record<string, unknown>).smoothStreaming = "off";
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
			CLIO_CODER_TEST_OPENAI_KEY: "sk-test",
			TERM: "xterm-256color",
			NO_COLOR: "1",
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

function highestInputSeq(path: string): number {
	return Math.max(
		0,
		...readTrace(path)
			.filter((record) => record.type === "input_ingress")
			.map((record) => record.inputSeq),
	);
}

/**
 * The run id `/share` is going to be given, read off the sealed receipts rather
 * than off the screen. A transcript line can be truncated by the Fleet Runs
 * island or fall outside the viewport; the receipt is the same terminal truth
 * the worker block settles on.
 */
async function waitForSealedRunId(scratch: Scratch, agentId: string, timeoutMs = 30_000): Promise<string> {
	const directory = join(scratch.env.CLIO_CODER_STATE_DIR ?? "", "receipts");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const name of existsSync(directory) ? readdirSync(directory) : []) {
			if (!name.endsWith(".json")) continue;
			try {
				const receipt = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
					runId?: string;
					agentId?: string;
				};
				if (receipt.agentId === agentId && typeof receipt.runId === "string") return receipt.runId;
			} catch {
				// A receipt caught mid-write is read again on the next pass.
			}
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`no sealed receipt for agent '${agentId}' within ${timeoutMs}ms`);
}

/**
 * Type one command, then hold it to the two facts the ticket asks about: the
 * reader admitted the submit, and a frame carrying it reached stdout.
 */
async function submitAndProveInputStillFlows(
	session: PtySession,
	scratch: Scratch,
	line: string,
	label: string,
): Promise<void> {
	const before = highestInputSeq(scratch.tracePath);
	session.write(line);
	await waitForTrace(
		scratch.tracePath,
		(records) =>
			records.find((record) => record.type === "input_ingress" && record.inputSeq > before && record.action === "editor"),
		`${label}: editor ingress`,
	);
	session.write("\r");
	const submit = await waitForTrace(
		scratch.tracePath,
		(records) =>
			records.find((record) => record.type === "input_ingress" && record.inputSeq > before && record.action === "submit"),
		`${label}: submit ingress`,
	);
	ok(submit.type === "input_ingress");
	const frame = await waitForTrace(
		scratch.tracePath,
		(records) =>
			records.find(
				(record): record is RenderTraceFrameRecord =>
					record.type === "frame" && record.inputHighWater >= submit.inputSeq && record.commits.length > 0,
			),
		`${label}: committed frame covering the submit`,
	);
	ok(frame.inputHighWater >= submit.inputSeq, `${label}: the frame that committed carries the submit`);
}

describe("input after /share through a real PTY", {
	concurrency: false,
	skip: ptySupported ? false : "node-pty acceptance is unavailable on Windows",
}, () => {
	it("keeps admitting input after sharing a worker run and a council member run", async () => {
		const fixture = await startOpenAICompatFixture(RESEARCH_REPORT);
		const scratch = makeScratch(fixture.url);
		const session = await openPty(
			process.execPath,
			[join(REPO_ROOT, "dist", "cli", "index.js"), "--no-context-files", "--no-skills"],
			{ cols: 120, rows: 30, cwd: scratch.dir, env: scratch.env },
		);
		try {
			await session.waitForOutput((output) => READY.test(stripAnsi(output)), 30_000);

			// One ordinary operator-started worker run, settled on its receipt.
			session.write("/run probe report on the input pipeline\r");
			await session.waitForOutput((output) => stripAnsi(output).includes("contract pass"), 30_000);
			const workerRunId = await waitForSealedRunId(scratch, "probe");

			await submitAndProveInputStillFlows(session, scratch, `/share ${workerRunId}`, "worker share");
			await session.waitForOutput((output) => stripAnsi(output).includes("shared by the operator"), 20_000);

			// One council, whose members carry the roster label `/share` reads. The
			// synthesis run is dispatched only after every member has sealed, so its
			// receipt is the point at which a member run is settled and shareable.
			session.write("/council --rounds 1 --synthesis none report on the input pipeline\r");
			await waitForSealedRunId(scratch, "council-synthesis");
			const memberRunId = await waitForSealedRunId(scratch, "researcher");

			await submitAndProveInputStillFlows(session, scratch, `/share ${memberRunId}`, "council member share");
			// The member's note travels under its roster label, which is the path the
			// reported wedge followed.
			await session.waitForOutput((output) => /\[(alpha|beta)\]/u.test(stripAnsi(output)), 20_000);

			// One last keystroke after both shares: the editor is still live.
			const beforeFinal = highestInputSeq(scratch.tracePath);
			const marker = "post-share-input";
			session.write(marker);
			await session.waitForOutput((output) => stripAnsi(output).includes(marker), 20_000);
			const finalIngress = await waitForTrace(
				scratch.tracePath,
				(records) =>
					records.find(
						(record) => record.type === "input_ingress" && record.inputSeq > beforeFinal && record.action === "editor",
					),
				"editor ingress after both shares",
			);
			ok(finalIngress.type === "input_ingress");
			await waitForTrace(
				scratch.tracePath,
				(records) =>
					records.find(
						(record): record is RenderTraceFrameRecord =>
							record.type === "frame" && record.inputHighWater >= finalIngress.inputSeq && record.commits.length > 0,
					),
				"committed frame after both shares",
			);

			session.write(CTRL_C);
			await new Promise<void>((resolve) => setTimeout(resolve, 75));
			session.write(CTRL_C);
			await session.waitForOutput((output) => stripAnsi(output).includes("Ctrl+C again to quit"), 10_000);
			session.write(CTRL_C);
			const exit = await session.waitForExit(15_000);
			strictEqual(exit.exitCode, 0, `clean PTY exit; output tail: ${stripAnsi(session.output).slice(-400)}`);
		} catch (error) {
			const traceTypes = readTrace(scratch.tracePath).map((record) => record.type);
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; requests=${fixture.requests.length}; trace=${JSON.stringify(traceTypes.slice(-40))}; output=${JSON.stringify(stripAnsi(session.output).slice(-1200))}`,
				{ cause: error },
			);
		} finally {
			if (!session.exited) {
				session.resumeOutput();
				await session.killAndWaitForExit();
			}
			scratch.cleanup();
			await closeServer(fixture.server);
		}
	});

	it("survives sharing a spaceless body into an 80-column terminal", async () => {
		const fixture = await startOpenAICompatFixture(WIDE_RESEARCH_REPORT);
		const scratch = makeScratch(fixture.url);
		const session = await openPty(
			process.execPath,
			[join(REPO_ROOT, "dist", "cli", "index.js"), "--no-context-files", "--no-skills"],
			{ cols: 80, rows: 30, cwd: scratch.dir, env: scratch.env },
		);
		try {
			await session.waitForOutput((output) => READY.test(stripAnsi(output)), 30_000);

			session.write("/run probe report on the input pipeline\r");
			await session.waitForOutput((output) => stripAnsi(output).includes("contract pass"), 30_000);
			const workerRunId = await waitForSealedRunId(scratch, "probe");

			await submitAndProveInputStillFlows(session, scratch, `/share ${workerRunId}`, "narrow share");
			await session.waitForOutput((output) => stripAnsi(output).includes("shared by the operator"), 20_000);
			ok(!session.exited, `the note was painted and the TUI is still up; tail: ${stripAnsi(session.output).slice(-400)}`);

			// The row is on screen; the keyboard still reaches the editor past it.
			const beforeFinal = highestInputSeq(scratch.tracePath);
			const marker = "narrow-share-input";
			session.write(marker);
			await session.waitForOutput((output) => stripAnsi(output).includes(marker), 20_000);
			const finalIngress = await waitForTrace(
				scratch.tracePath,
				(records) =>
					records.find(
						(record) => record.type === "input_ingress" && record.inputSeq > beforeFinal && record.action === "editor",
					),
				"editor ingress after the narrow share",
			);
			ok(finalIngress.type === "input_ingress");
			await waitForTrace(
				scratch.tracePath,
				(records) =>
					records.find(
						(record): record is RenderTraceFrameRecord =>
							record.type === "frame" && record.inputHighWater >= finalIngress.inputSeq && record.commits.length > 0,
					),
				"committed frame after the narrow share",
			);

			session.write(CTRL_C);
			await new Promise<void>((resolve) => setTimeout(resolve, 75));
			session.write(CTRL_C);
			await session.waitForOutput((output) => stripAnsi(output).includes("Ctrl+C again to quit"), 10_000);
			session.write(CTRL_C);
			const exit = await session.waitForExit(15_000);
			strictEqual(exit.exitCode, 0, `clean PTY exit; output tail: ${stripAnsi(session.output).slice(-400)}`);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}; output=${JSON.stringify(stripAnsi(session.output).slice(-1200))}`,
				{ cause: error },
			);
		} finally {
			if (!session.exited) {
				session.resumeOutput();
				await session.killAndWaitForExit();
			}
			scratch.cleanup();
			await closeServer(fixture.server);
		}
	});

	it("leaves an input-wedge classification behind on SIGTERM with no render trace armed", async () => {
		const fixture = await startOpenAICompatFixture(RESEARCH_REPORT);
		const scratch = makeScratch(fixture.url);
		// The operator who hits the wedge did not arm a trace first, which is the
		// whole point of the always-on ring.
		delete scratch.env.CLIO_CODER_RENDER_TRACE;
		const session = await openPty(
			process.execPath,
			[join(REPO_ROOT, "dist", "cli", "index.js"), "--no-context-files", "--no-skills"],
			{ cols: 120, rows: 30, cwd: scratch.dir, env: scratch.env },
		);
		try {
			await session.waitForOutput((output) => READY.test(stripAnsi(output)), 30_000);
			const marker = "wedge-dump-input";
			session.write(marker);
			await session.waitForOutput((output) => stripAnsi(output).includes(marker), 20_000);

			process.kill(session.pid, "SIGTERM");
			await session.waitForExit(15_000);

			const directory = join(scratch.env.CLIO_CODER_STATE_DIR ?? "", "input-wedge");
			ok(existsSync(directory), "SIGTERM created the input-wedge dump directory");
			const dumps = readdirSync(directory).filter((name) => name.endsWith(".json"));
			strictEqual(dumps.length, 1, `exactly one dump; saw ${JSON.stringify(dumps)}`);
			const snapshot = JSON.parse(readFileSync(join(directory, dumps[0] ?? ""), "utf8")) as InputWedgeSnapshot;
			strictEqual(snapshot.capacity, INPUT_WEDGE_RING_CAPACITY);
			ok(snapshot.inputIngress.length > 0, "the ring recorded the typed bytes without the trace file");
			ok(snapshot.frames.length > 0, "the ring recorded committed frames without the trace file");
			ok(
				snapshot.frames.every((frame) => frame.commits.length > 0),
				"only frames that reached stdout are kept",
			);
			// Both halves of the pipeline were moving, which is what the dump has to
			// be able to say. A wedge is the same record with the other verdict.
			strictEqual(snapshot.classification, "input-committed");
			ok(snapshot.msSinceLastInputIngress !== null && snapshot.msSinceLastCommittedFrame !== null);
		} finally {
			if (!session.exited) await session.killAndWaitForExit();
			scratch.cleanup();
			await closeServer(fixture.server);
		}
	});
});
