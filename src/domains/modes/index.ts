import type { DomainModule } from "../../core/domain-loader.js";
import { createModesBundle } from "./extension.js";
import { ModesManifest } from "./manifest.js";

export const ModesDomainModule: DomainModule = {
	manifest: ModesManifest,
	createExtension: createModesBundle,
};

export { ModesManifest } from "./manifest.js";
export { ALL_MODES, MODE_MATRIX, type ModeName } from "./matrix.js";
export type { ModesContract } from "./contract.js";
