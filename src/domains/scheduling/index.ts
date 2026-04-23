import type { DomainModule } from "../../core/domain-loader.js";
import { createSchedulingBundle } from "./extension.js";
import { SchedulingManifest } from "./manifest.js";

export const SchedulingDomainModule: DomainModule = {
	manifest: SchedulingManifest,
	createExtension: createSchedulingBundle,
};

export type { BudgetVerdict } from "./budget.js";
export type { ClusterNode } from "./cluster.js";
export type { SchedulingContract } from "./contract.js";
export { SchedulingManifest } from "./manifest.js";
