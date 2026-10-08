/**
 * Observability facts whose writer and reader disagreed: the trace mirror read
 * the Clio tool frames at the wrong nesting level, an evidence build failure
 * was raised at a level the dispatch board never reads, and a failed or
 * aborted prewarm was read back as a zero-cost success.
 */
import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { subscribeExtensionObservations } from "../../src/domains/extensions/bus-observations.js";
import type { ExtensionObservationV2 } from "../../src/domains/extensions/public-api-v2.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
import type { OutOfTurnUsageRow } from "../../src/domains/observability/out-of-turn-usage.js";
import { appendOutOfTurnUsageRow, readOutOfTurnUsageRows } from "../../src/domains/observability/out-of-turn-usage.js";
import type { ProjectionReadModel } from "../../src/domains/observability/projection.js";
import { createObservabilityProjection } from "../../src/domains/observability/projection.js";
import {
	createDispatchTraceMirror,
	TRACE_WRITE_QUEUE_LIMIT,
	TraceReader,
	TraceStore,
} from "../../src/domains/observability/trace-store.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { createDispatchBoardView } from "../../src/interactive/dispatch-board.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-coder-observability-wiring-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

it("serializes schema creation when two cold writers wait on the same database", async () => {
	const path = join(scratch, "cold-writers.sqlite");
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	const lock = new DatabaseSync(path);
	lock.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE");
	const script = `
import { TraceStore } from ${JSON.stringify(pathToFileURL(resolve("src/domains/observability/trace-store.ts")).href)};
process.send("ready");
await new Promise(resolve => process.once("message", resolve));
new TraceStore(${JSON.stringify(path)}).close();
process.disconnect();`;
	const children = Array.from({ length: 2 }, () => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		return { child, ready: once(child, "message"), closed: once(child, "close"), stderr: () => stderr };
	});
	try {
		await Promise.all(children.map(({ ready }) => ready));
		for (const { child } of children) child.send("open");
		await delay(100);
		lock.exec("COMMIT");
		for (const { closed, stderr } of children) equal((await closed)[0], 0, stderr());
		const reader = new TraceReader(path);
		reader.close();
	} finally {
		for (const { child } of children) if (child.exitCode === null) child.kill();
		lock.close();
	}
});

it("persists database-wide queue loss and degradation without claiming complete coverage", async () => {
	const path = join(scratch, "capture-loss.sqlite");
	const warnings: string[] = [];
	const mirror = createDispatchTraceMirror(path, { warn: (message) => warnings.push(message) });
	mirror.enqueue("dispatch.enqueued", {
		runId: "run-loss",
		agentId: "coder",
		targetId: "local",
		wireModelId: "model",
		runtimeId: "fixture",
	});
	for (let i = 0; i < TRACE_WRITE_QUEUE_LIMIT + 6; i++)
		mirror.enqueue("dispatch.progress", { runId: "run-loss", agentId: "coder", event: { type: "log" } });
	await mirror.flush();
	const reader = new TraceReader(path);
	try {
		deepStrictEqual(reader.captureCoverage(), { status: "known_loss", droppedProgress: 7, droppedPackageActivity: null });
		match(warnings[0] ?? "", /dropped 7/);
		await mirror.flush();
		equal(reader.captureCoverage().droppedProgress, 7);
		mirror.enqueue("dispatch.progress", { runId: "missing", agentId: "coder", event: { type: "log" } });
		await mirror.flush();
		equal(reader.captureCoverage().status, "degraded");
		match(warnings[1] ?? "", /FOREIGN KEY/);
	} finally {
		reader.close();
		await mirror.close();
	}
	const reopened = new TraceReader(path);
	try {
		deepStrictEqual(reopened.captureCoverage(), { status: "degraded", droppedProgress: 7, droppedPackageActivity: null });
	} finally {
		reopened.close();
	}
});

