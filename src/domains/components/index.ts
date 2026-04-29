import type { DomainModule } from "../../core/domain-loader.js";
import { createComponentsBundle } from "./extension.js";
import { ComponentsManifest } from "./manifest.js";

export const ComponentsDomainModule: DomainModule = {
	manifest: ComponentsManifest,
	createExtension: createComponentsBundle,
};

export type { ComponentsContract } from "./contract.js";
export { diffComponentSnapshots } from "./diff.js";
export { ComponentsManifest } from "./manifest.js";
export { createComponentSnapshot, scanComponents } from "./scan.js";
export { loadComponentSnapshot, parseComponentSnapshot } from "./snapshot.js";
export type {
	ChangedHarnessComponent,
	ComponentAuthority,
	ComponentDiff,
	ComponentDiffSummary,
	ComponentFieldName,
	ComponentKind,
	ComponentReloadClass,
	ComponentSnapshot,
	ComponentSnapshotOptions,
	ComponentSnapshotRef,
	HarnessComponent,
} from "./types.js";
