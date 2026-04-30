import type { DomainBundle } from "../../core/domain-loader.js";
import type { MiddlewareContract } from "./contract.js";
import { listMiddlewareRules } from "./rules.js";
import { runMiddlewareHook } from "./runtime.js";
import { createMiddlewareSnapshot } from "./snapshot.js";

export function createMiddlewareBundle(): DomainBundle<MiddlewareContract> {
	const contract: MiddlewareContract = {
		runHook(input) {
			return runMiddlewareHook(input);
		},
		listRules() {
			return listMiddlewareRules();
		},
		snapshot() {
			return createMiddlewareSnapshot(listMiddlewareRules());
		},
	};
	return {
		extension: {
			start() {
				return undefined;
			},
		},
		contract,
	};
}
