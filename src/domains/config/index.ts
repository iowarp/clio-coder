import type { DomainModule } from "../../core/domain-loader.js";
import { type ConfigBundleOptions, createConfigBundle } from "./extension.js";
import { ConfigManifest } from "./manifest.js";

export const ConfigDomainModule: DomainModule = {
	manifest: ConfigManifest,
	createExtension: (context) => createConfigBundle(context),
};

/** Bind the one strict startup snapshot without changing other command paths. */
export function createConfigDomainModule(
	initialSettings: Readonly<import("../../core/config.js").ClioSettings>,
	options: ConfigBundleOptions = {},
): DomainModule {
	return {
		manifest: ConfigManifest,
		createExtension: (context) => createConfigBundle(context, initialSettings, options),
	};
}

export { assertAgentIdNamespace } from "./agent-namespace.js";
export { type ChangeKind, type ConfigDiff, diffSettings } from "./classify.js";
export type { ConfigContract } from "./contract.js";
export { ConfigManifest } from "./manifest.js";