it("counts package losses once per event in the same transaction across writer connections", () => {
	const path = join(scratch, "package-loss.sqlite");
	const first = new TraceStore(path);
	const second = new TraceStore(path);
	const reader = new TraceReader(path);
	const activity = {
		eventId: "package-loss",
		at: new Date().toISOString(),
		type: "clio_coder_extension_activity" as const,
		kind: "runtime_start",
		owner: { kind: "extension", id: "fixture", version: "1", digest: "fixture" },
		sessionId: "fixture",
		captureDroppedBefore: 3,
	};
	try {
		deepStrictEqual(reader.captureCoverage(), {
			status: "unreported",
			droppedProgress: null,
			droppedPackageActivity: null,
		});
		first.recordPackageActivity(activity);
		second.recordPackageActivity(activity);
		second.recordPackageActivity({ ...activity, eventId: "package-next", captureDroppedBefore: 4 });
		equal(reader.captureCoverage().droppedPackageActivity, 7);
		first.db.exec(
			"CREATE TRIGGER reject_activity BEFORE INSERT ON events WHEN NEW.event_id='rejected' BEGIN SELECT RAISE(ABORT, 'activity rejected'); END",
		);
		throws(
			() =>
				first.recordPackageActivity({ ...activity, eventId: "rejected", sessionId: "rejected", captureDroppedBefore: 10 }),
			/activity rejected/,
		);
		equal(reader.captureCoverage().droppedPackageActivity, 7);
		equal(reader.run("session-activity:rejected"), null);
	} finally {
		reader.close();
		first.close();
		second.close();
	}
});

