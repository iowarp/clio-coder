import assert from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { DispatchRequest } from "../../src/domains/dispatch/index.js";
import {
	chooseSecondOpinionRoute,
	modelLineage,
	secondOpinionIndependence,
} from "../../src/domains/providers/model-lineage.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";

test("model ids resolve to their training family through gateway prefixes and aliases", () => {
	const cases: Array<[string, string]> = [
		["mini/qwen3.8-27b-iq4r-v4", "alibaba"],
		["openrouter/qwen/qwen3-coder", "alibaba"],
		["claude-sonnet-4-5", "anthropic"],
		["bedrock/us.anthropic.claude-opus-4", "anthropic"],
		["gpt-5-codex", "openai"],
		["o3-mini", "openai"],
		["gemma-3-27b-it", "google"],
		["meta-llama/Llama-3.3-70B-Instruct", "meta"],
		["ollama/llama3.1", "meta"],
		["devstral-small", "mistral"],
		["deepseek-r1-distill-qwen-32b", "deepseek"],
		["z-ai/glm-4.6", "zhipu"],
		["smart", "unknown"],
		["", "unknown"],
	];
	for (const [id, lineage] of cases) assert.equal(modelLineage(id), lineage, id);
	assert.equal(secondOpinionIndependence("mini/qwen3.8-27b", "qwen3-coder"), "same-lineage");
	assert.equal(secondOpinionIndependence("mini/qwen3.8-27b", "gemma-3-27b"), "independent");
	assert.equal(secondOpinionIndependence("mini/qwen3.8-27b", "smart"), "unknown");
});

test("a second opinion takes a reachable model of another family, never one of the main family", () => {
	const main = { target: "gw", model: "qwen3-27b" };
	const route = chooseSecondOpinionRoute(main, [
		{ target: "gw", model: "qwen3-coder", health: "healthy", available: true },
		{ target: "down", model: "claude-sonnet-4-5", health: "down", available: true },
		{ target: "gw", model: "gemma-3-27b", health: "healthy", available: true },
		{ target: "other", model: "gpt-5", health: "healthy", available: true },
		{ target: "alias", model: "smart", health: "healthy", available: true },
	]);
	assert.deepEqual(route, { target: "other", model: "gpt-5", lineage: "openai", mainLineage: "alibaba" });
	assert.equal(
		chooseSecondOpinionRoute(main, [{ target: "gw", model: "qwq-32b", health: "healthy", available: true }]),
		null,
	);
	assert.equal(chooseSecondOpinionRoute({ target: "gw", model: "smart" }, []), null);
});

const ANSWER = {
	verdict: "Keep the lexer",
	challenge: "The parser tests are thin",
	changesMyMind: "A failing parser test",
	citedDecisions: [],
};

function oracleHost(options: { refusePinned?: boolean; profiles?: Record<string, string>; chatModel: string }): {
	host: AcpCommandHost;
	requests: DispatchRequest[];
	notes: string[];
} {
	const requests: DispatchRequest[] = [];
	const notes: string[] = [];
	const dispatch = {
		ownsProgressBus: () => true,
		dispatch: async (request: DispatchRequest) => {
			requests.push(request);
			if (options.refusePinned && request.target !== undefined) throw new Error("route not admitted");
			const model = request.model ?? "qwen3-coder";
			return {
				runId: `oracle-${requests.length}`,
				events: (async function* () {})(),
				finalPromise: Promise.resolve({
					runId: `oracle-${requests.length}`,
					outcome: "succeeded",
					targetId: request.target ?? "gw",
					wireModelId: model,
					output: { text: JSON.stringify(ANSWER), state: "final", truncated: false },
				}),
			};
		},
	} as unknown as AcpCommandHost["dispatch"];
	const status = (id: string, defaultModel: string, wireModels: string[] = []) => ({
		target: { id, runtime: "openai-compat", defaultModel, wireModels },
		runtime: null,
		available: true,
		reason: "",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: {},
	});
	const providers = {
		list: () => [status("gw", "qwen3-27b", ["qwen3-coder"]), status("gw2", "gemma-3-27b")],
		getTarget: () => null,
	} as unknown as AcpCommandHost["providers"];
	const host: AcpCommandHost = {
		dispatch,
		bus: createTelemetryHub(),
		providers,
		submitOperatorNote: (text) => notes.push(text),
		isTurnInFlight: () => false,
		oracleBriefing: () => ({ decisions: [], tasks: [], compactionSummary: null }),
		getChatTarget: () => "gw",
		getChatModel: () => options.chatModel,
		getFleetAgentProfiles: () => options.profiles ?? {},
	};
	return { host, requests, notes };
}

test("/oracle asks a model of another family than the live chat model and says how independent it was", async () => {
	const pinned = oracleHost({ chatModel: "qwen3-27b" });
	const result = await acpCommandControl(pinned.host).invoke({ command: "oracle", argv: ["Keep the lexer?"] });
	assert.notEqual(result.level, "error", result.lines.join("\n"));
	assert.equal(pinned.requests[0]?.target, "gw2");
	assert.equal(pinned.requests[0]?.model, "gemma-3-27b");
	assert.match(pinned.notes[0] ?? "", /gw2\/gemma-3-27b, a different model family/);

	// The live model decides: after a /model switch to gemma the advisor must be a qwen.
	const switched = oracleHost({ chatModel: "gemma-3-27b" });
	await acpCommandControl(switched.host).invoke({ command: "oracle", argv: ["Keep the lexer?"] });
	assert.equal(switched.requests[0]?.target, "gw");
	assert.match(switched.requests[0]?.model ?? "", /^qwen3/);

	const bound = oracleHost({ chatModel: "qwen3-27b", profiles: { oracle: "local" } });
	await acpCommandControl(bound.host).invoke({ command: "oracle", argv: ["Keep the lexer?"] });
	assert.equal(bound.requests[0]?.target, undefined, "an operator binding is kept");
	assert.match(bound.notes[0] ?? "", /same model family as the main model; its agreement is weak/);

	const refused = oracleHost({ chatModel: "qwen3-27b", refusePinned: true });
	const fallback = await acpCommandControl(refused.host).invoke({ command: "oracle", argv: ["Keep the lexer?"] });
	assert.equal(refused.requests.length, 2);
	assert.equal(refused.requests[1]?.target, undefined);
	assert.match(fallback.lines.join("\n"), /could not use gw2\/gemma-3-27b/);
	assert.equal(refused.notes.length, 1, "a refused pin still yields an answer");
});
