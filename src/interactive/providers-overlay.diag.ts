import type { EndpointStatus, ProvidersContract } from "../domains/providers/index.js";
import { EMPTY_CAPABILITIES } from "../domains/providers/index.js";
import type { OverlayHandle, OverlayOptions, TUI } from "../engine/tui.js";
import { visibleWidth } from "../engine/tui.js";
import { CTRL_C_DOUBLE_TAP_MS, resolveCtrlCAction } from "./index.js";
import { formatProvidersOverlayLines, openProvidersOverlay } from "./providers-overlay.js";

const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
	if (condition) return;
	failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function createDeferred(): Deferred {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function createFakeTui(): TUI {
	const visible = { current: true };
	const handle: OverlayHandle = {
		hide: () => {
			visible.current = false;
		},
		setHidden: () => {},
		isHidden: () => !visible.current,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => visible.current,
	};
	return {
		requestRender: () => {},
		showOverlay: (_component: unknown, _options?: OverlayOptions) => handle,
	} as unknown as TUI;
}

function makeStatus(): EndpointStatus {
	return {
		endpoint: {
			id: "primary-endpoint",
			runtime: "llamacpp",
			url: "http://localhost:8011/v1/very/long/path",
		},
		runtime: {
			id: "llamacpp",
			displayName: "llama.cpp",
			kind: "http",
			apiFamily: "openai-completions",
			auth: "none",
			defaultCapabilities: EMPTY_CAPABILITIES,
			synthesizeModel: () => {
				throw new Error("fake");
			},
		},
		available: false,
		reason: "connection refused",
		health: {
			status: "down",
			lastCheckAt: "2026-04-17T00:00:00.000Z",
			lastError: "connection refused",
			latencyMs: null,
		},
		capabilities: EMPTY_CAPABILITIES,
		discoveredModels: [],
	};
}

async function main(): Promise<void> {
	check(
		"providers-overlay:ctrl-c-closes-overlay-first",
		resolveCtrlCAction({
			overlayState: "providers",
			streaming: false,
			editorText: "",
			lastCtrlCAt: 0,
			now: 1_000,
		}) === "close-overlay",
		String(
			resolveCtrlCAction({
				overlayState: "providers",
				streaming: false,
				editorText: "",
				lastCtrlCAt: 0,
				now: 1_000,
			}),
		),
	);
	check(
		"providers-overlay:ctrl-c-double-tap-escalates-to-shutdown",
		resolveCtrlCAction({
			overlayState: "closed",
			streaming: false,
			editorText: "",
			lastCtrlCAt: 1_000,
			now: 1_000 + CTRL_C_DOUBLE_TAP_MS - 1,
		}) === "shutdown",
		String(
			resolveCtrlCAction({
				overlayState: "closed",
				streaming: false,
				editorText: "",
				lastCtrlCAt: 1_000,
				now: 1_000 + CTRL_C_DOUBLE_TAP_MS - 1,
			}),
		),
	);

	const narrowLines = formatProvidersOverlayLines([makeStatus()], { contentWidth: 36 });
	check(
		"providers-overlay:narrow-lines-stay-at-overlay-width",
		narrowLines.every((line) => visibleWidth(line) === 40),
		narrowLines.join("\n"),
	);
	check(
		"providers-overlay:narrow-unhealthy-endpoint-skips-undefined-latency",
		!narrowLines.some((line) => line.includes("undefined ms")),
		narrowLines.join("\n"),
	);

	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	let nextId = 0;
	const timers = new Set<number>();
	globalThis.setInterval = ((_: () => void, _ms?: number) => {
		const id = ++nextId;
		timers.add(id);
		return id as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
		timers.delete(id as unknown as number);
	}) as typeof clearInterval;

	try {
		const live = createDeferred();
		let completeCalls = 0;
		const providers: ProvidersContract = {
			list: () => [],
			getEndpoint: () => null,
			getRuntime: () => null,
			probeAll: async () => {},
			probeAllLive: async () => {
				await live.promise;
			},
			probeEndpoint: async () => null,
			auth: {
				statusForTarget: () => ({
					providerId: "diag",
					available: false,
					credentialType: null,
					source: "none",
					detail: null,
				}),
				resolveForTarget: async () => ({
					providerId: "diag",
					available: false,
					credentialType: null,
					source: "none",
					detail: null,
				}),
				getStored: () => null,
				listStored: () => [],
				setApiKey: () => {},
				remove: () => {},
				login: async () => {},
				logout: () => {},
				getOAuthProviders: () => [],
				setRuntimeOverrideForTarget: () => {},
				clearRuntimeOverrideForTarget: () => {},
			},
			credentials: {
				hasKey: () => false,
				get: () => null,
				set: () => {},
				remove: () => {},
			},
			knowledgeBase: null,
		};

		const handle = openProvidersOverlay(createFakeTui(), providers, {
			onComplete: () => {
				completeCalls += 1;
			},
		});

		check("providers-overlay:loader-single-interval-while-open", timers.size === 1, String(timers.size));
		handle.hide();
		check("providers-overlay:loader-stops-on-hide", timers.size === 0, String(timers.size));

		live.resolve();
		await live.promise;
		await Promise.resolve();

		check("providers-overlay:hide-aborts-completion", completeCalls === 0, String(completeCalls));
	} finally {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	}

	if (failures.length > 0) {
		for (const failure of failures) {
			process.stderr.write(`[providers-overlay.diag] FAIL ${failure}\n`);
		}
		process.exit(1);
	}

	process.stdout.write("[providers-overlay.diag] PASS\n");
}

main().catch((err: unknown) => {
	process.stderr.write(`[providers-overlay.diag] crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
