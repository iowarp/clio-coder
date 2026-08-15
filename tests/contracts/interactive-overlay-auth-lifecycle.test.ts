import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
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
import type { OpenSettingsOverlayDeps, SettingsOverlayHandle } from "../../src/interactive/overlays/settings.js";

type AuthCharacterizationDeps = OverlayLifecycleRuntimeDeps & {
	openAuthDialog?: (tui: TUI, title: string, onCancel: () => void) => AuthDialogHandle;
	openSettingsOverlay?: (tui: TUI, deps: OpenSettingsOverlayDeps) => SettingsOverlayHandle;
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

function makeLifecycle(
	auth: RuntimeDescriptor["auth"],
	options: { damage?: string; apiKeyAnswer?: string } = {},
): {
	lifecycle: ReturnType<typeof createOverlayLifecycle>;
	events: string[];
	connect: () => Promise<void>;
} {
	const events: string[] = [];
	const runtime = runtimeDescriptor(auth);
	const status = targetStatus(runtime);
	let connectTarget: OpenSettingsOverlayDeps["connectTarget"];

	const providers = {
		getRuntime: (id: string) => (id === runtime.id ? runtime : null),
		probeAllLive: async () => {},
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
			// The store records a refused write here instead of throwing, and keeps
			// serving the credential from memory afterwards.
			damageReason: () => options.damage ?? null,
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
		writeSettings: () => {},
	} as unknown as OverlayLifecycleApplicationDeps;
	const settingsHandle = {
		hide: () => events.push("hide:settings"),
		refreshRows: () => {},
	} as unknown as SettingsOverlayHandle;
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
		chatPanel: {},
		io: { stdout: () => {}, stderr: () => {} },
		readStructuredEntries: () => [],
		announceTaskMemorySeedOffer: () => {},
		keybindings: {},
		editor: { getText: () => "", setText: () => {} },
		getSlashContext: () => ({}),
		openSettingsOverlay: (_tui: TUI, deps: OpenSettingsOverlayDeps) => {
			events.push("open:settings");
			connectTarget = deps.connectTarget;
			return settingsHandle;
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
						return options.apiKeyAnswer === undefined ? new Promise<string>(() => {}) : Promise.resolve(options.apiKeyAnswer);
					},
					cancel: () => events.push("cancel"),
					dismiss: () => events.push("dismiss"),
				},
			};
		},
	} as unknown as AuthCharacterizationDeps;
	const lifecycle = createOverlayLifecycle(runtimeDeps);
	lifecycle.openSettingsOverlayState("targets");
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
	it("restores the settings overlay after a successful target probe in the established order", async () => {
		const { lifecycle, events, connect } = makeLifecycle("none");

		await connect();

		strictEqual(lifecycle.getState(), "settings");
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

	it("dismisses a pending API-key prompt before hiding auth and restoring settings", async () => {
		const { lifecycle, events, connect } = makeLifecycle("api-key");
		const connection = connect();
		strictEqual(lifecycle.getState(), "auth");

		lifecycle.closeOverlay();
		await connection;

		strictEqual(lifecycle.getState(), "settings");
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

	// `setApiKey` throws only for the damaged-store refusal. Every other write
	// failure is recorded in damageReason() while the in-memory store keeps
	// serving the key, so the probe that follows succeeded and the overlay
	// reported a connection that would be gone at the next start.
	it("does not probe or report a connection when the key never reached disk", async () => {
		const { lifecycle, events, connect } = makeLifecycle("api-key", {
			apiKeyAnswer: "sk-not-a-real-key",
			damage: "it could not be written: EACCES: permission denied",
		});

		await connect();

		ok(
			!events.some((event) => event.startsWith("probe:")),
			`a refused write must not be probed as a connection: ${events.join(", ")}`,
		);
		ok(
			!events.some((event) => event.startsWith("notify:info:connected")),
			`no connection is claimed: ${events.join(", ")}`,
		);
		const failure = events.find((event) => event.startsWith("notify:error:"));
		ok(failure?.includes("was not stored"), `the refusal is named: ${failure}`);
		ok(failure?.includes("EACCES"), `the reason is carried: ${failure}`);
		lifecycle.dispose();
	});

	// The guard is about a write that failed. A clean store still connects.
	it("probes and reports the connection when the key lands", async () => {
		const { lifecycle, events, connect } = makeLifecycle("api-key", { apiKeyAnswer: "sk-not-a-real-key" });

		await connect();

		ok(events.includes("probe:test-target"), `got: ${events.join(", ")}`);
		ok(
			events.some((event) => event.startsWith("notify:info:connected test-target")),
			`got: ${events.join(", ")}`,
		);
		lifecycle.dispose();
	});
});