describe("trace mirror tool rows", () => {
	const at = (second: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, second)).toISOString();

	/** Feed one run's progress events through the mirror, one second apart, and return its tool_call rows. */
	async function toolRows(runId: string, events: ReadonlyArray<Record<string, unknown>>) {
		const path = join(scratch, `${runId}.sqlite`);
		let second = 0;
		const mirror = createDispatchTraceMirror(path, { now: () => at(second), warn: () => {} });
		mirror.enqueue("dispatch.enqueued", {
			runId,
			agentId: "coder",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "fixture",
			runtimeKind: "http",
			requestOrigin: "internal",
		});
		for (const event of events) {
			second += 1;
			mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event });
		}
		await mirror.close();
		const reader = new TraceReader(path);
		try {
			return reader
				.events(runId)
				.filter((row) => row.type === "tool_call")
				.map((row) => ({
					startedAt: row.started_at,
					endedAt: row.ended_at,
					payload: JSON.parse(row.payload_json ?? "null") as Record<string, unknown>,
				}));
		} finally {
			reader.close();
		}
	}

	const clioStart = (toolCallId: string, tool: string) => ({
		type: "clio_coder_tool_start",
		payload: { tool, toolCallId, posture: "operating", startedAt: 0 },
	});
	const clioFinish = (toolCallId: string, tool: string, durationMs: number, outcome = "ok", reason?: string) => ({
		type: "clio_coder_tool_finish",
		payload: { tool, toolCallId, posture: "operating", durationMs, outcome, ...(reason === undefined ? {} : { reason }) },
	});

	it("persists an unfinished tool as an open span without a fabricated outcome", async () => {
		const rows = await toolRows("run-interrupted", [
			{ type: "tool_execution_start", toolCallId: "open", toolName: "read", args: { path: "src/a.ts" } },
			clioStart("open", "read"),
		]);
		equal(rows.length, 1);
		equal(rows[0]?.startedAt, at(1));
		equal(rows[0]?.endedAt, null);
		deepStrictEqual(rows[0]?.payload.args, { path: "src/a.ts" });
		equal(rows[0]?.payload.outcome, undefined);
		equal(rows[0]?.payload.ok, undefined);
	});

	it("delivers a settled span after the reader's start cursor without reopening it on a late start", async () => {
		const path = join(scratch, "run-cursor.sqlite");
		const runId = "run-cursor";
		const mirror = createDispatchTraceMirror(path);
		mirror.enqueue("dispatch.enqueued", {
			runId,
			agentId: "coder",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "fixture",
			runtimeKind: "http",
		});
		const start = { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.ts" } };
		mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event: start });
		mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event: clioStart("c1", "read") });
		mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event: { type: "log", level: "info" } });
		await mirror.flush();
		const reader = new TraceReader(path);
		try {
			const initial = reader.events(runId);
			const opened = initial.find((row) => row.type === "tool_call");
			ok(opened);
			equal(opened.ended_at, null);
			const cursor = initial.at(-1)?.rowid ?? 0;
			ok(cursor > opened.rowid, "the cursor has already advanced past the tool start");
			mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event: clioFinish("c1", "read", 40) });
			mirror.enqueue("dispatch.progress", {
				runId,
				agentId: "coder",
				event: { type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "file text", isError: false },
			});
			await mirror.flush();
			const updates = reader.events(runId, cursor);
			equal(updates.length, 1);
			const finished = updates[0];
			ok(finished);
			equal(finished.event_id, opened.event_id);
			ok(finished.rowid > cursor);
			ok(finished.ended_at);
			equal(JSON.parse(finished.payload_json ?? "null").result_snippet, "file text");
			mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event: start });
			await mirror.flush();
			deepStrictEqual(reader.events(runId, finished.rowid), []);
			deepStrictEqual(
				reader.events(runId).filter((row) => row.type === "tool_call"),
				[finished],
			);
		} finally {
			reader.close();
			await mirror.close();
		}
	});

	it("retains late producer facts and event cursors after terminal settlement", async () => {
		for (const [index, firstClio] of [true, false].entries()) {
			const runId = `run-settled-${index}`;
			const path = join(scratch, `${runId}.sqlite`);
			let second = 0;
			const warnings: string[] = [];
			const mirror = createDispatchTraceMirror(path, {
				now: () => at(second++),
				warn: (message) => warnings.push(message),
			});
			const identity = {
				runId,
				agentId: "coder",
				targetId: "local",
				wireModelId: "model",
				runtimeId: "fixture",
				runtimeKind: "http",
				contextWindow: 1000,
				gate: { role: "reviewer", cycle: 2 },
			};
			const progress = (event: Record<string, unknown>) =>
				mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event });
			mirror.enqueue("dispatch.enqueued", identity);
			mirror.enqueue("dispatch.started", { ...identity, pid: null });
			progress({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.ts" } });
			progress(clioStart("c1", "read"));
			const engineEnd = {
				type: "tool_execution_end",
				toolCallId: "c1",
				toolName: "read",
				result: "permission denied",
				isError: true,
			};
			const clioEnd = clioFinish("c1", "read", 40, "blocked", "execute permission denied");
			progress(firstClio ? clioEnd : engineEnd);
			progress({ type: "log", level: "info" });
			mirror.enqueue(index === 0 ? "dispatch.completed" : "dispatch.failed", {
				...identity,
				outcome: index === 0 ? "success" : "failure",
				outcomeDetail: null,
			});
			await mirror.flush();
			const reader = new TraceReader(path);
			try {
				const before = reader.events(runId);
				const cursor = before.at(-1)?.rowid ?? 0;
				const startedAt = before.find((row) => row.type === "tool_call")?.started_at;
				progress(firstClio ? engineEnd : clioEnd);
				progress({ type: "log", level: "info" });
				progress({
					type: "message_end",
					message: {
						role: "assistant",
						usage: { totalTokens: 10 },
						content: JSON.stringify({ verdict: "pass", checks: [{ name: "scope", passed: true, evidence: "checked" }] }),
					},
				});
				await mirror.flush();
				const updates = reader.events(runId, cursor);
				ok(updates.every((row) => row.rowid > cursor));
				const tool = updates.find((row) => row.type === "tool_call");
				ok(tool);
				equal(tool.started_at, startedAt);
				const facts = JSON.parse(tool.payload_json ?? "null");
				deepStrictEqual(facts.args, { path: "src/a.ts" });
				equal(facts.duration_ms, 40);
				equal(facts.result_snippet, "permission denied");
				equal(facts.ok, false);
				equal(facts.outcome, "blocked");
				equal(facts.block_reason, "execute permission denied");
				deepStrictEqual(
					reader
						.events(runId)
						.filter((row) => row.event_id.startsWith(`${runId}:event:`))
						.map((row) => row.event_id),
					[`${runId}:event:1`, `${runId}:event:2`, `${runId}:event:3`],
				);
				equal(reader.phases(runId)[0]?.context_window, 1000);
				equal(reader.gateResults(runId)[0]?.gate, "reviewer");
				progress({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "late.ts" } });
				await mirror.flush();
				deepStrictEqual(reader.events(runId, updates.at(-1)?.rowid ?? 0), []);
				deepStrictEqual(warnings, []);
			} finally {
				reader.close();
				await mirror.close();
			}
		}
	});

	it("gives a claude-sdk worker, which emits only the Clio frames, a row with its duration", async () => {
		const rows = await toolRows("run-claude", [
			clioStart("c1", "bash"),
			clioFinish("c1", "bash", 5, "blocked", "execute permission denied"),
		]);
		equal(rows.length, 1);
		const row = rows[0];
		ok(row);
		equal(row.payload.tool, "bash");
		equal(row.payload.tool_call_id, "c1");
		equal(row.payload.duration_ms, 5);
		equal(row.payload.ok, false);
		equal(row.payload.outcome, "blocked");
		equal(row.payload.block_reason, "execute permission denied");
		equal(row.startedAt, at(1));
		equal(row.endedAt, new Date(Date.parse(at(1)) + 5).toISOString());
	});

	it("merges a native worker's engine and Clio frames into one row with args, result and duration", async () => {
		const rows = await toolRows("run-native", [
			{ type: "tool_execution_start", toolCallId: "n1", toolName: "read", args: { path: "src/a.ts" } },
			clioStart("n1", "read"),
			clioFinish("n1", "read", 40),
			{ type: "tool_execution_end", toolCallId: "n1", toolName: "read", result: "file text", isError: false },
			{ type: "tool_execution_start", toolCallId: "n1", toolName: "read", args: { path: "late.ts" } },
		]);
		equal(rows.length, 1);
		const row = rows[0];
		ok(row);
		deepStrictEqual(row.payload.args, { path: "src/a.ts" });
		equal(row.payload.result_snippet, "file text");
		equal(row.payload.duration_ms, 40);
		equal(row.payload.ok, true);
		equal(row.payload.outcome, "ok");
		equal(row.payload.block_reason, null);
		equal(row.startedAt, at(1));
		equal(row.endedAt, new Date(Date.parse(at(1)) + 40).toISOString());
	});

	it("retains a native worker's blocked verdict across both finish orders", async () => {
		const engineFinish = {
			type: "tool_execution_end",
			toolCallId: "blocked-call",
			toolName: "bash",
			result: "permission denied",
			isError: true,
		};
		const clio = clioFinish("blocked-call", "bash", 3, "blocked", "execute permission denied");
		for (const [index, finishes] of [
			[clio, engineFinish],
			[engineFinish, clio],
		].entries()) {
			const rows = await toolRows(`run-blocked-${index}`, [
				{ type: "tool_execution_start", toolCallId: "blocked-call", toolName: "bash", args: { command: "pwd" } },
				clioStart("blocked-call", "bash"),
				...finishes,
			]);
			equal(rows.length, 1);
			equal(rows[0]?.payload.outcome, "blocked");
			equal(rows[0]?.payload.block_reason, "execute permission denied");
			equal(rows[0]?.payload.ok, false);
		}
	});

	it("keeps an ACP worker's engine-frame row and adds the Clio frame's duration", async () => {
		const rows = await toolRows("run-acp", [
			clioStart("a1", "read"),
			{ type: "tool_execution_start", toolCallId: "a1", toolName: "Read file", args: { path: "b.ts" } },
			{ type: "tool_execution_end", toolCallId: "a1", toolName: "Read file", result: "b text", isError: false },
			clioFinish("a1", "read", 25),
		]);
		equal(rows.length, 1);
		const row = rows[0];
		ok(row);
		equal(row.payload.tool, "Read file");
		deepStrictEqual(row.payload.args, { path: "b.ts" });
		equal(row.payload.result_snippet, "b text");
		equal(row.payload.duration_ms, 25);
		equal(row.startedAt, at(1));
		equal(row.endedAt, new Date(Date.parse(at(1)) + 25).toISOString());
	});
});

