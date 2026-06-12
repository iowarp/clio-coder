import type { MiddlewareDiagnosticSink, MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareHookInput, MiddlewareHookResult, MiddlewareRule, MiddlewareSnapshot } from "./types.js";

export interface MiddlewareContract {
	runHook(input: MiddlewareHookInput): MiddlewareHookResult;
	listRules(): ReadonlyArray<MiddlewareRule>;
	snapshot(): MiddlewareSnapshot;
	/**
	 * Append a coded hook registration after every existing rule and
	 * registration. The composition root calls this for guards that need
	 * runtime dependencies (bus, clocks) the domain loader cannot supply at
	 * bundle construction. Ids share one namespace with rule ids; a colliding
	 * registration is dropped, first entry wins, matching bundle semantics.
	 */
	registerHook(registration: MiddlewareHookRegistration): void;
	/**
	 * Replace the diagnostic sink for hook isolation/budget reports. Exists
	 * for the same reason as registerHook: the domain loader constructs the
	 * bundle before the composition root can supply the bus-emitting sink
	 * (Q1, `middleware.hookFailed`). Until called, diagnostics go to the
	 * stderr writer default.
	 */
	setDiagnosticSink(sink: MiddlewareDiagnosticSink): void;
}
