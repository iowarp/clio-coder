import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { telemetryContext } from "../../src/core/telemetry/context.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { abandonedSettlement, beginCall, registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import { DELTA_GAP_BOUNDS_MS, validPayload } from "../../src/core/telemetry/schemas.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { listMiddlewareRuleDefinitions } from "../../src/domains/middleware/rules.js";
import { createHealthWindows } from "../../src/domains/observability/health-window.js";
import { createSessionJournals } from "../../src/domains/observability/session-journals.js";
import { researchCaptureFor } from "../../src/engine/research-capture.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { prefixBlocksOf } from "../../src/session-control/prefix-blocks.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { createRegistry } from "../../src/tools/registry.js";

function capture(sessionId: string, admitResearch = false) {
	const records: PendingTelemetry[] = [];
	const release = registerTelemetrySink(sessionId, {
		enqueue: (record) => Boolean(records.push(record)),
		admits: (kind) =>
			admitResearch ||
			!["health.samples", "call.timing.deltas", "prefix.blocks", "request.capture", "provider.headers"].includes(kind),
	});
	return { records, release, of: (kind: string) => records.filter((record) => record.kind === kind) };
}

test("a settled tool call records tool.settled under its session, turn and tool call (#434)", async () => {
	const sink = capture("producer-tools");
	try {
		const registry = createRegistry({ safety: createWorkerSafety() });
		registry.register({
			name: ToolNames.Read,
			description: "Read fixture",
			parameters: Type.Object({ path: Type.String() }),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "fixture" }),
		});
		const [tool] = resolveAgentTools({
			registry,
			allowedTools: [ToolNames.Read],
			invokeOptions: () => ({ sessionId: "producer-tools", turnId: "turn-1" }),
		});
		ok(tool);
		await tool.execute("tool-call-1", { path: "README.md" });
		const [settled] = sink.of("tool.settled");
		ok(settled && validPayload("tool.settled", settled.data), JSON.stringify(settled?.data));
		deepStrictEqual(
			{ ...settled.data, durationMs: 0 },
			{ tool: ToolNames.Read, outcome: "ok", durationMs: 0, resultBytes: Buffer.byteLength("fixture") },
		);
		strictEqual(settled.ctx.turnId, "turn-1");
		strictEqual(settled.ctx.toolCallId, "tool-call-1");
	} finally {
		sink.release();
	}
});

test("middleware.fired names each emitting rule, its own effects and the evidence it reports (#431)", () => {
	const sink = capture("producer-middleware");
	try {
		const middleware = createMiddlewareBundle({
			registrations: [
				{ id: "quiet", description: "never fires", hooks: ["turn_end"], evaluate: () => [] },
				{
					id: "nudge.static",
					description: "fires on its declared evidence",
					hooks: ["turn_end"],
					evidence: "count:open-tasks@turn-end",
					evaluate: () => [{ kind: "notify_operator", message: "c", key: "k" }],
				},
				{
					id: "nudge.fixture",
					description: "fires with evidence",
					hooks: ["turn_end"],
					evaluate: (_input, context) => {
						context?.evidence?.("regex:PLAN_REQUEST@operator-request");
						return [
							{ kind: "inject_reminder", message: "a", severity: "warn" },
							{ kind: "request_continuation", message: "b" },
						];
					},
				},
			],
		}).contract;
		middleware.runHook({ hook: "turn_end", sessionId: "producer-middleware", turnId: "turn-2" });
		const fired = sink.of("middleware.fired");
		strictEqual(fired.length, 2);
		for (const record of fired) ok(validPayload("middleware.fired", record.data));
		strictEqual((fired[0]?.data as { evidence?: string }).evidence, "count:open-tasks@turn-end");
		deepStrictEqual(fired[1]?.data, {
			hook: "turn_end",
			phase: "sync",
			ruleId: "nudge.fixture",
			effects: ["inject_reminder", "request_continuation"],
			severity: "warn",
			evidence: "regex:PLAN_REQUEST@operator-request",
		});
		strictEqual(fired[1]?.ctx.turnId, "turn-2");
	} finally {
		sink.release();
	}
});

