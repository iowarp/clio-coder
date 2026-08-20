import type { DomainModule } from "../../core/domain-loader.js";
import { createConfigBundle } from "./extension.js";
import { ConfigManifest } from "./manifest.js";

export const ConfigDomainModule: DomainModule = {
	manifest: ConfigManifest,
	createExtension: createConfigBundle,
};

/** Bind the one strict startup snapshot without changing other command paths. */
export function createConfigDomainModule(
	initialSettings: Readonly<import("../../core/config.js").ClioSettings>,
): DomainModule {
	return {
		manifest: ConfigManifest,
		createExtension: (context) => createConfigBundle(context, initialSettings),
	};
}

export { assertAgentIdNamespace } from "./agent-namespace.js";
export { type ChangeKind, type ConfigDiff, diffSettings } from "./classify.js";
export type { ConfigContract } from "./contract.js";
export { ConfigManifest } from "./manifest.js";
