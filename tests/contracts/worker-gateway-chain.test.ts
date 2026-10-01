import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { AgentEvent } from "../../src/engine/types.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import { startWorkerRun, type WorkerRunHandle, type WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/**
 * Worker observation and bound accounting for gateway chains (#F1, #F2 of the
 * v0.5.7 release review). A chain child is a settled capability operation: a
 * read or grep it ran grounds a citation exactly as the direct call would, a
 * pending or failed step grounds nothing, and a child the tool-call cap refused
 * ends the run as cap-exhausted exactly as a refused direct call does.
 */

const SOURCE = [
	"export interface OverlayHandles {",
	"\topenUsage(): void;",
	"}",
	"",
	"export function wireOverlays(handles: OverlayHandles): void {",
	"\tconst openUsageOverlayState = handles.openUsage;",
	"\topenUsageOverlayState();",
	"}",
	"",
	"export const trailing = true;",
].join("\n");

type Call = { name: string; arguments: string };
type Round = Call[] | { text: string } | { overflow: string };

const grepArgs = { pattern: "openUsageOverlayState", path: "{WORKSPACE}" };
const grep: Call = { name: "grep", arguments: JSON.stringify(grepArgs) };
const read = (args: Record<string, unknown>): Call => ({ name: "read", arguments: JSON.stringify(args) });
const chain = (steps: Array<Record<string, unknown>>): Call => ({
	name: "gateway",
	arguments: JSON.stringify({ op: "chain", steps }),
});
const submit = (line: number, path = "overlays.ts"): Call => ({
	name: "clio_submit_result",
	arguments: JSON.stringify({
		findings: [{ claim: "The usage overlay opener is bound to a local.", path, line }],
		needsSplit: false,
		proposedSubtasks: [],
	}),
});

type WorkerEvent = AgentEvent | ClioWorkerEvent;

const SCOUT: Partial<WorkerRunInput> = { helperResult: true, resultContract: { kind: "scout-report" } };

