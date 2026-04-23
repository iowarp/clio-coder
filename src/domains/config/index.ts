import type { DomainModule } from "../../core/domain-loader.js";
import { createConfigBundle } from "./extension.js";
import { ConfigManifest } from "./manifest.js";

export const ConfigDomainModule: DomainModule = {
	manifest: ConfigManifest,
	createExtension: createConfigBundle,
};

export { type ChangeKind, type ConfigDiff, diffSettings } from "./classify.js";
export type { ConfigContract } from "./contract.js";
export { ConfigManifest } from "./manifest.js";
export { SettingsSchema, type ValidatedSettings } from "./schema.js";
