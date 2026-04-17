/**
 * Phase 6 slice 7 diag. Exercises a faux tool call through the worker-side
 * AgentEvent stream.
 *
 * Registers a faux provider whose first response is an assistant message
 * carrying a toolCall content block (stopReason "toolUse") and whose second
 * response is a plain-text stopReason "stop" so the loop terminates after the
 * tool-result round-trip. Drives a pi-agent-core Agent in-process, subscribes
 * the same emit callback pattern the worker entry uses, and asserts the event
 * stream contains:
 *   - agent_start
 *   - a message_end whose assistant content carries a toolCall
 *   - tool_execution_start + tool_execution_end for that call
 *   - turn_end with at least one tool_result entry
 *   - agent_end as the final event
 *
 * There are no registered tools on the Agent, so pi-agent-core surfaces an
 * error tool result ("Tool X not found"). That still exercises the full tool
 * round-trip through the event stream — which is what this diag is for.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
	if (ok) {
		process.stdout.write(`[diag-worker-tools] OK   ${label}\n`);
		return;
	}
	failures.push(detail ? `${label}: ${detail}` : label);
	process.stderr.write(`[diag-worker-tools] FAIL ${label}${detail ? ` — ${detail}` : ""}\n`);
}

interface BasicEvent {
	type?: string;
	toolCallId?: string;
	toolName?: string;
	message?: { content?: Array<{ type?: string; name?: string; id?: string }> };
	toolResults?: unknown[];
}

async function main(): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "clio-diag-worker-tools-"));
	const ENV_KEYS = ["CLIO_HOME", "CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR", "CLIO_WORKER_FAUX"] as const;
	const snapshot = new Map<string, string | undefined>();
	for (const k of ENV_KEYS) snapshot.set(k, process.env[k]);
	for (const k of ["CLIO_DATA_DIR", "CLIO_CONFIG_DIR", "CLIO_CACHE_DIR", "CLIO_WORKER_FAUX"] as const) {
		delete process.env[k];
	}
	process.env.CLIO_HOME = home;

	try {
		const { resetXdgCache } = await import("../src/core/xdg.js");
		resetXdgCache();

		const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await import("../src/engine/ai.js");
		const { Agent } = await import("../src/engine/types.js");
		const { emitEvent } = await import("../src/worker/ndjson.js");

		check("engine:helpers-available", typeof registerFauxProvider === "function" && typeof fauxToolCall === "function");
		check("engine:emitEvent-available", typeof emitEvent === "function");

		const modelId = "faux-model-tools";
		const reg = registerFauxProvider({
			provider: "faux",
			models: [{ id: modelId }],
		});
		const toolCall = fauxToolCall("echo", { message: "hello" });
		reg.setResponses([
			fauxAssistantMessage([toolCall], { stopReason: "toolUse" }),
			fauxAssistantMessage("done", { stopReason: "stop" }),
		]);

		const model = reg.getModel(modelId);
		check("faux:model-registered", model !== undefined, `modelId=${modelId}`);
		if (!model) {
			return;
		}

		const collected: BasicEvent[] = [];
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are the diag-worker-tools faux agent.",
				model,
				thinkingLevel: "off",
				tools: [],
				messages: [],
			},
			getApiKey: async () => undefined,
		});
		const unsubscribe = agent.subscribe(async (event) => {
			const basic = event as BasicEvent;
			collected.push(basic);
		});
		// emitEvent is the same stdout NDJSON serializer the worker entry uses.
		// A single self-test call makes sure the import path stays wired.
		emitEvent({ diag: "worker-tools-ndjson-selftest", ok: true });

		await agent.prompt("invoke the echo tool");
		await agent.waitForIdle();
		unsubscribe();

		const types = collected.map((e) => e.type ?? "?");
		check("events:agent_start", types.includes("agent_start"), `types=${types.join(",")}`);
		check("events:agent_end-last", types[types.length - 1] === "agent_end", `last=${types[types.length - 1]}`);

		const messageEndWithToolCall = collected.find(
			(e) =>
				e.type === "message_end" &&
				Array.isArray(e.message?.content) &&
				e.message?.content?.some((c) => c.type === "toolCall" && c.name === "echo"),
		);
		check("events:assistant-message-carries-tool-call", messageEndWithToolCall !== undefined, `types=${types.join(",")}`);

		const toolStart = collected.find((e) => e.type === "tool_execution_start" && e.toolName === "echo");
		check("events:tool_execution_start", toolStart !== undefined, `types=${types.join(",")}`);

		const toolEnd = collected.find((e) => e.type === "tool_execution_end" && e.toolName === "echo");
		check("events:tool_execution_end", toolEnd !== undefined, `types=${types.join(",")}`);

		if (toolStart && toolEnd) {
			check(
				"events:tool-call-ids-match",
				typeof toolStart.toolCallId === "string" &&
					toolStart.toolCallId.length > 0 &&
					toolStart.toolCallId === toolEnd.toolCallId,
				`start=${toolStart.toolCallId} end=${toolEnd.toolCallId}`,
			);
		}

		const turnEndWithToolResults = collected.find(
			(e) => e.type === "turn_end" && Array.isArray(e.toolResults) && e.toolResults.length > 0,
		);
		check(
			"events:turn_end-carries-tool-results",
			turnEndWithToolResults !== undefined,
			`turn_end-events=${collected.filter((e) => e.type === "turn_end").length}`,
		);

		reg.unregister();
	} finally {
		for (const [k, v] of snapshot) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			if (existsSync(home)) rmSync(home, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}

	if (failures.length > 0) {
		process.stderr.write(`[diag-worker-tools] FAILED ${failures.length} check(s)\n`);
		process.exit(1);
	}
	process.stdout.write("[diag-worker-tools] PASS\n");
}

main().catch((err) => {
	process.stderr.write(`[diag-worker-tools] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
