import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { MiddlewareContract } from "../../src/domains/middleware/contract.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
	resolveRuntimeTarget,
	runtimeResolutionWarnings,
} from "../../src/domains/providers/index.js";
import lmstudio from "../../src/domains/providers/runtimes/local-native/lmstudio.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";
import { createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { type ChatNoticeEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { startGatewayThinkingFixture } from "../harness/gateway-thinking-fixture.js";

/**
 * Issue #268: a family's chat-template kwargs that LM Studio cannot carry are
 * announced once by runtime resolution instead of silently missing from the
 * wire. The same family on llama.cpp carries them and says nothing.
 */

function providersFor(runtimeId: "lmstudio" | "llamacpp"): ProvidersContract {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{
			id: "fleet",
			runtime: runtimeId,
			url: "http://127.0.0.1:1",
			defaultModel: "nvidia-nemotron-3.5-lightning-30b-a3b",
			wireModels: ["nvidia-nemotron-3.5-lightning-30b-a3b"],
		},
	];
	settings.fleet.default.target = "fleet";
	settings.fleet.default.model = "nvidia-nemotron-3.5-lightning-30b-a3b";
	const runtime: RuntimeDescriptor = {
		id: runtimeId,
		displayName: runtimeId,
		kind: "http",
		tier: "local-native",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, reasoning: true },
		synthesizeModel: () => ({ id: "nvidia-nemotron-3.5-lightning-30b-a3b", provider: runtimeId }) as never,
	};
	const stub = dispatchStubContext({ settings, runtime });
	const base = stub.getContract<ProvidersContract>("providers");
	if (!base) throw new Error("stub has no providers contract");
	return { ...base, knowledgeBase: new FileKnowledgeBase(join(process.cwd(), "src/domains/providers/models")) };
}

describe("contracts/chat-template kwargs the runtime cannot carry", () => {
	it("warns once on LM Studio, naming the keys and the family's own marker", () => {
		const resolved = resolveRuntimeTarget(providersFor("lmstudio"), {
			targetId: "fleet",
			wireModelId: "nvidia-nemotron-3.5-lightning-30b-a3b",
			requestedThinkingLevel: "off",
			use: "orchestrator",
		});
		ok(resolved.ok, JSON.stringify(resolved.diagnostics));
		const undeliverable = resolved.diagnostics.filter((entry) => entry.code === "chat-template-kwargs-undeliverable");
		strictEqual(undeliverable.length, 1);
		strictEqual(undeliverable[0]?.severity, "warning");
		const message = undeliverable[0]?.message ?? "";
		ok(message.includes("force_nonempty_content"), message);
		ok(message.includes("lmstudio"), message);
		ok(message.includes("marks them unsupported"), message);
		ok(runtimeResolutionWarnings(resolved.diagnostics).includes(message));
		deepStrictEqual(resolved.target.modelRuntime.request.undeliverableChatTemplateKwargs, {
			keys: ["force_nonempty_content"],
			declaredUnsupported: true,
		});
		strictEqual(resolved.target.modelRuntime.request.reasoningEffort, "none");
	});

	it("says nothing on llama.cpp, which carries the kwargs", () => {
		const resolved = resolveRuntimeTarget(providersFor("llamacpp"), {
			targetId: "fleet",
			wireModelId: "nvidia-nemotron-3.5-lightning-30b-a3b",
			requestedThinkingLevel: "off",
			use: "orchestrator",
		});
		ok(resolved.ok, JSON.stringify(resolved.diagnostics));
		strictEqual(
			resolved.diagnostics.some((entry) => entry.code === "chat-template-kwargs-undeliverable"),
			false,
		);
		strictEqual(resolved.target.modelRuntime.request.chatTemplateKwargs?.force_nonempty_content, true);
		strictEqual(resolved.target.modelRuntime.request.undeliverableChatTemplateKwargs, undefined);
	});
});

describe("template-option advisory presentation", () => {
	it("uses one brief footer advisory across repeated turns and retains detailed diagnostics", async () => {
		const fixture = await startGatewayThinkingFixture("lm-studio", "nvidia-nemotron-3.5-lightning-30b-a3b");
		const base = providersFor("lmstudio");
		const providers: ProvidersContract = {
			...base,
			getRuntime: () => lmstudio,
			list: () => base.list().map((status) => ({ ...status, runtime: lmstudio })),
		};
		const target = providers.getTarget("fleet");
		ok(target);
		target.url = fixture.url;
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = "fleet";
		settings.chat.model = fixture.modelId;
		settings.chat.prewarm = false;
		settings.chat.thinkingLevel = "off";
		const notices: ChatNoticeEvent[] = [];
		const loop = createChatLoop({
			getSettings: () => settings,
			providers,
			knownTargets: () => new Set(["fleet"]),
			toolRegistry: createWorkerToolRegistry(),
			middleware: {
				registerHook() {},
				runHook: () => ({ effects: [], ruleIds: [] }),
			} as unknown as MiddlewareContract,
		});
		loop.onEvent((event) => {
			if (event.type === "notice") notices.push(event);
		});
		try {
			await loop.submit("Hello");
			await loop.submit("Hello again");
			const advisory = notices.filter((entry) => entry.text.includes("custom template options"));
			strictEqual(advisory.length, 1);
			strictEqual(advisory[0]?.surface, "footer");
			strictEqual(advisory[0]?.level, "info");
			strictEqual(advisory[0]?.text, "lmstudio ignores custom template options; continuing.");
			strictEqual(
				notices.some((entry) => entry.surface === "transcript" && entry.text.includes("chat-template kwargs")),
				false,
			);
			strictEqual(fixture.requests.length, 2);
		} finally {
			loop.dispose();
			await fixture.close();
		}
	});
});
