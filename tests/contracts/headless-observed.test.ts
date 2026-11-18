import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { formatHeadlessObservedLine, observeHeadlessRun } from "../../src/cli/modes/headless-observed.js";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { inspectRunEvidence } from "../../src/domains/evidence/run-evidence.js";
import { formatTrustSummary } from "../../src/domains/evidence/trust-projection.js";
import { standingChecksFrom } from "../../src/domains/safety/observed-checks.js";
import { readRunJournal } from "../harness/run-journal.js";
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
	// An unclassified call after the last check is named beside the standing check, which it leaves in place.
	const after = observeHeadlessRun({
		entries: [...edit, ...failingCheck],
		start: 0,
		effects: {
			validationOutcomes: new Map([["pytest", false]]),
			checkOutcomes: new Map([["pytest", false]]),
			unclassifiedAfterLastCheck: ["node codemod.mjs"],
		},
		toolCalls: 3,
		refused: 0,
		writes: 1,
	});
	strictEqual(after.unclassifiedAfterLastCheck, 1);
	match(
		formatHeadlessObservedLine(after) ?? "",
		/ · check failed: pytest · 1 unclassified command ran after the last check$/,
	);
});

test("a run whose verify call found no check in the workspace is observed as no checks declared", () => {
	const noChecks = [
		call("v1", "verify", {}),
		{
			kind: "message",
			role: "tool_result",
			timestamp: "t",
			payload: { toolCallId: "v1", outcome: "ok", isError: false, result: { details: { noChecksDeclared: true } } },
		},
	];
	const effects = { validationOutcomes: new Map(), checkOutcomes: new Map() };
	const observed = observeHeadlessRun({
		entries: [...edit, ...noChecks],
		start: 0,
		effects,
		toolCalls: 2,
		refused: 0,
		writes: 1,
	});
	strictEqual(observed.noChecksDeclared, true);
	strictEqual(
		formatHeadlessObservedLine(observed),
		"clio-coder run: observed: 2 tool calls, 0 refused · 1 write · no checks declared in the workspace",
	);
	strictEqual(
		observeHeadlessRun({
			entries: [...noChecks, ...edit],
			start: 2,
			effects,
			toolCalls: 1,
			refused: 0,
			writes: 1,
		}).noChecksDeclared,
		undefined,
	);
});

type StubCall = readonly [string, string, string, string, Record<string, unknown>?];
const WROTE_THEN_FAILED_CHECK: ReadonlyArray<StubCall> = [
	["e1", "edit", "write", "ok", { path: "src/a.py", edits: [] }],
	["b1", "bash", "execute", "error", { command: "python3 -B -m unittest discover -v" }],
];

