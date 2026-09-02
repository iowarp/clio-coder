import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { SafeEventBus } from "../../src/core/event-bus.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import {
	makeOpenAICompatRuntime,
	synthesizeOpenAICompatModel,
} from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { extractLocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import type { OverlayState } from "../../src/interactive/overlay-key-routing.js";
import { createOverlayModelSelectors } from "../../src/interactive/overlay-model-selectors.js";
import type { OpenModelScopeOverlayDeps } from "../../src/interactive/overlays/model-scope.js";
import { ModelOverlayView, type ModelRow } from "../../src/interactive/overlays/model-selector.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function completionResponse(text: string): Response {
	const chunks = [
		{ model: "wire-model", choices: [{ index: 0, delta: { content: text } }] },
		{
			model: "wire-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		},
	];
	const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function inertOverlayHandle(onHide?: () => void): OverlayHandle {
	return {
		hide: () => onHide?.(),
		setHidden: () => undefined,
		isHidden: () => false,
		focus: () => undefined,
		unfocus: () => undefined,
		isFocused: () => true,
	};
}

function selectableModelRow(): ModelRow {
	const caps = { ...EMPTY_CAPABILITIES, chat: true, tools: true };
	return {
		value: "next-target/next-model",
		target: "next-target",
		model: "next-model",
		runtimeName: "Contract runtime",
		runtimeShortName: "Contract",
		runtimeId: "contract-runtime",
		apiFamily: "openai-completions",
		bucket: "local",
		source: "configured",
		authText: "ready",
		available: true,
		reason: "",
		healthGlyph: "●",
		healthText: "healthy",
		caps,
		capabilityDecisions: {
			chat: true,
			tools: true,
			reasoning: false,
			vision: false,
			streaming: true,
			contextWindow: 32768,
			maxTokens: 8192,
		},
		thinking: "off",
		streaming: true,
		badges: "T",
		context: "32kctx",
		maxTokens: "8k",
		active: false,
		scoped: false,
		visibleByDefault: true,
		selectable: true,
	};
}

describe("provider transport boundary", () => {
	it("applies a model-picker selection after the scope confirmation", () => {
		const settings = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		settings.chat.target = "old-target";
		settings.chat.model = "old-model";
		const transitions: { state: OverlayState; handle: OverlayHandle | null } = { state: "closed", handle: null };
		const captured: { modelView?: ModelOverlayView; scopeDeps?: OpenModelScopeOverlayDeps } = {};
		const closeOverlay = (): void => {
			if (transitions.state === "closed") return;
			const handle = transitions.handle;
			transitions.state = "closed";
			transitions.handle = null;
			handle?.hide();
		};
		const selectors = createOverlayModelSelectors({
			tui: { requestRender: () => undefined } as TUI,
			transitions,
			providers: {} as ProvidersContract,
			bus: {} as SafeEventBus,
			refreshFooter: () => undefined,
			notify: () => undefined,
			closeOverlay,
			getSettings: () => settings,
			onSelectModel: (ref, scope) => {
				strictEqual(scope, "session");
				settings.chat.target = ref.target;
				settings.chat.model = ref.model;
			},
			openModelOverlay: (_tui, deps) => {
				captured.modelView = new ModelOverlayView(
					[selectableModelRow()],
					{ totalModels: 1, targets: 1, localModels: 1, cloudModels: 0, activeRef: "old-target/old-model" },
					deps.onSelect,
					deps.onToggleFavorite,
					deps.onClose,
				);
				return inertOverlayHandle(() => captured.modelView?.dispose());
			},
			openModelScopeOverlay: (_tui, deps) => {
				captured.scopeDeps = deps;
				return inertOverlayHandle();
			},
		});

		selectors.openModelOverlayState();
		strictEqual(transitions.state, "model");
		captured.modelView?.handleInput("\r");
		strictEqual(transitions.state, "model-scope", "Enter must leave the apply confirmation open");
		strictEqual(settings.chat.target, "old-target", "selection alone must not apply before confirmation");
		strictEqual(settings.chat.model, "old-model", "selection alone must not apply before confirmation");
		captured.scopeDeps?.onChoose("session");
		strictEqual(settings.chat.target, "next-target");
		strictEqual(settings.chat.model, "next-model");
	});

	it("selects canonical built-in runtimes and aliases without duplicating them", () => {
		const registry = createRuntimeRegistry();
		registerBuiltinRuntimes(registry);
		const canonical = registry.get("lmstudio");
		ok(canonical !== null);
		strictEqual(registry.get("lmstudio-native"), canonical);
		strictEqual(registry.list().filter((runtime) => runtime.id === "lmstudio").length, 1);
		strictEqual(registry.get("not-installed"), null);
	});

	it("projects only model quirks consumed by the engine", () => {
		deepStrictEqual(
			extractLocalModelQuirks({
				kvCache: { kQuant: "q8_0", vQuant: "q4_0" },
				sampling: {
					thinking: { temperature: 0.6, maxTokens: 32_768 },
					instruct: { topP: 0.9, maxTokens: 4_096 },
				},
				thinking: { mechanism: "on-off" },
			}),
			{
				sampling: {
					thinking: { temperature: 0.6 },
					instruct: { topP: 0.9 },
				},
				thinking: { mechanism: "on-off" },
			},
		);
	});

	it("sends one normalized OpenAI-compatible request and returns the streamed answer", async () => {
		const model = synthesizeOpenAICompatModel({
			target: {
				id: "local",
				runtime: "openai-compat",
				url: "http://localhost:1234/v1/",
				auth: { headers: { "X-Contract": "provider-wire" } },
			},
			wireModelId: "wire-model",
			kb: null,
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
			provider: "openai-compat",
		}) as Model<"openai-completions">;
		strictEqual(model.baseUrl, "http://localhost:1234/v1");

		let requestUrl = "";
		let payload: Record<string, unknown> | undefined;
		const events: AssistantMessageEvent[] = [];
		const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
		for await (const event of openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "test-key",
			onPayload: (value) => {
				payload = value as Record<string, unknown>;
				return undefined;
			},
			fetch: async (input) => {
				requestUrl = String(input);
				return completionResponse("wire-ok");
			},
		})) {
			events.push(event);
		}
		strictEqual(requestUrl, "http://localhost:1234/v1/chat/completions");
		strictEqual(payload?.model, "wire-model");
		ok(Array.isArray(payload?.messages));
		const done = events.find((event) => event.type === "done");
		ok(done?.type === "done");
		deepStrictEqual(done.message.content, [{ type: "text", text: "wire-ok" }]);
	});

	it("reports an unavailable probe instead of inventing a healthy target", async () => {
		const runtime = makeOpenAICompatRuntime({
			id: "contract-runtime",
			displayName: "Contract Runtime",
			provider: "contract",
			auth: "none",
			tier: "protocol",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
		});
		const result = await runtime.probe?.(
			{ id: "missing-url", runtime: runtime.id },
			{ credentialsPresent: new Set(), httpTimeoutMs: 100 },
		);
		strictEqual(result?.ok, false);
		ok((result?.error?.length ?? 0) > 0);
		strictEqual(result?.models, undefined);
	});

	it("loads a valid runtime plugin from a directory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "clio-runtime-plugin-"));
		temporaryDirectories.push(directory);
		writeFileSync(
			join(directory, "contract-plugin.js"),
			`export default {
				id: "contract-plugin", displayName: "Contract Plugin", kind: "http",
				apiFamily: "openai-completions", auth: "none",
				defaultCapabilities: { chat: true },
				synthesizeModel: (_target, wireModelId) => ({ id: wireModelId, provider: "contract-plugin" })
			};\n`,
			"utf8",
		);
		const registry = createRuntimeRegistry();
		deepStrictEqual(await registry.loadFromDir(directory), ["contract-plugin"]);
		const plugin = registry.get("contract-plugin");
		ok(plugin !== null);
		strictEqual(plugin.synthesizeModel({ id: "target", runtime: plugin.id }, "model", null).id, "model");
	});
});