describe("compaction observations", () => {
	it("maps terminal outcomes and keeps unreported legacy outcomes unknown", () => {
		const bus = createSafeEventBus();
		const observations: ExtensionObservationV2[] = [];
		const unsubscribe = subscribeExtensionObservations(bus, (observation) => observations.push(observation));
		for (const outcome of ["completed", "unchanged", "failed", "cancelled", undefined] as const)
			bus.emit(BusChannels.CompactionEnd, { trigger: "force", at: 0, ...(outcome === undefined ? {} : { outcome }) });
		deepStrictEqual(
			observations.map((observation) => (observation.event === "compaction_end" ? observation.outcome : null)),
			["ok", "ok", "failed", "failed", "unknown"],
		);
		unsubscribe();
	});
});

describe("evidence build failure", () => {
	function readModel(): ProjectionReadModel {
		return {
			sessionCostSummary: () => emptyCostAggregate(),
			sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
			latestThroughput: () => null,
		};
	}

	it("reaches the dispatch board as a failed proof with its reason", () => {
		const projection = createObservabilityProjection(createSafeEventBus(), readModel());
		projection.evidenceBuildFailed("run-proof", "disk full while writing the bundle");
		const row: DispatchBoardRow = {
			runId: "run-proof",
			agentId: "coder",
			runtimeKind: "http",
			runtimeId: "fixture",
			targetId: "local",
			wireModelId: "model",
			status: "completed",
			elapsedMs: 0,
			tokenCount: 0,
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			ttftMs: null,
		};
		const board = createDispatchBoardView(
			() => [row],
			() => projection.snapshot(),
		);
		const text = board.render(120).map(stripTerminalSequences).join("\n");
		match(text, /proof\s+\S+ failed/u);
		match(text, /disk full while writing the bundle/u);
		projection.stop();
	});
});