async function headlessRun(
	mode: "text" | "json",
	calls: ReadonlyArray<StubCall> = WROTE_THEN_FAILED_CHECK,
	snapshot: object | null = null,
): Promise<{ code: number; stdout: string; stderr: string }> {
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
			for (const [id, tool, actionClass, outcome, args] of calls) {
				handler({ type: "tool_execution_start", toolCallId: id, toolName: tool, args: args ?? {} });
				handler({
					type: "tool_execution_end",
					toolCallId: id,
					toolName: tool,
					actionClass,
					outcome,
					isError: outcome !== "ok",
					result: {},
				});
			}
			entries.push(...edit, ...failingCheck);
			handler({ type: "message_end", message: answer });
			handler({ type: "agent_end", messages: [answer] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => snapshot,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const out: string[] = [];
	const err: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		// The test runner reports to its parent over stdout in binary frames; a run that seals a receipt is slow enough
		// to interleave them.
		if (typeof chunk !== "string") return write.call(process.stdout, chunk, ...(rest as []));
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

test("observed checks follow the receipt's rules on the task board and the headless line (x4-1)", async () => {
	let id = 0;
	const bash = (command: string, exitCode = 0): object[] => {
		id += 1;
		return [call(`p${id}`, "bash", { command }), result(`p${id}`, exitCode)];
	};
	const standing = (...steps: object[][]) =>
		standingChecksFrom([...edit, ...steps.flat()], 0, root).map((check) => [check.name, check.passed, check.check]);
	deepStrictEqual(standing(bash("make test; echo EXIT=$?")), []);
	deepStrictEqual(standing(bash("npm test && git apply fix.patch")), []);
	deepStrictEqual(standing(bash("npm test"), bash("npm run format")), []);
	deepStrictEqual(standing(bash("cd ../other && npm test")), []);
	deepStrictEqual(standing(bash("pytest", 1), bash("pytest tests/one.py")), [
		["pytest", false, undefined],
		["pytest tests/one.py", true, undefined],
	]);
	deepStrictEqual(standing(failingCheck, bash("python3 -m unittest test_stats -v 2>&1")), [
		["python3 -B -m unittest discover -v", false, undefined],
		["python3 -m unittest test_stats -v", true, undefined],
	]);
	// A narrower green under the same check id never answers that id's acceptance row.
	deepStrictEqual(standing(bash("npm test -- tests/one.test.js"), bash("npm test", 1)), [
		["npm test -- tests/one.test.js", true, undefined],
		["npm test", false, "test"],
	]);
	deepStrictEqual(standing(bash("npm ci && npm test")), [["npm ci && npm test", true, "test"]]);
	// The replay reads 7b's rules through the same readers: an inverted status settles nothing, a log is output.
	deepStrictEqual(standing(bash("! npm test")), []);
	deepStrictEqual(standing(bash("npm test", 1), bash("! npm test")), [["npm test", false, "test"]]);
	deepStrictEqual(standing(bash("npm test 2>&1 | tee /tmp/t.log")), [["npm test", true, "test"]]);
	deepStrictEqual(standing(bash("npm test"), bash("npm test | tee src/a.py")), []);
	deepStrictEqual(standing(bash("make test -C ../other")), []);
	// The recorder's check vocabulary: a read-only check retires nothing, a writer retires every pass and lands none (x5-1).
	deepStrictEqual(standing(bash("npm test"), bash("npx tsc --noEmit")), [
		["npm test", true, "test"],
		["npx tsc --noEmit", true, undefined],
	]);
	for (const change of [`node -e "fs.writeFileSync('src/a.ts', '')"`, "tsc", "npx jest -u"])
		deepStrictEqual(standing(bash("npm test"), bash(change)), [], change);
	// A runner flag after `--` files a check; a runtime loader refuses one, which settles and retires nothing (x5-2).
	deepStrictEqual(standing(bash("npm test", 1), bash("npm test -- -t parses")), [
		["npm test", false, "test"],
		["npm test -- -t parses", true, undefined],
	]);
	deepStrictEqual(standing(bash("npm test"), bash("npm test -- --import ./x.mjs")), [["npm test", true, "test"]]);
	const env = await isolateClioEnv("headless-observed-");
	try {
		const text = await headlessRun("text", [
			["e1", "edit", "write", "ok", { path: "src/a.py", edits: [] }],
			["b1", "bash", "execute", "ok", { command: "make test; echo EXIT=$?" }],
		]);
		match(text.stderr, /1 write · no check observed after the last write/u);
	} finally {
		env.restore();
	}
});

test("a headless receipt counts a bash check that ran after the last write as a typed validation (x4-6)", async () => {
	const env = await isolateClioEnv("headless-observed-");
	try {
		const run = await headlessRun(
			"text",
			[
				["e1", "edit", "write", "ok", { path: "src/a.py", edits: [] }],
				["b1", "bash", "execute", "ok", { command: "npm test" }],
			],
			{
				targetId: "fixture",
				runtimeId: "openai-compat",
				runtimeKind: "http",
				wireModelId: "fixture-model",
				promptSignature: null,
				toolSignature: null,
				cwd: env.dir,
			},
		);
		strictEqual(run.code, 0, run.stderr);
		const settled = readRunJournal(join(env.dir, "state"))?.runs[0]?.settled;
		ok(settled, run.stderr);
		deepStrictEqual(settled.verification, { state: "verified", basis: "validation-tool" });
		deepStrictEqual(
			settled.quality?.typedValidations.map((fact) => [fact.sourceId, fact.passed]),
			[["command:npm test", true]],
		);
	} finally {
		env.restore();
	}
});

test("a bash write that succeeded is a workspace change, so a later refused command does not make the run a no-op", async () => {
	const env = await isolateClioEnv("headless-observed-");
	try {
		const text = await headlessRun("text", [
			["b1", "bash", "execute", "ok", { command: "echo outside > ../outside/out.txt", unsandboxed: true }],
			["b2", "bash", "execute", "blocked", { command: "cat ../outside/out.txt", unsandboxed: true }],
			["r1", "read", "read", "ok", { path: "../outside/out.txt" }],
		]);
		strictEqual(text.code, 0, text.stderr);
	} finally {
		env.restore();
	}
});

test("a headless run whose check is a green verify after the dispatch that wrote seals quality pass (bt-27 c27d)", async () => {
	const env = await isolateClioEnv("headless-observed-");
	try {
		const run = await headlessRun(
			"text",
			[
				["d1", "dispatch", "dispatch", "ok", { agent: "coder", task: "implement slugify" }],
				["v1", "verify", "execute", "ok", { check: "python-unittest" }],
				["b1", "bash", "execute", "ok", { command: "python3 -B - <<'PY'\nprint(1)\nPY" }],
			],
			{
				targetId: "fixture",
				runtimeId: "openai-compat",
				runtimeKind: "http",
				wireModelId: "fixture-model",
				promptSignature: null,
				toolSignature: null,
				cwd: env.dir,
			},
		);
		strictEqual(run.code, 0, run.stderr);
		const stateDir = join(env.dir, "state");
		const runId = readRunJournal(stateDir)?.runs[0]?.row.runId;
		ok(runId, run.stderr);
		const evidence = await inspectRunEvidence(stateDir, runId);
		strictEqual(evidence.quality?.verdict, "pass");
		// No validation gap, and no review tag on a run no review judged: its trust line says it was not reviewed.
		deepStrictEqual(evidence.tags, []);
		match(formatTrustSummary(evidence.trust), /validation observed passing: verify python-unittest/u);
	} finally {
		env.restore();
	}
});
