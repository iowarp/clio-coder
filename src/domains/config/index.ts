import type { DomainModule } from "../../core/domain-loader.js";
import { createConfigBundle } from "./extension.js";
import { ConfigManifest } from "./manifest.js";

export const ConfigDomainModule: DomainModule = {
	manifest: ConfigManifest,
	createExtension: createConfigBundle,
};

export { ConfigManifest } from "./manifest.js";
export { SettingsSchema, type ValidatedSettings } from "./schema.js";
export type { ConfigContract } from "./contract.js";
export { diffSettings, type ChangeKind, type ConfigDiff } from "./classify.js";
