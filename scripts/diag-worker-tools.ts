/**
 * Phase 6 slice 7 diag. Verifies that the worker-side tool registry wiring
 * actually resolves Clio ToolSpecs into pi-agent-core AgentTool instances,
 * then exercises a faux tool-call round-trip through the worker AgentEvent
 * stream for a representative subset of tool ids.
 *
 * The earlier revision of this diag asserted only that the event stream
 * plumbing worked with `tools: []` — which silently masked the wave-5 gap
 * where workers booted with zero tools regardless of recipe or mode. These
 * assertions pin the intersection + fallback + empty-set logging path so
 * regressions show up as diag failures rather than silent no-ops.
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
		const { resolveAgentTools } = await import("../src/engine/worker-tools.js");

		check("engine:helpers-available", typeof registerFauxProvider === "function" && typeof fauxToolCall === "function");
		check("engine:emitEvent-available", typeof emitEvent === "function");
		check("engine:resolveAgentTools-available", typeof resolveAgentTools === "function");

		// --- Tool resolution assertions -----------------------------------------

		const readOnly = resolveAgentTools(["read"], "default");
		check("resolve:read+default → 1 tool", readOnly.length === 1, `got ${readOnly.length}`);
		check("resolve:read+default → name 'read'", readOnly[0]?.name === "read", `got ${readOnly[0]?.name}`);

		const writeUnderAdvise = resolveAgentTools(["write"], "advise");
		check(
			"resolve:write+advise → empty (advise has no write)",
			writeUnderAdvise.length === 0,
			`got ${writeUnderAdvise.length}`,
		);

		const defaultFallback = resolveAgentTools(undefined, "default");
		const defaultNames = defaultFallback.map((t) => t.name).sort();
		const expectedDefault = [
			"read",
			"write",
			"edit",
			"bash",
			"grep",
			"glob",
			"ls",
			"web_fetch",
			"web_search",
			"dispatch_agent",
			"batch_dispatch",
			"chain_dispatch",
		].sort();
		check(
			"resolve:undefined+default → every default tool",
			defaultNames.length === expectedDefault.length && defaultNames.every((n, i) => n === expectedDefault[i]),
			`got ${defaultNames.join(",")}`,
		);

		const adviseFallback = resolveAgentTools(undefined, "advise");
		const adviseHasWritePlan = adviseFallback.some((t) => t.name === "write_plan");
		check(
			"resolve:undefined+advise includes write_plan",
			adviseHasWritePlan,
			`names=${adviseFallback.map((t) => t.name).join(",")}`,
		);
		const adviseHasBash = adviseFallback.some((t) => t.name === "bash");
		check("resolve:undefined+advise excludes bash", !adviseHasBash);

		const superFallback = resolveAgentTools(undefined, "super");
		const superHasBash = superFallback.some((t) => t.name === "bash");
		check("resolve:undefined+super includes bash", superHasBash);

		const intersection = resolveAgentTools(["read", "write", "bash"], "advise");
		check(
			"resolve:intersection with advise keeps only read",
			intersection.length === 1 && intersection[0]?.name === "read",
			`got ${intersection.map((t) => t.name).join(",")}`,
		);

		const emptyIntersection = resolveAgentTools(["bash", "edit"], "advise");
		check("resolve:empty intersection returns []", emptyIntersection.length === 0);

		// --- End-to-end AgentEvent round-trip with registered tools --------------

		const modelId = "faux-model-tools";
		const reg = registerFauxProvider({
			provider: "faux",
			models: [{ id: modelId }],
		});
		const toolCall = fauxToolCall("read", { path: "/tmp/clio-diag-worker-tools-sentinel" });
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
		const tools = resolveAgentTools(["read"], "default");
		const agent = new Agent({
			initialState: {
				systemPrompt: "You are the diag-worker-tools faux agent.",
				model,
				thinkingLevel: "off",
				tools,
				messages: [],
			},
			getApiKey: async () => undefined,
		});
		const unsubscribe = agent.subscribe(async (event) => {
			const basic = event as BasicEvent;
			collected.push(basic);
		});
		// Diag self-test of the NDJSON emitter — same serializer the worker entry uses.
		emitEvent({ diag: "worker-tools-ndjson-selftest", ok: true });

		await agent.prompt("invoke the read tool");
		await agent.waitForIdle();
		unsubscribe();

		const types = collected.map((e) => e.type ?? "?");
		check("events:agent_start", types.includes("agent_start"), `types=${types.join(",")}`);
		check("events:agent_end-last", types[types.length - 1] === "agent_end", `last=${types[types.length - 1]}`);

		const messageEndWithToolCall = collected.find(
			(e) =>
				e.type === "message_end" &&
				Array.isArray(e.message?.content) &&
				e.message?.content?.some((c) => c.type === "toolCall" && c.name === "read"),
		);
		check("events:assistant-message-carries-tool-call", messageEndWithToolCall !== undefined, `types=${types.join(",")}`);

		const toolStart = collected.find((e) => e.type === "tool_execution_start" && e.toolName === "read");
		check("events:tool_execution_start", toolStart !== undefined, `types=${types.join(",")}`);

		const toolEnd = collected.find((e) => e.type === "tool_execution_end" && e.toolName === "read");
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
