import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { defaultModelTier, type ModelRunInfo, runtimeModelInfo, snapshotModelInfo } from "../../src/core/model-tier.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/index.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { createProvidersBundle } from "../../src/domains/providers/extension.js";
import { resolveRuntimeTarget, runtimeTargetSnapshot } from "../../src/domains/providers/runtime-resolution.js";
import openAICompatRuntime from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import { createResourcesLoader } from "../../src/domains/resources/loader.js";
import {
	expandPromptTemplateInput,
	loadPromptTemplates,
	promptTemplateBody,
} from "../../src/domains/resources/prompts/loader.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { buildExtensionRuntimeHooks, evaluateWorkerHookRequest } from "../../src/entry/extension-runtime-hooks.js";
import { createRegistry } from "../../src/tools/registry.js";
import { parseWorkerHookRequest } from "../../src/worker/protocol.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SMALL: ModelRunInfo = {
	id: "qwen3-8b",
	target: "local",
	contextWindow: 32_768,
	thinkingLevel: "off",
	promptCaching: true,
	tier: "small",
};

describe("model tier", () => {
	it("the heuristic reads the window, the size hint and the catalog", () => {
		const tier = (modelId: string, contextWindow: number, runtimeTier?: string, inCatalog = false) =>
			defaultModelTier({ modelId, contextWindow, ...(runtimeTier ? { runtimeTier } : {}), inCatalog });
		strictEqual(tier("big-model", 16_384, "cloud", true), "small");
		strictEqual(tier("qwen3-8b", 0), "small");
		strictEqual(tier("Qwen2.5-Coder-1.5B", 0, "local-native"), "small");
		// The total count of a mixture-of-experts id, never its active experts.
		strictEqual(tier("nemotron-3.5-bolt-74b-a9b-24gb", 131_072), "standard");
		strictEqual(tier("gpt-oss-120b", 131_072, "cloud", true), "standard");
		strictEqual(tier("claude-opus-5-5", 200_000, "subscription", true), "frontier");
		strictEqual(tier("gpt-6-mini", 400_000, "cloud", true), "standard");
		strictEqual(tier("claude-opus-5-5", 200_000, "protocol", false), "standard");
		strictEqual(tier("mystery", 0, "local-native"), "standard");
	});

	it("an operator override beats the heuristic and rides the worker snapshot", async (t) => {
		const env = await isolateClioEnv("clio-coder-model-tier-");
		t.after(() => env.restore());
		const parsed = validateSettings({ version: 2, models: { "llama-3.1-8b": { tier: "frontier" } } });
		deepStrictEqual(parsed.issues, []);
		deepStrictEqual(parsed.settings.models, { "llama-3.1-8b": { tier: "frontier" } });
		const refused = validateSettings({ version: 2, models: { "llama-3.1-8b": { tier: "huge" } } });
		ok(refused.issues.some((issue) => issue.path === "models.llama-3.1-8b.tier"));

		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: "tier-heuristic", runtime: "openai-compat", url: "http://127.0.0.1:1", defaultModel: "qwen3-8b" },
			{ id: "tier-override", runtime: "openai-compat", url: "http://127.0.0.1:1", defaultModel: "llama-3.1-8b" },
		];
		settings.models = parsed.settings.models;
		const stub = dispatchStubContext({ settings, runtime: openAICompatRuntime }).getContract("providers");
		ok(stub);
		const real = createProvidersBundle(dispatchStubContext({ settings }), { getSettings: () => settings }).contract;
		const providers: ProvidersContract = {
			...stub,
			modelTierOverride: (id) => real.modelTierOverride?.(id) ?? null,
		};

		const heuristic = resolveRuntimeTarget(providers, { targetId: "tier-heuristic" });
		ok(heuristic.ok);
		strictEqual(heuristic.target.modelTier, "small");
		const override = resolveRuntimeTarget(providers, { targetId: "tier-override" });
		ok(override.ok);
		strictEqual(override.target.modelTier, "frontier");
		const snapshot = runtimeTargetSnapshot(override.target);
		strictEqual(snapshot.modelTier, "frontier");
		deepStrictEqual(snapshotModelInfo(snapshot), runtimeModelInfo(override.target));
		strictEqual(runtimeModelInfo(override.target).id, "llama-3.1-8b");
		strictEqual(runtimeModelInfo(override.target).target, "tier-override");
	});
});

