import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ToolRegistry } from "../tools/registry.js";
import { classifyChange } from "./classifier.js";
import { executeRestart } from "./restart.js";
import { HarnessState } from "./state.js";
import { reloadToolFile } from "./tool-reloader.js";
import { watchRepo } from "./watcher.js";

export interface HarnessDeps {
	repoRoot: string;
	cacheRoot: string;
	toolRegistry: ToolRegistry;
	bus: SafeEventBus;
	allowedModesByName: ReadonlyMap<string, ReadonlyArray<string>>;
	getSessionId?: () => string | null;
	shutdown?: (code?: number) => Promise<void>;
}

export interface HarnessHandle {
	state: HarnessState;
	restart(): Promise<void>;
	stop(): void;
}

/**
 * Compose watcher, classifier, reloader, and restart state for the current
 * orchestrator process. Emits bus events for every transition; callers wire
 * the state snapshot into the footer and the restart keystroke.
 */
export function startHarness(deps: HarnessDeps): HarnessHandle {
	const state = new HarnessState({ now: () => Date.now() });
	const sessionIdProvider = deps.getSessionId ?? (() => null);

	deps.bus.emit(BusChannels.HarnessWatcherStarted, { root: deps.repoRoot });

	const watch = watchRepo(deps.repoRoot, async (event) => {
		const verdict = classifyChange(event.path, deps.repoRoot);
		deps.bus.emit(BusChannels.HarnessFileChanged, { path: event.path, class: verdict.class });

		if (verdict.class === "ignore") return;
		if (verdict.class === "restart") {
			state.restartRequired(event.path, verdict.reason);
			deps.bus.emit(BusChannels.HarnessRestartRequired, { paths: [event.path], reason: verdict.reason });
			return;
		}
		if (verdict.class === "worker-next-dispatch") {
			state.workerChanged(event.path);
			return;
		}

		const result = await reloadToolFile(event.path, deps.cacheRoot, deps.toolRegistry, deps.allowedModesByName);
		if (result.kind === "ok") {
			state.hotSucceeded(event.path, result.elapsedMs);
			deps.bus.emit(BusChannels.HarnessHotreloadSucceeded, { path: event.path, elapsedMs: result.elapsedMs });
		} else {
			state.hotFailed(event.path, result.error);
			deps.bus.emit(BusChannels.HarnessHotreloadFailed, { path: event.path, error: result.error });
		}
	});

	return {
		state,
		async restart(): Promise<void> {
			const sessionId = sessionIdProvider();
			deps.bus.emit(BusChannels.HarnessRestartTriggered, { sessionId });
			if (!deps.shutdown) {
				throw new Error("harness: shutdown hook not provided; cannot restart");
			}
			await executeRestart({ sessionId, shutdown: deps.shutdown });
		},
		stop(): void {
			watch.close();
		},
	};
}
