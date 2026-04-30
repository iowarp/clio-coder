import type { MiddlewareHookInput, MiddlewareHookResult, MiddlewareRule, MiddlewareSnapshot } from "./types.js";

export interface MiddlewareContract {
	runHook(input: MiddlewareHookInput): MiddlewareHookResult;
	listRules(): ReadonlyArray<MiddlewareRule>;
	snapshot(): MiddlewareSnapshot;
}
