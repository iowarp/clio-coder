/**
 * Production wiring for the run event journal.
 *
 * `tests/contracts/run-event-journal.test.ts` exercises the writer, and
 * `dispatch-detach` exercises the display-tail tee inside
 * `createDispatchRunEventRegistry`. Neither reaches the wiring an operator
 * actually runs: `clio-coder run --agent`, `clio-coder fleet run`, and the TUI
 * `/run` slash command all take a handle straight off `DispatchContract.dispatch`
 * and iterate `handle.events` themselves, so no run event registry exists on
 * any of those paths and the sink attached inside that factory never fires.
 *
 * These tests drive the composed dispatch bundle instead of the factory, once
 * with a caller that owns the event stream (the three operator paths) and once
 * through `registerAllTools` (the model-facing dispatch tool, which does build
 * a registry). Both must produce one journal per run: an `open` line first, a
 * `terminal` line last, and no event line written twice.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { readRunEventJournal } from "../../src/domains/dispatch/run-event-journal.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { mutationReport } from "../harness/gate-fabric.js";

function okWorker(text = "journal wiring done"): SpawnedWorker {
	const events = (async function* () {
		yield { type: "clio_tool_finish", payload: { tool: "read", outcome: "ok" } };
		yield {
			type: "message_end",
			message: { role: "assistant", content: mutationReport(text), usage: { input: 1, output: 1 } },
		};
	})();
	return {
		pid: 400,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function toolRegistry() {
	return createRegistry({
		safety: {
			classify: () => ({ actionClass: "read", reasons: [] }),
			evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
			observeLoop: () => ({ looping: false, key: "test", count: 0 }),
			scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
			isSubset: () => true,
			audit: { recordCount: () => 0 },
		},
	});
}

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

const approvedDispatch = {
	approval: { requestId: "journal-wiring-approval", requestedBy: "test-operator", actionClass: "dispatch" as const },
};

describe("run event journal production wiring", () => {
	beforeEach(async () => {
		await isolateDispatchState();
	});

	after(() => {
		restoreDispatchState();
	});

	it("journals a run whose caller owns the event stream, as every operator dispatch path does", async () => {
		// Exactly the shape of src/cli/run.ts runDispatch, src/cli/fleet.ts
		// runFleet, and src/interactive/slash-commands.ts runAttributed: compose
		// the dispatch domain, dispatch, drain `handle.events` in the caller,
		// await the receipt. No DispatchRunEventRegistry anywhere.
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => okWorker(),
			journalRunEvents: true,
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({
				agentId: "coder",
				executionRole: "builder",
				task: "journal the operator dispatch path",
			});
			const seen: string[] = [];
			for await (const event of handle.events) {
				const type = (event as { type?: unknown }).type;
				if (typeof type === "string") seen.push(type);
			}
			const receipt = await handle.finalPromise;

			const journal = readRunEventJournal(handle.runId);
			ok(journal.present, `no journal at ${journal.path}; the operator dispatch path wrote nothing`);
			strictEqual(journal.lines[0]?.kind, "open", "the first line is the run open");
			strictEqual(journal.agentId, "coder");
			strictEqual(journal.lines.at(-1)?.kind, "terminal", "the terminal line is the last write");
			strictEqual(journal.terminal?.outcome, receipt.outcome);
			ok(
				journal.lines.some((line) => line.kind === "receipt"),
				"the sealed receipt facts are on the journal",
			);
			// The transcript is the same projection the monitor tail shows:
			// heartbeats and message_update increments never reach it.
			const journaled = journal.lines.filter((line) => line.kind === "event").map((line) => line.type);
			deepStrictEqual(
				journaled,
				seen.filter((type) => type !== "heartbeat" && type !== "message_update"),
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("journals a tool-path run exactly once through the bootstrap composition", async () => {
		// The model-facing dispatch tool is the one production path that does
		// build a registry (src/tools/bootstrap.ts). Both writers are live in
		// this process, so this is where a duplicate transcript would show up.
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => okWorker("tool path done"),
			journalRunEvents: true,
		});
		await bundle.extension.start();
		try {
			const registry = toolRegistry();
			registerAllTools(registry, {
				askUser: async () => ({ answers: [] }),
				dispatch: bundle.contract,
				getAgentSpecs: () => [],
			});
			const dispatchTool = registry.get(ToolNames.Dispatch as ToolName) as ToolSpec | undefined;
			ok(dispatchTool, "registerAllTools registered the dispatch tool");
			const result = (await dispatchTool.run(
				{ task: "journal the tool dispatch path", agent: "coder" },
				{ sessionId: "session-journal-wiring", ...approvedDispatch },
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const runs = result.details?.runs as Array<{ runId?: string }> | undefined;
			const runId = runs?.[0]?.runId;
			ok(typeof runId === "string" && runId.length > 0, "the tool reported a run id");

			const journal = readRunEventJournal(runId);
			ok(journal.present, `no journal at ${journal.path}; the tool dispatch path wrote nothing`);
			strictEqual(journal.lines.filter((line) => line.kind === "open").length, 1, "one open line, not two writers");
			strictEqual(journal.lines.at(-1)?.kind, "terminal");
			// The worker emits one clio_tool_finish and one message_end. Two live
			// writers over one file would put each on the transcript twice.
			const journaledTypes = journal.lines.filter((line) => line.kind === "event").map((line) => line.type);
			deepStrictEqual(
				journaledTypes.filter((type) => type === "clio_tool_finish" || type === "message_end"),
				["clio_tool_finish", "message_end"],
				"every worker event is journaled once",
			);
			strictEqual(
				journal.lines.filter((line) => line.kind === "terminal").length,
				1,
				"one terminal line, not one per writer",
			);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("keeps route warning text in the durable transcript fleet view reads", async () => {
		const context = dispatchStubContext();
		const bundle = makeDispatchBundle(context, {
			spawnWorker: () => okWorker(),
			journalRunEvents: true,
		});
		await bundle.extension.start();
		try {
			const warning = "target mini resolved without an advertised output-token limit";
			context.bus.emit(BusChannels.DispatchProgress, {
				runId: "route-warning-run",
				agentId: "coder",
				event: { type: "route_warning", level: "warning", message: warning },
			});
			context.bus.emit(BusChannels.DispatchFailed, {
				runId: "route-warning-run",
				agentId: "coder",
				targetId: "mini",
				wireModelId: "test-model",
				runtimeId: "llamacpp",
				runtimeKind: "http",
				outcome: "failed",
				outcomeDetail: "test terminal",
				reason: "failed",
			});

			const journal = readRunEventJournal("route-warning-run");
			const routeWarning = journal.lines.find((line) => line.kind === "event" && line.type === "route_warning");
			ok(routeWarning?.kind === "event");
			strictEqual(routeWarning.detail, warning);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