describe("prewarm usage rows", () => {
	const row = (overrides: Partial<OutOfTurnUsageRow>): OutOfTurnUsageRow => ({
		label: "prewarm",
		repoIdentity: "repo-1",
		timestamp: "2026-09-25T12:00:00.000Z",
		target: "local",
		attributedModelId: "model",
		usage: {
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			reasoning: null,
			totalTokens: null,
			costUsd: null,
		},
		...overrides,
	});

	it("read back a failed or aborted prewarm as that outcome with unknown usage, not a zero-cost success", () => {
		const stateDir = join(scratch, "prewarm-state");
		appendOutOfTurnUsageRow(stateDir, row({ callOutcome: "error" }));
		appendOutOfTurnUsageRow(stateDir, row({ callOutcome: "aborted" }));
		appendOutOfTurnUsageRow(
			stateDir,
			row({
				callOutcome: "success",
				usage: {
					input: 12,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: null,
					totalTokens: 12,
					costUsd: 0,
				},
			}),
		);
		// Rows written before prewarm recorded an outcome stay readable as they were.
		const { callOutcome: _omitted, ...legacy } = row({
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 4,
				costUsd: 0,
			},
		});
		appendOutOfTurnUsageRow(stateDir, legacy);
		const read = readOutOfTurnUsageRows(stateDir);
		deepStrictEqual(read.errors, []);
		const [failed, aborted, succeeded, old] = read.rows;
		equal(failed?.callOutcome, "error");
		equal(failed?.usage.input, null);
		equal(failed?.usage.costUsd, null);
		equal(aborted?.callOutcome, "aborted");
		equal(aborted?.usage.totalTokens, null);
		equal(succeeded?.callOutcome, "success");
		equal(succeeded?.usage.input, 12);
		equal(succeeded?.usage.reasoning, null);
		equal(old?.callOutcome, undefined);
		equal(old?.usage.totalTokens, 4);
	});
});
