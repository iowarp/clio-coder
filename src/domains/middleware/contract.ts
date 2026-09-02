import type {
	MiddlewareRegistrationOwner,
	PrepareRegistrationReplacementResult,
	ReplaceRegistrationsReport,
} from "./registrations.js";
import type { MiddlewareDiagnosticSink, MiddlewareHookRegistration } from "./runtime.js";
import type {
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareHookResult,
	MiddlewareRule,
	MiddlewareSnapshot,
} from "./types.js";

export interface MiddlewareContract {
	runHook(input: MiddlewareHookInput): MiddlewareHookResult;
	/** Await the optional serialized phase after `runHook`; never used by tool admission. */
	runAsyncHook?(
		input: MiddlewareHookInput,
		priorEffects?: ReadonlyArray<MiddlewareEffect>,
	): Promise<MiddlewareHookResult>;
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
	/**
	 * Validate an owner's replacement registration set against the current
	 * builtin and host ids and build its evaluation list without publishing.
	 * Rejected when `generation` is not strictly greater than the owner's
	 * active generation. The returned replacement publishes with one reference
	 * assignment that cannot refuse or call out, so a composition root can publish it
	 * back-to-back with another domain's generation on the same stack.
	 */
	prepareRegistrationReplacement(
		owner: MiddlewareRegistrationOwner,
		generation: number,
		registrations: ReadonlyArray<MiddlewareHookRegistration>,
	): PrepareRegistrationReplacementResult;
	/** Prepare, check currentness, publish, then emit any conflict diagnostics. */
	replaceRegistrations(
		owner: MiddlewareRegistrationOwner,
		generation: number,
		registrations: ReadonlyArray<MiddlewareHookRegistration>,
	): ReplaceRegistrationsReport;
	/** Active generation for an owner; 0 when nothing was ever applied. */
	ownedGeneration(owner: MiddlewareRegistrationOwner): number;
}