describe("hook inputs carry the model", () => {
	it("tool hooks, api 2 events and a worker's call each see the model that runs", async (t) => {
		const env = await isolateClioEnv("clio-coder-model-hooks-");
		t.after(() => env.restore());
		const source = path.join(env.dir, "source");
		const workspace = path.join(env.dir, "workspace");
		mkdirSync(source);
		mkdirSync(workspace);
		writeFileSync(
			path.join(source, "clio-coder-extension.json"),
			JSON.stringify({
				id: "tiers",
				name: "Tiers",
				version: "1.0.0",
				description: "Reads the model a call runs on",
				runtime: {
					api: 2,
					entrypoint: "extension.mjs",
					hooks: [{ on: "before_tool", tools: ["read"], timeoutMs: 1000, onTimeout: "pass", onError: "pass" }],
				},
			}),
		);
		writeFileSync(path.join(source, "extension.mjs"), "export default () => {};\n");
		ok(installExtension(source, { cwd: workspace, scope: "user" }).extension?.loadable);
		const events: ExtensionHookEvent[] = [];
		const bridge = createExtensionRuntimeHookBridge();
		bridge.bind({
			hook: async (_id, event) => {
				events.push(event);
				return { kind: "ok", effects: [] };
			},
			notify: () => {},
		});
		const hooks = buildExtensionRuntimeHooks(listInstalledExtensions(workspace, { all: true }), bridge, {
			generation: 1,
			recordReceipt: () => {},
		});
		const inputs: MiddlewareHookInput[] = [];
		const middleware = createMiddlewareBundle({
			registrations: [
				...hooks.registrations,
				{
					id: "capture",
					description: "captures tool hook inputs",
					hooks: ["before_tool"],
					evaluate: (input) => {
						inputs.push(input);
						return [];
					},
				},
			],
		}).contract;
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: workspace }), middleware });
		registry.register({
			name: ToolNames.Read,
			description: "Read fixture",
			parameters: Type.Object({ path: Type.String() }),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "x" }),
		});
		const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: "a.md" } }, { model: SMALL });
		strictEqual(verdict.kind, "ok");
		deepStrictEqual(inputs[0]?.model, SMALL);
		strictEqual(inputs[0]?.modelId, "qwen3-8b");
		deepStrictEqual(events[0]?.model, SMALL);

		// A worker's call names the worker's own model, not the session's.
		const workerModel: ModelRunInfo = { ...SMALL, id: "gpt-6-luna", target: "openai-codex", tier: "frontier" };
		const request = parseWorkerHookRequest({
			requestId: "r1",
			hookId: "extension:tiers:before_tool:0",
			point: "before_tool",
			tool: "read",
			model: workerModel,
		});
		ok(request);
		strictEqual(parseWorkerHookRequest({ ...request, model: { ...workerModel, tier: "huge" } }), null);
		await evaluateWorkerHookRequest(
			request,
			hooks.workerEvaluators.get(request.hookId),
			undefined,
			{ runId: "run-1", sessionId: null },
			() => {},
		);
		deepStrictEqual(events[1]?.model, workerModel);
	});
});

describe("template variants", () => {
	it("a template renders its small variant for a small model and standard otherwise", async (t) => {
		const env = await isolateClioEnv("clio-coder-template-variants-");
		t.after(() => env.restore());
		const root = path.join(env.dir, "prompts");
		mkdirSync(path.join(root, "bodies"), { recursive: true });
		// A non-.md body file, so the prompt root does not load it as a template of its own.
		writeFileSync(path.join(root, "bodies", "plan.standard.txt"), "Plan $1 in your own way.\n");
		writeFileSync(
			path.join(root, "plan.md"),
			[
				"---",
				"description: Plan a section",
				"variants:",
				"  small: |",
				"    Plan $1 in three steps. Step 1: read the outline.",
				"  standard: { file: bodies/plan.standard.txt }",
				"---",
				"Plan $1.",
			].join("\n"),
		);
		writeFileSync(path.join(root, "plain.md"), "---\ndescription: No variants\n---\nJust $1.\n");
		const templates = loadPromptTemplates({ roots: [{ path: root, scope: "project", trusted: true }] });
		deepStrictEqual(templates.diagnostics, []);
		const expand = (line: string, tier?: "small" | "standard" | "frontier") =>
			expandPromptTemplateInput(line, templates, tier ? { tier } : {});

		const small = expand("/plan intro", "small");
		ok(small.expanded);
		strictEqual(small.text, "Plan intro in three steps. Step 1: read the outline.");
		strictEqual(small.variant, "small");
		const frontier = expand("/plan intro", "frontier");
		ok(frontier.expanded);
		strictEqual(frontier.text, "Plan intro in your own way.");
		strictEqual(frontier.variant, "standard");
		const unknown = expand("/plan intro");
		ok(unknown.expanded);
		strictEqual(unknown.text, "Plan intro in your own way.");
		const plain = expand("/plain intro", "small");
		ok(plain.expanded);
		strictEqual(plain.text, "Just intro.");
		strictEqual(plain.variant, undefined);
		deepStrictEqual(promptTemplateBody({ content: "main", variants: { small: "s" } }, "frontier"), { body: "main" });

		// Without a tier of its own, the resources loader follows the session's chat model.
		const project = path.join(env.dir, "project");
		mkdirSync(path.join(project, ".clio-coder", "prompts"), { recursive: true });
		writeFileSync(
			path.join(project, ".clio-coder", "prompts", "outline.md"),
			"---\nvariants:\n  small: Outline $1 step by step.\n---\nOutline $1.\n",
		);
		const loader = createResourcesLoader({ cwd: project, modelTier: () => "small" });
		const viaLoader = loader.expandPromptTemplate("/outline intro", project);
		ok(viaLoader.expanded);
		strictEqual(viaLoader.text, "Outline intro step by step.");
		const explicit = loader.expandPromptTemplate("/outline intro", project, { tier: "frontier" });
		ok(explicit.expanded);
		strictEqual(explicit.text, "Outline intro.");
	});
});
