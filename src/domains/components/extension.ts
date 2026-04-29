import type { DomainBundle } from "../../core/domain-loader.js";
import type { ComponentsContract } from "./contract.js";
import { diffComponentSnapshots } from "./diff.js";
import { createComponentSnapshot, scanComponents } from "./scan.js";

export function createComponentsBundle(): DomainBundle<ComponentsContract> {
	const contract: ComponentsContract = {
		list(root) {
			return scanComponents(root);
		},
		snapshot(options) {
			return createComponentSnapshot(options);
		},
		diff(from, to) {
			return diffComponentSnapshots(from, to);
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
