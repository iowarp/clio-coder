import type { ExtensionHookOutcome } from "./operator-runtime-v2.js";
import type { ExtensionHookEvent } from "./public-api-v2.js";

/** What the surface that owns api 2 runtimes offers the middleware registrations of their hooks. */
export interface ExtensionRuntimeHookExecutor {
	hook(
		extensionId: string,
		event: ExtensionHookEvent,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ExtensionHookOutcome>;
	/** One operator notice naming the extension, the event and the reason. */
	notify(message: string): void;
}

/**
 * The composition root publishes runtime hook registrations with the
 * extension generation, before any surface has started a runtime. The surface
 * that owns the runtimes binds itself here; until it does, and after it
 * unbinds, a hook reads as a runtime that is not running, so its `onError`
 * policy decides.
 */
export interface ExtensionRuntimeHookBridge {
	bind(executor: ExtensionRuntimeHookExecutor | null): void;
	current(): ExtensionRuntimeHookExecutor | null;
}

export function createExtensionRuntimeHookBridge(): ExtensionRuntimeHookBridge {
	let executor: ExtensionRuntimeHookExecutor | null = null;
	return {
		bind(next) {
			executor = next;
		},
		current: () => executor,
	};
}
