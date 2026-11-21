import type { ExtensionHookOutcome } from "./operator-runtime-v2.js";
import { createPinnedContextStore, type PinnedContextPersistence, type PinnedContextStore } from "./pinned-context.js";
import type { ExtensionHookEvent, ExtensionToolResult, Interview } from "./public-api-v2.js";

/** What the operator answered in an interview a tool call asked for, step by step. */
export interface ParkedInterviewResult {
	outcome: "done" | "cancelled";
	answers: Record<string, Record<string, string | string[]>>;
	/** By step, then question id: text the operator attached to chosen options. */
	notes?: Record<string, Record<string, string>>;
	/** By step, then question id: answers that were free text naming no offered option. */
	other?: Record<string, Record<string, true>>;
	/** The extension's closing text when it finished, or why the interview ended. */
	text: string;
	/**
	 * Set when no operator could be asked, so the caller can tell an absent
	 * author from a refusal: `headless` when nobody could answer at all, and
	 * `unscripted` when a run's `--answers` file had no answer for a question.
	 */
	reason?: "headless" | "unscripted";
	/** By step: the answers file and, by question id, its entry that answered the step. */
	scripted?: Record<string, { file: string; rules: Record<string, string> }>;
	/** The checkpoint ids the interview's questions declared, in the order they were put to the author. */
	checkpoints?: string[];
	/** The handler finished the interview with `pipelineDone: true`: the step it gated was the pipeline's last. */
	pipelineDone?: true;
}

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
	/** A prompt passed the prompt gate and starts a turn; delivered as the `turn_start` observation. */
	observeTurnStart?(text: string): void;
	/** One call to a tool a running runtime serves. */
	tool?(extensionId: string, name: string, input: unknown, signal?: AbortSignal): Promise<ExtensionToolResult>;
	/** Run an interview a tool call asked for; the call stays parked until the operator finishes or cancels. */
	interview?(extensionId: string, interview: Interview, signal?: AbortSignal): Promise<ParkedInterviewResult>;
}

/**
 * The composition root publishes runtime hook registrations with the
 * extension generation, before any surface has started a runtime. The surface
 * that owns the runtimes binds itself here; until it does, and after it
 * unbinds, a hook reads as a runtime that is not running, so its `onError`
 * policy decides.
 */
export interface ExtensionRuntimeHookBridge extends PinnedContextStore {
	bind(executor: ExtensionRuntimeHookExecutor | null): void;
	current(): ExtensionRuntimeHookExecutor | null;
	/** The main session the hooks run in now; null in a worker's bridge or before a session exists. */
	sessionId(): string | null;
}

/**
 * The bridge also holds the session's pinned context blocks: the hooks that
 * set them and the turn that sends them share it, and only a main session has
 * one, so a dispatched worker never sees a block. With `pinned` the blocks
 * persist with the main session and come back when it is resumed.
 */
export function createExtensionRuntimeHookBridge(pinned?: PinnedContextPersistence): ExtensionRuntimeHookBridge {
	let executor: ExtensionRuntimeHookExecutor | null = null;
	return {
		...createPinnedContextStore(pinned),
		bind(next) {
			executor = next;
		},
		current: () => executor,
		sessionId: () => pinned?.sessionId() ?? null,
	};
}
