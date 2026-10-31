import type { LoadResult } from "../core/domain-loader.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import type { ConfigContract } from "../domains/config/contract.js";
import type { DispatchBundleOptions } from "../domains/dispatch/extension.js";
import { type ExtensionsContract, isLoadableExtension } from "../domains/extensions/index.js";
import type { MiddlewareContract } from "../domains/middleware/index.js";
import type { WorkerHookHost } from "../entry/worker-hook-host.js";
import type { WorkerExtensionHook } from "../worker/protocol.js";

/**
 * Extension tool hooks for the workers `fleet run`, `run --agent`,
 * `context wiki` and `context init` dispatch. `workerHooks` goes to the
 * dispatch domain at load; `start` runs once the domains are up and loads
 * the host only when a trusted, loadable api 2 extension is installed, so a
 * workspace with none pays nothing.
 * Until then, and without one, workers carry no hooks. `start` waits for the
 * host's runtimes and answers a refusal when the host failed to start while
 * a blocking tool hook applies, so a caller refuses before any worker is
 * dispatched instead of hearing of the failure after workers began. Once disposed, a
 * worker still running gets every hook query refused, not answered with no
 * hooks, so a call its hooks gate cannot pass while nothing runs them.
 */
export function createCliWorkerHooks(command: string): {
	workerHooks: NonNullable<DispatchBundleOptions["workerHooks"]>;
	start(loaded: LoadResult): Promise<string | null>;
	/** Settles once every hook query already handed to the host is answered. */
	drain(): Promise<void>;
	dispose(): Promise<void>;
} {
	let host: WorkerHookHost | null = null;
	let disposed = false;
	const inFlight = new Set<Promise<unknown>>();
	const notify = (line: string): void => {
		process.stderr.write(`clio-coder ${command}: ${line}\n`);
	};
	return {
		workerHooks: {
			declarations: () => host?.workerHooks.declarations() ?? [],
			dropped: () => host?.workerHooks.dropped() ?? [],
			evaluate: async (request, run) => {
				if (disposed) {
					const reason = `the ${command} extension host stopped; ${request.hookId} cannot run, so the call fails closed`;
					return request.point === "before_tool"
						? [{ kind: "block_tool", reason }]
						: [{ kind: "annotate_tool_result", message: reason, severity: "warn" }];
				}
				if (host === null) return [];
				const pending = host.workerHooks.evaluate(request, run);
				inFlight.add(pending);
				const settle = (): void => {
					inFlight.delete(pending);
				};
				pending.then(settle, settle);
				return pending;
			},
			notify,
		},
		async start(loaded) {
			const extensions = loaded.getContract<ExtensionsContract>("extensions");
			const middleware = loaded.getContract<MiddlewareContract>("middleware");
			const config = loaded.getContract<ConfigContract>("config");
			if (!extensions || !middleware) return null;
			const list = (cwd: string) =>
				extensions.list(cwd, { all: true }).filter((entry) => isLoadableExtension(entry) && entry.runtimeV2 !== undefined);
			const installed = list(process.cwd());
			if (installed.length === 0) return null;
			let failure: string;
			try {
				const { startWorkerHookHost } = await import("../entry/worker-hook-host.js");
				host = startWorkerHookHost({
					extensions,
					middleware,
					bus: telemetryHub(),
					list,
					notify,
					...(config ? { sandboxUnixSockets: () => config.get().safety.sandboxUnixSockets } : {}),
				});
				// The host already reported a runtime that failed through notify.
				const failed = workerHookStartupFailure(await host.ready);
				if (failed === null) return null;
				failure = failed;
			} catch (err) {
				failure = err instanceof Error ? err.message : String(err);
				notify(`extension host failed to start: ${failure}`);
			}
			const declared = await workerHookDeclarations(host, installed);
			if (declared === null)
				return `extension host failed to start (${failure}) and its tool hooks cannot be read; no worker is dispatched`;
			const gates = declared.filter((hook) => hook.onError === "block" || hook.onTimeout === "block");
			if (gates.length === 0) return null;
			const owners = [...new Set(gates.map((hook) => hook.id.split(":")[1] ?? hook.id))].join(", ");
			return `extension host failed to start (${failure}), so the blocking tool hooks of ${owners} cannot run; no worker is dispatched`;
		},
		async drain() {
			while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
		},
		async dispose() {
			disposed = true;
			const current = host;
			host = null;
			await current?.dispose();
		},
	};
}

/**
 * Why the host's startup reload failed, or null when every runtime started.
 * It is the rule `extension-host.ts` reports by: a rejected reload, one
 * committed "with errors" after retiring every process (it carries no
 * `degraded` count), and one whose runtimes failed to start.
 */
export function workerHookStartupFailure(ready: Awaited<WorkerHookHost["ready"]>): string | null {
	return ready.status === "rejected" || ready.degraded === undefined || ready.degraded > 0 ? ready.message : null;
}

/**
 * Every tool hook a worker would carry, those past the spec cap included:
 * the host's published generation together with the installed packages' own
 * declarations, since a host that failed may never have published one. Null
 * when the host never came up and the packages cannot be read either.
 */
async function workerHookDeclarations(
	host: WorkerHookHost | null,
	installed: ReturnType<ExtensionsContract["list"]>,
): Promise<ReadonlyArray<WorkerExtensionHook> | null> {
	const published = host === null ? [] : [...host.workerHooks.declarations(), ...host.workerHooks.dropped()];
	try {
		const { buildWorkerExtensionHooks } = await import("../entry/extension-runtime-hooks.js");
		const dropped: WorkerExtensionHook[] = [];
		const kept = buildWorkerExtensionHooks(installed, (hooks) => {
			dropped.push(...hooks);
		});
		return [...published, ...kept, ...dropped];
	} catch {
		// Unreadable packages leave only what the host published; with no host nothing is known, which the caller refuses.
		return host === null ? null : published;
	}
}
