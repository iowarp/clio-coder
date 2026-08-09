import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { ProvidersContract, RuntimeDescriptor, TargetStatus } from "../../src/domains/providers/index.js";
import type { OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	createOverlayLifecycle,
	type OverlayLifecycleApplicationDeps,
	type OverlayLifecycleRuntimeDeps,
} from "../../src/interactive/overlay-lifecycle.js";
import type { AuthDialogHandle } from "../../src/interactive/overlays/auth-dialog.js";
import type { OpenProvidersOverlayOptions } from "../../src/interactive/providers-overlay.js";

type AuthCharacterizationDeps = OverlayLifecycleRuntimeDeps & {
	openAuthDialog?: (tui: TUI, title: string, onCancel: () => void) => AuthDialogHandle;
	openProvidersOverlay?: (
		tui: TUI,
		providers: ProvidersContract,
		options?: OpenProvidersOverlayOptions,
	) => OverlayHandle;
};

function runtimeDescriptor(auth: RuntimeDescriptor["auth"]): RuntimeDescriptor {
	return {
		id: "test-runtime",
		displayName: "Test Runtime",
		kind: "remote",
		tier: auth === "api-key" ? "cloud" : "local",
		apiFamily: "openai-completions",
		auth,
		defaultCapabilities: {
			chat: true,
			tools: true,
			reasoning: false,
			vision: false,
			audio: false,
			embeddings: false,
			rerank: false,
			fim: false,
			contextWindow: 8192,
			maxTokens: 2048,
		},
	} as unknown as RuntimeDescriptor;
}

function targetStatus(runtime: RuntimeDescriptor): TargetStatus {
	return {
		target: { id: "test-target", runtime: runtime.id },
		runtime,
		available: true,
		reason: "ready",
		health: { status: "healthy", latencyMs: 7, lastError: null },
	} as TargetStatus;
}

function makeLifecycle(auth: RuntimeDescriptor["auth"]): {
	lifecycle: ReturnType<typeof createOverlayLifecycle>;
	events: string[];
	connect: () => Promise<void>;
} {
	const events: string[] = [];
	const runtime = runtimeDescriptor(auth);
	const status = targetStatus(runtime);
	let connectTarget: OpenProvidersOverlayOptions["connectTarget"];

	const providers = {
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		probeTarget: async (id: string) => {
			events.push(`probe:${id}`);
			return status;
		},
		auth: {
			statusForTarget: () => ({
				providerId: runtime.id,
				available: auth !== "api-key",
				credentialType: null,
				source: auth === "api-key" ? "missing" : "not-required",
				detail: null,
			}),
			setApiKey: () => events.push("set-api-key"),
		},
	} as unknown as ProvidersContract;
	const app = {
		providers,
		getSettings: () =>
			({
				targets: [{ id: status.target.id, runtime: runtime.id }],
			}) as unknown as ClioSettings,
		bus: {
			on: () => () => {},
			emit: () => {},
		},
	} as unknown as OverlayLifecycleApplicationDeps;
	const providerHandle = { hide: () => events.push("hide:providers") } as unknown as OverlayHandle;
	const authHandle = { hide: () => events.push("hide:auth") } as unknown as OverlayHandle;
	const runtimeDeps = {
		app,
		tui: { requestRender: () => events.push("render") } as unknown as TUI,
		footer: { refresh: () => events.push("footer") },
		interactiveTickers: {
			stopDispatchBoardTicker: () => events.push("stop-board"),
			renderContextIsland: () => events.push("context-island"),
			renderTaskIsland: () => events.push("task-island"),
		},
		busNoticeSink: { appendReplayBlock: () => {}, requestRender: () => {} },
		chatRenderer: { applyEvent: () => {} },
		notify: (level: string, text: string, key?: string) => events.push(`notify:${level}:${text}:${key ?? ""}`),
		terminal: { columns: 100 },
		dispatchBoard: {},
		getObservabilitySnapshot: () => ({}),
		chatPanel: {},
		io: { stdout: () => {}, stderr: () => {} },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({}),
		openProvidersOverlay: (_tui: TUI, _providers: ProvidersContract, options?: OpenProvidersOverlayOptions) => {
			events.push("open:providers");
			connectTarget = options?.connectTarget;
			return providerHandle;
		},
		openAuthDialog: (_tui: TUI, title: string, _onCancel: () => void): AuthDialogHandle => {
			events.push(`open:auth:${title}`);
			return {
				handle: authHandle,
				controller: {
					setLines: (lines) => events.push(`lines:${lines.join("|")}`),
					appendLine: (line) => events.push(`append:${line}`),
					prompt: (label) => {
						events.push(`prompt:${label}`);
						return new Promise<string>(() => {});
					},
					cancel: () => events.push("cancel"),
					dismiss: () => events.push("dismiss"),
				},
			};
		},
	} as unknown as AuthCharacterizationDeps;
	const lifecycle = createOverlayLifecycle(runtimeDeps);
	lifecycle.openProvidersOverlayState();
	strictEqual(typeof connectTarget, "function");
	events.length = 0;
	return {
		lifecycle,
		events,
		connect: async () => {
			await connectTarget?.(status.target.id);
		},
	};
}

describe("contracts/interactive auth overlay lifecycle", () => {
	it("restores the providers overlay after a successful target probe in the established order", async () => {
		const { lifecycle, events, connect } = makeLifecycle("none");

		await connect();

		strictEqual(lifecycle.getState(), "providers");
		deepStrictEqual(events, [
			"open:auth:Connect test-target",
			"lines:Target: test-target|Runtime: test-runtime|Checking target...",
			"probe:test-target",
			"render",
			"lines:Target: test-target|Runtime: test-runtime|Target ready (healthy)|ready",
			"notify:info:connected test-target (healthy):connect:test-target",
			"footer",
			"render",
			"hide:auth",
			"footer",
			"context-island",
			"task-island",
			"render",
		]);
		lifecycle.dispose();
	});

	it("dismisses a pending API-key prompt before hiding auth and restoring providers", async () => {
		const { lifecycle, events, connect } = makeLifecycle("api-key");
		const connection = connect();
		strictEqual(lifecycle.getState(), "auth");

		lifecycle.closeOverlay();
		await connection;

		strictEqual(lifecycle.getState(), "providers");
		deepStrictEqual(events, [
			"open:auth:Connect test-target",
			"lines:Target: test-target|Runtime: test-runtime|API key required before Clio can connect to this target.",
			"prompt:API key",
			"render",
			"dismiss",
			"hide:auth",
			"footer",
			"context-island",
			"task-island",
			"render",
		]);
		lifecycle.dispose();
	});
});
