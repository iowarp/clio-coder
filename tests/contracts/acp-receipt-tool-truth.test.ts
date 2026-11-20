import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, type WorkerPermissionMode } from "../../src/core/defaults.js";
import type { DispatchBundleOptions } from "../../src/domains/dispatch/extension.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

const PEER = `
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\\n");
require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id: request.id, result: {protocolVersion: 1}});
  if (request.method === "session/new") send({id: request.id, result: {sessionId: "receipt-fixture"}});
  if (request.method === "session/prompt") {
    for (const [id, kind, title] of [["e1", "edit", "lib/math.js"], ["x1", "execute", "npm test"]]) {
      send({method: "session/update", params: {sessionId: "receipt-fixture", update: {
        sessionUpdate: "tool_call", toolCallId: id, kind, title, status: "in_progress"
      }}});
      send({method: "session/update", params: {sessionId: "receipt-fixture", update: {
        sessionUpdate: "tool_call_update", toolCallId: id, title, status: "completed"
      }}});
    }
    send({method: "session/update", params: {sessionId: "receipt-fixture", update: {
      sessionUpdate: "agent_message_chunk", content: {type: "text", text: "Edited and tested fixture."}
    }}});
    send({id: request.id, result: {stopReason: "end_turn"}});
  }
});
`;

it("records ACP tool kinds, completed spans, mutations, and only mediated safety decisions", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{
			id: "receipt-fixture",
			command: process.execPath,
			args: ["-e", PEER],
			toolGovernance: "clio-coder-policy",
		},
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "receipt-fixture",
			task: "Inspect and edit fixture.",
			executionRole: "researcher",
			requestOrigin: "internal",
		});
		const receipt = await run.finalPromise;
		strictEqual(
			receipt.outcome,
			"succeeded",
			JSON.stringify({ detail: receipt.outcomeDetail, failure: receipt.failureMessage }),
		);
		deepStrictEqual(
			receipt.toolStats?.map(({ tool, count, ok }) => ({ tool, count, ok })),
			[
				{ tool: "edit", count: 1, ok: 1 },
				{ tool: "execute", count: 1, ok: 1 },
			],
		);
		deepStrictEqual(receipt.safety?.toolTelemetry?.unfinished, []);
		strictEqual(receipt.toolActivity?.mutatingSucceeded, true);
		deepStrictEqual(receipt.safety?.decisions, { allowed: 0, blocked: 0, guardBlocked: 0, permissionRequested: 0 });
	} finally {
		await bundle.extension.stop?.();
	}
});

// One native and one ACP run, each sealed and each failing finalization, against a
// golden capture of their receipts, ledger rows and bus events. Both runtimes share
// one finalizer, so a change to it must leave every persisted byte as it was.
// Each run works in a fixed scratch project, and normalizeGolden masks the scratch
// home, the node binary, host and user, and timings, so the capture holds in any checkout and in CI.
// `CLIO_DISPATCH_GOLDEN=update` rewrites the fixture; run biome format on it after.
const GOLDEN = new URL("../fixtures/dispatch-finalizer-golden.json", import.meta.url);

const REPORT = JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] });

function foldedEvents(): unknown[] {
	const usage = { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 48 };
	const finish = (tool: string, decision: string, outcome: string) => ({
		type: "clio_coder_tool_finish",
		payload: { tool, decision, outcome, durationMs: 1, actionClass: "write", reason: `${tool} ${decision}` },
	});
	return [
		{ type: "clio_coder_tool_start", payload: { tool: "read" } },
		finish("read", "allowed", "ok"),
		{ type: "clio_coder_tool_start", payload: { tool: "write" } },
		finish("write", "allowed", "ok"),
		{ type: "clio_coder_tool_start", payload: { tool: "grep" } },
		finish("grep", "blocked", "blocked"),
		{
			type: "clio_coder_permission_resolved",
			payload: { tool: "bash", requestId: "req-1", actionClass: "execute", reason: "bash needs approval" },
		},
		{
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: REPORT }], usage },
		},
	];
}