test("every builtin rule definition names its trigger evidence class (#431)", () => {
	for (const definition of listMiddlewareRuleDefinitions())
		ok(
			definition.evidence !== undefined &&
				validPayload("middleware.fired", {
					hook: "turn_end",
					phase: "sync",
					ruleId: definition.rule.id,
					effects: ["inject_reminder"],
					evidence: definition.evidence,
				}),
			definition.rule.id,
		);
});

test("call.timing.deltas is a gap histogram recorded only where delta capture is on (#428, #434)", () => {
	const standard = capture("producer-deltas-standard");
	const deep = capture("producer-deltas-research", true);
	try {
		const target = {
			targetId: "t",
			runtimeId: "r",
			api: "a",
			requestedModel: "m",
			reportedModel: { kind: "unknown", reason: "not-observed" },
		} as const;
		for (const sessionId of ["producer-deltas-standard", "producer-deltas-research"]) {
			const call = beginCall(
				{ label: "main", target, roundKind: "normal", toolChoice: "auto" },
				{ sessionId, label: "main" },
			);
			strictEqual(call.delta === undefined, sessionId.endsWith("standard"));
			for (let index = 0; index < 4; index++) call.delta?.();
			call.abandon("internal");
		}
		strictEqual(standard.of("call.timing.deltas").length, 0);
		const [timing] = deep.of("call.timing.deltas");
		ok(timing && validPayload("call.timing.deltas", timing.data), JSON.stringify(timing?.data));
		const data = timing.data as { deltas: number; gapCounts: number[] };
		strictEqual(data.deltas, 4);
		strictEqual(data.gapCounts.length, DELTA_GAP_BOUNDS_MS.length + 1);
		strictEqual(timing.ctx.callId !== undefined, true);
	} finally {
		standard.release();
		deep.release();
	}
});

test("prefix.blocks follows the sent prompt: compiled sections only when the sent text is the compiled one (#423)", () => {
	const hash = "a".repeat(64);
	const compiled = { systemPrompt: "S", sections: [{ id: "identity", tokenEstimate: 3, contentHash: hash }] };
	const sent = { systemPrompt: "S", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read" }] };
	const blocks = prefixBlocksOf(compiled, sent);
	ok(blocks && validPayload("prefix.blocks", blocks));
	deepStrictEqual(
		blocks.blocks.map((block) => [block.kind, block.id ?? null]),
		[
			["system-section", "identity"],
			["tools", null],
			["message", "user"],
		],
	);
	strictEqual(blocks.blocks[0]?.hash, hash);
	const locked = prefixBlocksOf(compiled, { ...sent, systemPrompt: "S plus a synthesis lock" });
	strictEqual(locked?.blocks[0]?.id, "system-prompt");
});

test("health.samples rides beside health.window only for writers that keep it (#428, #434)", async () => {
	const windows: string[] = [];
	const samples: string[] = [];
	const health = createHealthWindows({
		writers: () => [
			{ sessionId: "kept", health: { queueDepth: 0, dropped: 0 } as never },
			{ sessionId: "standard", health: { queueDepth: 0, dropped: 0 } as never },
		],
		record: (sessionId) => windows.push(sessionId),
		recordSamples: (sessionId, data) => {
			ok(validPayload("health.samples", data), JSON.stringify(data));
			samples.push(sessionId);
		},
		samplesWanted: (sessionId) => sessionId === "kept",
		windowMs: 40,
	});
	health.start();
	await new Promise((resolve) => setTimeout(resolve, 70));
	health.stop();
	ok(windows.includes("kept") && windows.includes("standard"));
	ok(samples.length > 0 && samples.every((sessionId) => sessionId === "kept"));
});

test("prompt.compiled is recorded once per structure by a writer, under the call that first cited it (#434)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "telemetry-prompt-compiled-"));
	try {
		const journals = createSessionJournals(stateDir, () => {});
		const lease = await journals.acquire({ id: "prompt-compiled", cwdHash: "cwd" }, "main");
		const structure = await lease.storeRequestObjects?.({
			prompt: { sections: [{ id: "identity", tokenEstimate: 3 }], fragmentManifest: [] },
		});
		ok(structure?.promptStructure);
		const ids = [newCallId(), newCallId()];
		for (const callId of ids)
			lease.recordPromptCompiled?.(
				structure.promptStructure,
				{ layoutVersion: 4, tokenEstimate: 3, sections: 1 },
				{ ...lease.context, callId, attemptId: newAttemptId() },
			);
		await lease.release();
		await journals.closeAll();
		const lines = (await readFile(join(stateDir, "sessions", "cwd", "prompt-compiled", "calls.jsonl"), "utf8"))
			.split("\n")
			.filter((line) => line.includes('"prompt.compiled"'));
		strictEqual(lines.length, 1);
		ok(lines[0]?.includes(ids[0] as string));
	} finally {
		await rm(stateDir, { recursive: true, force: true });
	}
});

