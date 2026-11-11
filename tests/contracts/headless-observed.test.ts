import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { formatHeadlessObservedLine } from "../../src/cli/modes/headless-observed.js";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { standingChecksFrom } from "../../src/domains/safety/observed-checks.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const root = process.cwd();
const call = (id: string, name: string, args: object): object => ({
	kind: "message",
	role: "tool_call",
	timestamp: "t",
	payload: { toolCallId: id, name, args },
});
const result = (id: string, exitCode: number): object => ({
	kind: "message",
	role: "tool_result",
	timestamp: "t",
	payload: {
		toolCallId: id,
		outcome: exitCode === 0 ? "ok" : "error",
		isError: exitCode !== 0,
		result: { details: { exitCode } },
	},
});
const edit = [call("e1", "edit", { path: "src/a.py", edits: [] }), result("e1", 0)];
const failingCheck = [call("b1", "bash", { command: "python3 -B -m unittest discover -v" }), result("b1", 1)];

test("standingChecksFrom keeps a failing check after a write and lets a later pass replace it", () => {
	const failed = standingChecksFrom([{ kind: "earlier" }, ...edit, ...failingCheck], 1, root);
	strictEqual(failed.length, 1);
	strictEqual(failed[0]?.passed, false);
	const passing = [call("b2", "bash", { command: "python3 -B -m unittest discover -v" }), result("b2", 0)];
	const fixed = standingChecksFrom([...edit, ...failingCheck, ...passing], 0, root);
	deepStrictEqual(
		fixed.map((check) => [check.name, check.passed]),
		[[failed[0]?.name, true]],
	);
});

test("the observed line omits a run with no tool calls and names a write with no check after it", () => {
	strictEqual(formatHeadlessObservedLine({ toolCalls: 0, refused: 0, writes: 0, checks: [] }), null);
	strictEqual(
		formatHeadlessObservedLine({ toolCalls: 2, refused: 1, writes: 1, checks: [] }),
		"clio-coder run: observed: 2 tool calls, 1 refused · 1 write · no check observed after the last write",
	);
});

async function headlessRun(mode: "text" | "json"): Promise<{ code: number; stdout: string; stderr: string }> {
	const entries: object[] = [{ kind: "message", role: "user", payload: {} }];
	let handler: (event: unknown) => void = () => {};
	const answer = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "Done with the fix." }],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
	};
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async () => {
			handler({ type: "agent_start" });
			for (const [id, tool, actionClass, outcome] of [
				["e1", "edit", "write", "ok"],
				["b1", "bash", "execute", "error"],
			] as const) {
				handler({ type: "tool_execution_start", toolCallId: id, toolName: tool, args: {} });
				handler({ type: "tool_execution_end", toolCallId: id, toolName: tool, actionClass, outcome, result: {} });
			}
			entries.push(...edit, ...failingCheck);
			handler({ type: "message_end", message: answer });
			handler({ type: "agent_end", messages: [answer] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const out: string[] = [];
	const err: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		out.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	let code: number;
	try {
		code = await runHeadlessMainAgent(
			chat as never,
			{
				prompt: "fix it",
				mode,
				...(mode === "json" ? { jsonEvents: "terminal" as const } : {}),
				readEntries: () => entries,
				shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
			} as never,
		);
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
	return { code, stdout: out.join(""), stderr: err.join("") };
}

test("a headless run that wrote and then ran a failing check says so on stderr and in turn_end.observed", async () => {
	const env = await isolateClioEnv("headless-observed-");
	try {
		const text = await headlessRun("text");
		strictEqual(text.code, 0);
		strictEqual(text.stdout, "Done with the fix.\n");
		match(text.stderr, /clio-coder run: observed: 2 tool calls, 0 refused · 1 write · check failed: python/u);
		const json = await headlessRun("json");
		const frame = json.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; exitCode?: number; observed?: unknown })
			.find((line) => line.type === "turn_end" && typeof line.exitCode === "number");
		ok(frame, json.stdout);
		const observed = frame.observed as { writes: number; checks: Array<{ passed: boolean }> };
		strictEqual(observed.writes, 1);
		deepStrictEqual(
			observed.checks.map((check) => check.passed),
			[false],
		);
	} finally {
		env.restore();
	}
});

test("a scoped unittest pass does not replace a full-suite unittest failure", () => {
	const scoped = [call("b3", "bash", { command: "python3 -m unittest test_stats -v 2>&1" }), result("b3", 0)];
	const checks = standingChecksFrom([...edit, ...failingCheck, ...scoped], 0, root);
	deepStrictEqual(
		checks.map((check) => [check.name, check.passed]),
		[
			["python -m unittest discover", false],
			["python -m unittest test_stats", true],
		],
	);
});