async function goldenRun(kind: "native" | "acp", fail: boolean): Promise<unknown> {
	await isolateDispatchState();
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{ id: "golden-peer", command: process.execPath, args: ["-e", ""], toolGovernance: "clio-coder-policy" },
	];
	// The workspace message lists the cwd's top level, so the checkout's untracked files would leak in.
	const cwd = join(process.env.CLIO_CODER_HOME ?? "", "project");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "README.md"), "golden\n");
	const context = dispatchStubContext({ settings });
	const events: Array<{ name: string; payload: unknown }> = [];
	const emit = context.bus.emit.bind(context.bus);
	context.bus = {
		...context.bus,
		emit: (name, payload, ...rest) => {
			events.push({ name, payload });
			return emit(name, payload, ...rest);
		},
	};
	const settle = (value: { exitCode: number; signal: null }) =>
		fail ? Promise.reject(new Error("golden finalization failure")) : Promise.resolve(value);
	const bundle = makeDispatchBundle(context, {
		heartbeatIntervalMs: 3_600_000,
		spawnWorker: () => ({
			pid: null,
			promise: settle({ exitCode: 0, signal: null }),
			heartbeatAt: { current: Date.now(), monotonic: performance.now() },
			abort: () => {},
			send: () => true,
			events: (async function* () {
				yield* foldedEvents();
			})() as SpawnedWorker["events"],
		}),
		startAcpDelegationRun: () => ({
			pid: null,
			heartbeatAt: { current: Date.now(), monotonic: performance.now() },
			abort: () => {},
			kill: () => {},
			toolCallLog: () => [],
			events: (async function* () {
				yield* foldedEvents();
			})() as never,
			promise: settle({ exitCode: 0, signal: null }).then(() => ({
				messages: [],
				exitCode: 0,
				stopReason: "end_turn",
				delegation: {
					acpSessionId: "golden-session",
					initialize: null,
					toolCallsRequested: 0,
					toolCallsApproved: 0,
					toolCallsDenied: 0,
				},
			})),
		}),
	});
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: kind === "acp" ? "golden-peer" : "scout",
			task: "Inspect the fixture.",
			cwd,
			executionRole: "researcher",
			requestOrigin: "internal",
			...(kind === "native" ? { resultContractOverride: { kind: "provenance-report" as const } } : {}),
		});
		const receipt = await run.finalPromise.catch((error: unknown) => ({ rejected: String(error) }));
		const ledger = bundle.contract.getRun(run.runId);
		return normalizeGolden({ receipt, ledger, events }, run.runId);
	} finally {
		await bundle.extension.stop?.();
	}
}

const VOLATILE = new Set([
	"pid",
	"digest",
	"durationMs",
	"heartbeatAt",
	"clioCoderVersion",
	"piMonoVersion",
	"nodeVersion",
	"platform",
	"processCommand",
]);

function normalizeGolden(value: unknown, runId: string): unknown {
	const home = process.env.CLIO_CODER_HOME ?? "\u0000";
	const walk = (node: unknown, key: string | null): unknown => {
		if (key !== null && VOLATILE.has(key)) return node === null || node === undefined ? node : "<volatile>";
		if (key === "identity" && node !== null && typeof node === "object") {
			return walk({ ...node, host: "<host>", user: "<user>" }, null);
		}
		// Route scoring over every builtin agent is the router's output, copied verbatim by the finalizer.
		if (key === "evaluations" && Array.isArray(node) && node.length > 1) return "<agent-evaluations>";
		// The workspace message names its root once; count it as if it read `<home>`.
		if (key === "chars" && typeof node === "number") return node - home.length + "<home>".length;
		if (typeof node === "string") {
			return node
				.split(runId)
				.join("<run>")
				.split(process.execPath)
				.join("<node>")
				.split(home)
				.join("<home>")
				.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, "<ts>")
				.replace(/\b[0-9a-f]{64}\b/gu, "<sha256>");
		}
		if (typeof node === "number" && key !== null && /(?:Ms|At|Mono|monotonic)$/u.test(key)) return "<n>";
		if (Array.isArray(node)) return node.map((item) => walk(item, null));
		if (node !== null && typeof node === "object") {
			return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, k)]));
		}
		return node;
	};
	return walk(value, null);
}

it("seals native and ACP runs, and their failed finalizations, byte for byte as the golden capture", async () => {
	const actual: Record<string, unknown> = {};
	for (const kind of ["native", "acp"] as const) {
		actual[kind] = await goldenRun(kind, false);
		actual[`${kind}-finalization-failure`] = await goldenRun(kind, true);
	}
	// Re-serializing the parsed fixture keeps its key order, so a reordered receipt, row or event still fails.
	const text = JSON.stringify(actual, null, "\t");
	if (process.env.CLIO_DISPATCH_GOLDEN === "update") writeFileSync(GOLDEN, `${text}\n`);
	strictEqual(text, JSON.stringify(JSON.parse(readFileSync(GOLDEN, "utf8")), null, "\t"));
});

/**
 * One dispatched run of the row-224 `agy acp` stand-in: its first prompt asks "Which branch?" (main, topic) and stays
 * open until a steer prompt arrives, so every run steers once it has seen the question. The profile and HOME live in
 * the scratch home, never the operator's ~/.gemini.
 */