test("research capture keeps a request body and only allowlisted headers, and standard capture assembles neither (#434)", () => {
	const deep = capture("producer-capture-research", true);
	const standard = capture("producer-capture-standard");
	try {
		const target = {
			targetId: "t",
			runtimeId: "r",
			api: "a",
			requestedModel: "m",
			reportedModel: { kind: "unknown", reason: "not-observed" },
		} as const;
		const ctx = { sessionId: "producer-capture-research", label: "main" } as const;
		const call = beginCall({ label: "main", target, roundKind: "normal", toolChoice: "auto" }, ctx);
		call.observeResponse?.({
			status: 200,
			headers: { "X-Codex-Primary-Used-Percent": "12", "set-cookie": "session=secret", "x-request-id": "req_1" },
		});
		const scoped = call.withContext(() => telemetryContext());
		const sent = JSON.stringify({ model: "m", input: [{ role: "user", content: "hi" }] });
		researchCaptureFor(call, scoped)?.settle(sent);
		const [body] = deep.of("request.capture");
		deepStrictEqual(body?.preimage, { body: JSON.parse(sent) });
		deepStrictEqual(body.data, { bodyBytes: Buffer.byteLength(sent), truncated: false });
		const [headers] = deep.of("provider.headers");
		ok(headers && validPayload("provider.headers", headers.data), JSON.stringify(headers?.data));
		deepStrictEqual(headers.data, {
			status: 200,
			headers: { "x-codex-primary-used-percent": "12", "x-request-id": "req_1" },
		});
		const plain = beginCall(
			{ label: "main", target, roundKind: "normal", toolChoice: "auto" },
			{ sessionId: "producer-capture-standard", label: "main" },
		);
		strictEqual(
			researchCaptureFor(
				plain,
				plain.withContext(() => telemetryContext()),
			),
			undefined,
		);
		call.abandon("internal");
		plain.abandon("internal");
		strictEqual(standard.of("request.capture").length + standard.of("provider.headers").length, 0);
	} finally {
		deep.release();
		standard.release();
	}
});

test("an attempt whose stages never reached its send keeps no interrupted-call estimate or cold reasons (R2, L2)", () => {
	const call = beginCall(
		{
			label: "main",
			target: {
				targetId: "t",
				runtimeId: "r",
				api: "a",
				requestedModel: "m",
				reportedModel: { kind: "unknown", reason: "not-observed" },
			},
			roundKind: "normal",
			toolChoice: "auto",
		},
		{ sessionId: "unsent-estimate", label: "main" },
	);
	call.stage("admission", "start");
	const abandoned = abandonedSettlement(true, "operator_cancel");
	const settled = call.settle({
		...abandoned,
		cache: { ...abandoned.cache, expectedColdReasons: ["compaction"] },
		interruptedEstimate: {
			input: { kind: "estimated", value: 300_000, method: "prompt-side-only" },
			output: { kind: "estimated", value: 0, method: "chars/4" },
		},
	});
	strictEqual(settled?.disposition, "never_sent");
	strictEqual(settled?.interruptedEstimate, undefined, "never-sent is not spent");
	// The reasons describe the next request the provider sees; the turn runtime carries them to it.
	deepStrictEqual(settled?.cache.expectedColdReasons, []);
});
