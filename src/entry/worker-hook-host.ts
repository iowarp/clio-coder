import type { TelemetryHub } from "../core/telemetry/hub.js";
import { createExtensionRuntimeHookBridge, type ExtensionsContract } from "../domains/extensions/index.js";
import type { MiddlewareContract } from "../domains/middleware/index.js";
import { type ExtensionHost, type ExtensionHostOptions, startExtensionHost } from "./extension-host.js";
import { createExtensionReloadCoordinator, extensionHookReceiptSink, hookReceiptLog } from "./extension-reload.js";

export interface WorkerHookHostOptions {
	extensions: ExtensionsContract;
	middleware: MiddlewareContract;
	bus: TelemetryHub;
	/** The installed packages the host may start: loadable, with an api 2 runtime. */
	list: ExtensionHostOptions["list"];
	notify: (line: string) => void;
	sandboxUnixSockets?: ExtensionHostOptions["sandboxUnixSockets"];
}

export interface WorkerHookHost {
	readonly workerHooks: ReturnType<typeof createExtensionReloadCoordinator>["workerHooks"];
	/** Settles once the startup generation has started its runtimes. */
	readonly ready: ExtensionHost["ready"];
	dispose(): Promise<void>;
}

/**
 * The api 2 extension host of a command that dispatches workers but runs no
 * main session, `clio-coder fleet run` and `clio-coder run --agent`. It
 * publishes the hook generation the way a session's boot does and starts the
 * same headless host `clio-coder run` uses, so a worker these commands
 * dispatch carries the session's tool hooks and its held calls are answered
 * here. With no main turn the host is always idle, and its runtimes see a
 * headless session with no id.
 */
export function startWorkerHookHost(options: WorkerHookHostOptions): WorkerHookHost {
	const runtimeHooks = createExtensionRuntimeHookBridge();
	const receipts = hookReceiptLog();
	const reload = createExtensionReloadCoordinator({
		extensions: options.extensions,
		middleware: options.middleware,
		runtimeHooks,
		cwd: () => process.cwd(),
		recordReceipt: extensionHookReceiptSink(receipts, () => undefined),
		report: options.notify,
	});
	reload.applyBoot();
	const host = startExtensionHost({
		mode: "headless",
		list: options.list,
		runtimeHooks,
		bus: options.bus,
		chat: { isStreaming: () => false, turnPreparation: () => ({ phase: "idle", since: 0 }), onEvent: () => () => {} },
		sessionId: () => null,
		targetId: () => "",
		notify: options.notify,
		...(options.sandboxUnixSockets ? { sandboxUnixSockets: options.sandboxUnixSockets } : {}),
	});
	return {
		workerHooks: reload.workerHooks,
		ready: host.ready,
		async dispose() {
			// A run that ends before startup settles would otherwise report its runtimes' staging as a failed reload.
			await host.ready.catch(() => undefined);
			await host.dispose();
			receipts.flush();
		},
	};
}
