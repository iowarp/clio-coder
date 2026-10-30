import type { DomainModule } from "../../core/domain-loader.js";
import { createSchedulingBundle, type SchedulingBundleOptions } from "./extension.js";
import { SchedulingManifest } from "./manifest.js";

export const SchedulingDomainModule: DomainModule = {
	manifest: SchedulingManifest,
	createExtension: createSchedulingBundle,
};

export function createSchedulingDomainModule(options: SchedulingBundleOptions): DomainModule {
	return {
		manifest: SchedulingManifest,
		createExtension: (context) => createSchedulingBundle(context, options),
	};
}

export type { BudgetBlockView, BudgetVerdict, RunCostCap } from "./budget.js";
export {
	budgetBlockSpendText,
	createRunCostCap,
	describeBudgetBlock,
	readBudgetBlock,
	runCostCeilingUsd,
	SESSION_COST_CEILING_EXIT_CODE,
	SESSION_COST_CEILING_REASON,
	SESSION_COST_CEILING_SETTING,
	SessionCostCeilingError,
} from "./budget.js";
export type { SchedulingContract } from "./contract.js";
export { createJobController } from "./job-controller.js";
export { jobHasUnresolvedCleanup, jobIsComplete, matchesJobPredicate, normalizeJobSpec } from "./job-model.js";
export { createJobStore } from "./job-store.js";
export type * from "./job-types.js";
export { SchedulingManifest } from "./manifest.js";