async function agyDispatch(
	name: string,
	options: Pick<DispatchBundleOptions, "operatorAsk"> = {},
	mode?: WorkerPermissionMode,
	scenario: "steer" | "null" | "labels" = "steer",
) {
	const dir = join(process.env.CLIO_CODER_HOME ?? "", name);
	mkdirSync(dir, { recursive: true });
	const log = join(dir, "frames.jsonl");
	const agy = join(dir, "agy");
	const fixture = fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url));
	writeFileSync(agy, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" agy "${log}" 1.5.13 ${scenario}\n`, {
		mode: 0o755,
	});
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	if (mode !== undefined) settings.fleet.permissions.mode = mode;
	settings.integrations.externalAgents.entries = [
		{
			id: "agy-fixture",
			command: agy,
			args: ["acp", "--gemini-dir", "~/.gemini", "--app-data-dir", "antigravity-cli"],
			env: { HOME: dir },
			toolGovernance: "clio-coder-policy",
		},
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), options);
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "agy-fixture",
			task: "pick a branch",
			executionRole: "researcher",
			requestOrigin: "internal",
		});
		const questions: unknown[] = [];
		for await (const event of run.events) {
			const typed = event as { type?: string; payload?: unknown };
			if (typed.type !== "clio_coder_peer_question") continue;
			questions.push(typed.payload);
			bundle.contract.steer(run.runId, "use the topic branch");
		}
		const receipt = await run.finalPromise;
		const frames = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id?: unknown; method?: string; result?: unknown });
		return { receipt, questions, frames };
	} finally {
		await bundle.extension.stop?.();
	}
}

it("steers an agy delegation through its own session/prompt and seals the steer's provenance (row 228)", {
	skip: process.platform === "win32",
}, async () => {
	const { receipt, frames } = await agyDispatch("steer");
	const steering = receipt.steering ?? [];
	strictEqual(steering.length, 1, JSON.stringify(receipt.outcomeDetail));
	strictEqual(steering[0]?.sequence, 1);
	strictEqual(steering[0]?.bytes, Buffer.byteLength("use the topic branch"));
	strictEqual(steering[0]?.acknowledged, true);
	deepStrictEqual(
		frames.filter((frame) => frame.method === "session/prompt").length,
		2,
		"the steer goes out as a second session/prompt",
	);
	ok(!frames.some((frame) => frame.method === "session/cancel"));

	// A steer the peer answers with a null result (no stop reason) is sent and recorded, but never acknowledged.
	const nulled = await agyDispatch("steer-null", {}, undefined, "null");
	strictEqual(nulled.receipt.steering?.length, 1);
	strictEqual(nulled.receipt.steering?.[0]?.acknowledged, false);
});

it("parks an agy question on the operator's ask surface and answers the picked optionId, else cancelled (row 228)", {
	skip: process.platform === "win32",
}, async () => {
	const asked: Array<{ question: string; options?: Array<{ label: string }>; fixedChoices?: boolean }> = [];
	const askedAs: Array<{ origin?: string; signal: boolean }> = [];
	let pick = "topic";
	const operatorAsk: NonNullable<DispatchBundleOptions["operatorAsk"]> = {
		available: () => true,
		ask: async (questions, invokeOptions) => {
			asked.push(...questions);
			askedAs.push({
				...(invokeOptions?.origin !== undefined ? { origin: invokeOptions.origin } : {}),
				signal: invokeOptions?.signal !== undefined,
			});
			return { answers: [{ question: questions[0]?.question ?? "", answer: pick, options: [pick] }] };
		},
	};
	const answered = await agyDispatch("answered", { operatorAsk });
	strictEqual(asked.length, 1);
	ok(asked[0]?.question.includes("Which branch?") && asked[0].question.includes("pushes to main"), asked[0]?.question);
	deepStrictEqual(asked[0]?.options, [{ label: "main" }, { label: "topic" }]);
	strictEqual(asked[0]?.fixedChoices, true);
	// A harness card: the run's signal dismisses it and its answer stays out of the main transcript.
	deepStrictEqual(askedAs, [{ origin: "harness", signal: true }]);
	deepStrictEqual(answered.frames.find((frame) => frame.id === "question-1" && frame.method === undefined)?.result, {
		outcome: { outcome: "selected", optionId: "topic" },
	});
	deepStrictEqual(answered.questions, [
		{
			questionId: "interaction_1",
			question: "Which branch?",
			choices: ["main", "topic"],
			securityWarning: "pushes to main",
			answer: "selected",
			selected: "topic",
		},
	]);

	// fleet.permissions.mode deny keeps the cancelled answer and never asks the operator.
	const denied = await agyDispatch("denied", { operatorAsk }, "deny");
	strictEqual(asked.length, 1);
	deepStrictEqual(denied.frames.find((frame) => frame.id === "question-1" && frame.method === undefined)?.result, {
		outcome: { outcome: "cancelled" },
	});
	strictEqual((denied.questions[0] as { answer?: string } | undefined)?.answer, "cancelled");

	// A repeated label gets its optionId, and a counter when that collides with a real label; a blank name shows the
	// optionId. Every option stays on the card and the pick maps back to its own optionId.
	pick = "x (b 2)";
	const labelled = await agyDispatch("labels", { operatorAsk }, undefined, "labels");
	deepStrictEqual(asked.at(-1)?.options, [{ label: "x" }, { label: "x (b)" }, { label: "x (b 2)" }, { label: "d" }]);
	deepStrictEqual(labelled.frames.find((frame) => frame.id === "question-1" && frame.method === undefined)?.result, {
		outcome: { outcome: "selected", optionId: "b" },
	});
});
