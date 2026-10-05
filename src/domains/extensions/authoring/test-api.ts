import type {
	ExtensionHookEvent,
	ExtensionHookResult,
	ExtensionKeyValue,
	ExtensionObservationV2,
	ExtensionOutputV2,
	ExtensionToolResult,
	InterviewAnswer,
	InterviewNext,
} from "../public-api-v2.js";

export interface ExtensionTestHost {
	command(name: string, args?: string): Promise<ExtensionOutputV2>;
	observe(event: ExtensionObservationV2): Promise<ExtensionOutputV2 | undefined>;
	hook(event: ExtensionHookEvent, options?: { timeoutMs?: number }): Promise<ExtensionHookResult>;
	tool(name: string, input: unknown): Promise<ExtensionToolResult>;
	action(id: string, key?: string): Promise<ExtensionOutputV2>;
	interview(answer: InterviewAnswer): Promise<InterviewNext>;
	tick(): Promise<ExtensionOutputV2 | undefined>;
	readonly state: ExtensionKeyValue;
	readonly store: ExtensionKeyValue;
	readonly now: number;
	/** Advances Date in this host's handlers and delivers every due declared tick. Deadlines use real timers. */
	advance(ms: number): Promise<Array<ExtensionOutputV2 | undefined>>;
	dispose(): Promise<void>;
}

export interface ExtensionTestOptions {
	options?: Record<string, string | number | boolean>;
	sessionId?: string | null;
	workspace?: string;
}

/** Type-only public entrypoint; the running install supplies its implementation to tests. */
export declare function createExtensionTestHost(
	root: string,
	options?: ExtensionTestOptions,
): Promise<ExtensionTestHost>;