async function runWorker(
	rounds: Round[],
	overrides: Partial<WorkerRunInput> = SCOUT,
	files: Record<string, string> = { "overlays.ts": SOURCE },
) {
	const env = await isolateClioEnv("clio-worker-gateway-chain-");
	const previousCwd = process.cwd();
	process.chdir(env.dir);
	for (const [name, body] of Object.entries(files)) writeFileSync(join(env.dir, name), body);
	const events: WorkerEvent[] = [];
	const bodies: Array<Record<string, unknown>> = [];
	let requests = 0;
	let worker: WorkerRunHandle | undefined;
	const server = createServer(async (req, res) => {
		bodies.push(JSON.parse(await readRequestBody(req)) as Record<string, unknown>);
		const round = rounds[requests] ?? rounds.at(-1) ?? { text: "done" };
		requests += 1;
		if ("overflow" in round) {
			res.statusCode = 400;
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					error: { message: round.overflow, type: "invalid_request_error", code: "context_length_exceeded" },
				}),
			);
			return;
		}
		res.setHeader("content-type", "text/event-stream");
		const delta = Array.isArray(round)
			? {
					role: "assistant",
					tool_calls: round.map((call, index) => ({
						index,
						id: `call_${requests}_${index}`,
						type: "function",
						function: { ...call, arguments: call.arguments.replaceAll("{WORKSPACE}", env.dir) },
					})),
				}
			: { role: "assistant", content: round.text };
		const finish = Array.isArray(round) ? "tool_calls" : "stop";
		res.end(
			`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		worker = startWorkerRun(
			{
				agentId: "scout",
				systemPrompt: "Inspect and return a Scout report.",
				task: "Find where the usage overlay opener is bound.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				thinkingLevel: "off",
				modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
				allowedTools: ["grep", "read", "gateway"],
				budget: { mode: "advisory", toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 150 },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
				...overrides,
			},
			(event) => events.push(event),
		);
		const result = await worker.promise;
		return { result, events, requests, bodies, dir: env.dir };
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		process.chdir(previousCwd);
		env.restore();
	}
}

function outcomes(events: WorkerEvent[]) {
	return events.flatMap((event) => (event.type === "clio_coder_run_outcome" ? [event.payload] : []));
}

function acceptedLines(events: WorkerEvent[]): number[] {
	return events.flatMap((event) =>
		event.type === "clio_coder_helper_result"
			? (event.payload.data as { findings: Array<{ line: number }> }).findings.map((finding) => finding.line)
			: [],
	);
}

function chainDetails(events: WorkerEvent[]): Record<string, unknown> {
	const end = events.find(
		(event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "gateway",
	) as { result?: { details?: Record<string, unknown> } } | undefined;
	ok(end?.result?.details, "the chain settled");
	return end.result.details;
}

test("a grep line grounds a citation whether it came direct or from a chain step", { timeout: 20_000 }, async () => {
	for (const call of [grep, chain([{ id: "find", capability: "grep", args: grepArgs }])]) {
		const { result, events, requests } = await runWorker([[call], [submit(6)]]);
		strictEqual(result.exitCode, 0, `${call.name}: ${JSON.stringify(outcomes(events))}`);
		strictEqual(requests, 2, `${call.name}: the citation was accepted without a repair round`);
		deepStrictEqual(acceptedLines(events), [6]);
	}
});

test("a worker whose serving window is unreported still sends its first request", { timeout: 20_000 }, async () => {
	// An unknown window resolves to 0; the guard once read that as no headroom.
	const { result, events, requests } = await runWorker([[grep], [submit(6)]], {
		...SCOUT,
		modelCapabilities: { contextWindow: 0, maxTokens: 8192, tools: true },
	});
	strictEqual(result.exitCode, 0, JSON.stringify(outcomes(events)));
	strictEqual(requests, 2);
});

const OVERFLOW = "This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens.";
const BULK = Array.from({ length: 80 }, (_, index) => `bulk line ${index} ${"x".repeat(40)}`).join("\n");
const overflowRounds = (...tail: Round[]): Round[] => [
	[read({ path: "bulk.txt" })],
	[read({ path: "overlays.ts" })],
	[read({ path: "overlays.ts", offset: 2 })],
	{ overflow: OVERFLOW },
	...tail,
];
const unreportedWindow: Partial<WorkerRunInput> = {
	...SCOUT,
	modelCapabilities: { contextWindow: 0, maxTokens: 8192, tools: true },
};

test("a server context overflow on an unreported window evicts old observations and retries once", {
	timeout: 30_000,
}, async () => {
	const { result, events, requests, bodies } = await runWorker(overflowRounds([submit(6)]), unreportedWindow, {
		"overlays.ts": SOURCE,
		"bulk.txt": BULK,
	});
	strictEqual(result.exitCode, 0, JSON.stringify(outcomes(events)));
	strictEqual(requests, 5, "three work rounds, the rejected request, and exactly one retry");
	deepStrictEqual(acceptedLines(events), [6]);
	const rejected = JSON.stringify(bodies[3]);
	const retried = JSON.stringify(bodies[4]);
	ok(!rejected.includes("evicted"), "the rejected request carried the full observation");
	ok(
		retried.includes("bulk line 0") === false && retried.includes("evicted"),
		"the retry replaced the old read with its recall marker",
	);
	ok(retried.length < rejected.length, `retry ${retried.length} bytes is smaller than the rejected ${rejected.length}`);
});

test("a server overflow under a known window still earns the one eviction retry", {
	timeout: 30_000,
}, async () => {
	// The window says 131072; the server's own count disagrees. The estimate never
	// saw this coming, so only the server's error can trigger recovery.
	const { result, events, requests, bodies } = await runWorker(overflowRounds([submit(6)]), SCOUT, {
		"overlays.ts": SOURCE,
		"bulk.txt": BULK,
	});
	strictEqual(result.exitCode, 0, JSON.stringify(outcomes(events)));
	strictEqual(requests, 5, "three work rounds, the rejected request, and exactly one retry");
	ok(JSON.stringify(bodies[4]).includes("evicted"), "the retry replaced the old read with its recall marker");
	ok(JSON.stringify(bodies[4]).length < JSON.stringify(bodies[3]).length);
});

test("an overflow the eviction cannot shrink to the recovery target is not retried", {
	timeout: 30_000,
}, async () => {
	// The evictable read is a sliver of a request dominated by the task itself.
	// Retrying it would spend the only attempt on a request still over the limit.
	const { result, events, requests } = await runWorker(
		overflowRounds([submit(6)]),
		{
			...SCOUT,
			task: `Find where the usage overlay opener is bound. ${"Background detail. ".repeat(2500)}`,
		},
		{ "overlays.ts": SOURCE, "bulk.txt": BULK },
	);
	strictEqual(requests, 4, "the rejected request is the last one");
	ok(result.exitCode !== 0, JSON.stringify(outcomes(events)));
});

test("a second server overflow after the recovery retry ends the run with the server's error", {
	timeout: 30_000,
}, async () => {
	const { result, events, requests } = await runWorker(
		overflowRounds({ overflow: OVERFLOW }, [submit(6)]),
		unreportedWindow,
		{ "overlays.ts": SOURCE, "bulk.txt": BULK },
	);
	strictEqual(requests, 5, "no third attempt");
	ok(result.exitCode !== 0, JSON.stringify(outcomes(events)));
});

test("a worker overflow with nothing to evict fails on the server's error without a repeated request", {
	timeout: 30_000,
}, async () => {
	const { result, requests } = await runWorker([[grep], { overflow: OVERFLOW }, [submit(6)]], unreportedWindow);
	strictEqual(requests, 2);
	ok(result.exitCode !== 0);
});

test("a chained grep still grounds only the lines it showed", { timeout: 20_000 }, async () => {
	const { result, events } = await runWorker([
		[chain([{ id: "find", capability: "grep", args: grepArgs }])],
		[submit(2)],
		[submit(2)],
		[submit(2)],
	]);
	strictEqual(result.exitCode, 1);
	const exhausted = outcomes(events).find((payload) => payload.outcomeCode === "result_contract_exhausted");
	ok(exhausted, JSON.stringify(outcomes(events)));
	ok(/overlays\.ts:2 \(this run read only 6-6, 7-7\)/u.test(exhausted.detail ?? ""), exhausted.detail);
});

test("a chained read grounds its returned span and nothing beyond it", { timeout: 20_000 }, async () => {
	const span = chain([{ id: "view", capability: "read", args: { path: "overlays.ts", offset: 5, limit: 2 } }]);
	const inside = await runWorker([[span], [submit(6)]]);
	strictEqual(inside.result.exitCode, 0, JSON.stringify(outcomes(inside.events)));
	deepStrictEqual(acceptedLines(inside.events), [6]);

	const beyond = await runWorker([[span], [submit(8)], [submit(8)], [submit(8)]]);
	strictEqual(beyond.result.exitCode, 1);
	const exhausted = outcomes(beyond.events).find((payload) => payload.outcomeCode === "result_contract_exhausted");
	ok(/overlays\.ts:8 \(this run read only 5-6\)/u.test(exhausted?.detail ?? ""), exhausted?.detail);
});

test("gateway op=call cannot reach a worker's direct read, so it grounds nothing", { timeout: 20_000 }, async () => {
	// read is attached to a worker directly; the gateway refuses to call it, and
	// a refused call is no evidence. Chains are the supported gateway route.
	const call: Call = {
		name: "gateway",
		arguments: JSON.stringify({ op: "call", capability: "read", args: { path: "overlays.ts" } }),
	};
	const { result, events } = await runWorker([[call], [submit(6)], [submit(6)], [submit(6)]]);
	const end = events.find(
		(event) => event.type === "tool_execution_end" && (event as { toolName?: string }).toolName === "gateway",
	) as { isError?: boolean; result?: { content?: Array<{ text?: string }> } } | undefined;
	strictEqual(end?.isError, true);
	ok(/direct tool with an attached schema/u.test(end?.result?.content?.[0]?.text ?? ""));
	strictEqual(result.exitCode, 1);
	const exhausted = outcomes(events).find((payload) => payload.outcomeCode === "result_contract_exhausted");
	ok(/never read/u.test(exhausted?.detail ?? ""), exhausted?.detail);
});

test("failed and pending chain steps ground nothing", { timeout: 20_000 }, async () => {
	const plan = chain([
		{ id: "miss", capability: "read", args: { path: "missing.ts" } },
		{ id: "find", capability: "grep", args: grepArgs, after: ["miss"] },
	]);
	const { result, events } = await runWorker([[plan], [submit(6)], [submit(6)], [submit(6)]]);
	const details = chainDetails(events);
	deepStrictEqual(details.pending, ["find"], "the dependent grep never ran");
	strictEqual(result.exitCode, 1);
	const exhausted = outcomes(events).find((payload) => payload.outcomeCode === "result_contract_exhausted");
	ok(/never read/u.test(exhausted?.detail ?? ""), exhausted?.detail);
});

test("a chain step cut to its share of the aggregate grounds only the lines the model saw", {
	timeout: 20_000,
}, async () => {
	// One 60-byte line per file line: the read returns far more than the
	// chain's 32 KiB aggregate allowance, so the model sees a prefix only.
	const big = Array.from({ length: 1200 }, (_, index) => `line ${String(index + 1).padStart(5, "0")} ${"x".repeat(47)}`);
	const files = { "overlays.ts": SOURCE, "big.ts": big.join("\n") };
	const plan = chain([{ id: "view", capability: "read", args: { path: "big.ts" } }]);
	const probe = await runWorker([[plan], [submit(1, "big.ts")]], SCOUT, files);
	strictEqual(probe.result.exitCode, 0, JSON.stringify(outcomes(probe.events)));
	const child = (probe.events.length > 0 ? chainDetails(probe.events).chainResults : []) as Array<{
		result: { content: Array<{ text: string }>; details: { observation: { shownCount: number } } };
	}>;
	const shown = child[0]?.result.details.observation.shownCount ?? 0;
	const text = child[0]?.result.content[0]?.text ?? "";
	ok(text.endsWith("[chain output truncated]"), "the chain cut the step");
	const visible = text.split("\n").filter((line) => line.startsWith("line ") && line.length === 58).length;
	ok(visible > 10 && visible < shown, `visible ${visible} of ${shown} returned lines`);

	const hidden = visible + 5;
	const cut = await runWorker(
		[[plan], [submit(hidden, "big.ts")], [submit(hidden, "big.ts")], [submit(hidden, "big.ts")]],
		SCOUT,
		files,
	);
	strictEqual(cut.result.exitCode, 1, "a line the read returned but the chain withheld does not ground a citation");
	const exhausted = outcomes(cut.events).find((payload) => payload.outcomeCode === "result_contract_exhausted");
	ok(new RegExp(`big\\.ts:${hidden} \\(this run read only 1-`, "u").test(exhausted?.detail ?? ""), exhausted?.detail);
});

test("a chained write the policy refused is reported as refused, not as never attempted", {
	timeout: 20_000,
}, async () => {
	const coder: Partial<WorkerRunInput> = {
		agentId: "coder",
		systemPrompt: "Make the change and report it.",
		task: "Write outside.txt.",
		allowedTools: ["write", "read", "gateway"],
		resultContract: { kind: "mutation-report" },
		// Writes are confined to a directory the chain's target is outside of.
		writeRoots: ["allowed"],
	};
	const report = { text: JSON.stringify({ mutatedPaths: ["outside.txt"], validations: [] }) };
	const plan = chain([{ id: "put", capability: "write", args: { path: "outside.txt", content: "x\n" } }]);
	const { events, dir } = await runWorker([[plan], report, report, report], coder);
	const details = chainDetails(events);
	const steps = details.steps as Array<{ id: string; kind: string }>;
	deepStrictEqual(
		steps.map((step) => [step.id, step.kind]),
		[["put", "error"]],
	);
	strictEqual(existsSync(join(dir, "outside.txt")), false);
	const exhausted = outcomes(events).find((payload) => payload.outcomeCode === "result_contract_exhausted");
	ok(/only write this run attempted was refused: outside\.txt/u.test(exhausted?.detail ?? ""), exhausted?.detail);
});

test("zero-tool recovery leaves both result-contract repairs available", { timeout: 20_000 }, async () => {
	const { result, events, requests } = await runWorker(
		[
			{ text: "I cannot edit this file." },
			[{ name: "write", arguments: JSON.stringify({ path: "fixed.ts", content: "export const fixed = true;\n" }) }],
			{ text: "The edit is done." },
			{ text: JSON.stringify({ mutatedPaths: ["fixed.ts"], validations: [{ name: "test", passed: true }] }) },
			{ text: JSON.stringify({ mutatedPaths: ["fixed.ts"], validations: [] }) },
		],
		{ agentId: "coder", allowedTools: ["write", "read"], resultContract: { kind: "mutation-report" } },
	);
	strictEqual(result.exitCode, 0, JSON.stringify(outcomes(events)));
	strictEqual(requests, 5, "recovery plus two independent terminal repairs");
});

test("a second zero-tool reply ends without repairing its malformed report", { timeout: 20_000 }, async () => {
	const { result, events, requests } = await runWorker(
		[{ text: "I cannot edit this file." }, { text: "Still cannot edit." }],
		{ agentId: "coder", allowedTools: ["write", "read"], resultContract: { kind: "mutation-report" } },
	);
	strictEqual(result.exitCode, 0, "the host seals worker_no_work from the empty tool activity");
	strictEqual(requests, 2);
	strictEqual(
		outcomes(events).some((event) => event.outcomeCode === "result_contract_exhausted"),
		false,
	);
});

const capBudget = (hardCap: number): Partial<WorkerRunInput> => ({
	// toolCalls above the cap disables the soft phase, so the lifetime cap is the only bound.
	budget: { mode: "enforced", toolCalls: hardCap + 1, readReserve: 0, synthesis: true, hardCap },
});
const SYNTHESIS = "Synthesized from the evidence gathered.";

function lastAssistantText(events: WorkerEvent[]): string {
	const ends = events.filter(
		(event) => event.type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant",
	) as Array<{ message: { content: Array<{ type: string; text?: string }> } }>;
	return (
		ends
			.at(-1)
			?.message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
			.join("") ?? ""
	);
}

test("a chain child refused by the tool-call cap ends the run exhausted, like a direct call", {
	timeout: 20_000,
}, async () => {
	const direct = await runWorker(
		[
			[read({ path: "overlays.ts" }), read({ path: "overlays.ts", offset: 2 }), read({ path: "overlays.ts", offset: 3 })],
			{ text: SYNTHESIS },
		],
		capBudget(2),
	);
	const chained = await runWorker(
		[
			[
				chain([
					{ id: "a", capability: "read", args: { path: "overlays.ts" } },
					{ id: "b", capability: "read", args: { path: "overlays.ts", offset: 3 }, after: ["a"] },
				]),
			],
			{ text: SYNTHESIS },
		],
		capBudget(2),
	);
	for (const [label, run] of [
		["direct", direct],
		["chain", chained],
	] as const) {
		strictEqual(run.result.exitCode, 1, `${label}: a cap-exhausted run never seals as success`);
		ok(
			outcomes(run.events).some((payload) => payload.outcomeCode === "worker_tool_call_cap_exhausted"),
			`${label}: ${JSON.stringify(outcomes(run.events))}`,
		);
		strictEqual(lastAssistantText(run.events), SYNTHESIS, `${label}: the synthesis round still runs`);
		strictEqual(run.requests, 2, `${label}: one synthesis round after the refusal`);
	}
	const details = chainDetails(chained.events);
	const children = details.chainResults as Array<{
		id: string;
		result: { details: { chainAdmission?: { outcome: string; blockReason?: string } } };
	}>;
	deepStrictEqual(
		children.map((child) => [child.id, child.result.details.chainAdmission?.outcome]),
		[
			["a", "ok"],
			["b", "blocked"],
		],
	);
	ok(/^workerToolCallCap reached \(2\)/u.test(children[1]?.result.details.chainAdmission?.blockReason ?? ""));
});

test("a chain inside the cap charges the wrapper and each step once and succeeds", { timeout: 20_000 }, async () => {
	const run = await runWorker(
		[
			[
				chain([
					{ id: "a", capability: "read", args: { path: "overlays.ts" } },
					{ id: "b", capability: "read", args: { path: "overlays.ts", offset: 3 }, after: ["a"] },
				]),
			],
			{ text: SYNTHESIS },
		],
		capBudget(3),
	);
	strictEqual(run.result.exitCode, 0, JSON.stringify(outcomes(run.events)));
	deepStrictEqual(outcomes(run.events), []);
	const finishes = run.events.filter((event) => event.type === "clio_coder_tool_finish");
	deepStrictEqual(
		finishes.map((event) => (event.type === "clio_coder_tool_finish" ? [event.payload.tool, event.payload.outcome] : [])),
		[["gateway", "ok"]],
		"children are accounted from the chain receipt, never as extra finish events",
	);
});

test("an escalation with no responder applies its fallback at once instead of waiting out the timeout", {
	timeout: 20_000,
}, async () => {
	// F9: a headless dispatch has nobody to answer a worker escalation. The
	// command is policy data; the parked call is denied and never runs.
	const bash: Call = { name: "bash", arguments: JSON.stringify({ command: "frobnicate --now" }) };
	const run = await runWorker([[bash], { text: "done" }], {
		allowedTools: ["bash"],
		onPermission: "escalate",
		escalation: { timeoutMs: 600_000, fallback: "deny", responder: "none" },
	});
	ok(!run.events.some((event) => event.type === "clio_coder_permission_escalated"));
	const resolved = run.events.flatMap((event) =>
		event.type === "clio_coder_permission_resolved" ? [event.payload] : [],
	);
	strictEqual(resolved.length, 1, JSON.stringify(resolved));
	strictEqual(resolved[0]?.source, "policy");
	strictEqual(resolved[0]?.mode, "deny");
	ok(/no operator can answer worker escalations/u.test(resolved[0]?.reason ?? ""), resolved[0]?.reason);
});
