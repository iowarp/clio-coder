import type { DomainModule } from "../../core/domain-loader.js";
import { createDispatchBundle, type DispatchBundleOptions } from "./extension.js";
import { DispatchManifest } from "./manifest.js";

export function createDispatchDomainModule(options: DispatchBundleOptions = {}): DomainModule<"dispatch"> {
	return {
		manifest: DispatchManifest,
		createExtension: (context) => createDispatchBundle(context, options),
	};
}

export { createWorktreeBootRecovery } from "./boot-recovery.js";
export { endpointCapacityHolders, endpointCapacityUsage } from "./capacity-lease.js";
export type { DispatchContract, DispatchRequest } from "./contract.js";
export { councilTopologies } from "./council-topology.js";
export { agentRoleFactsResolver } from "./execution-role.js";
export type { ExecuteFleetRunInput, FleetRunOutcome } from "./fleet-run.js";
export { executeFleetRun, planFleetResume } from "./fleet-run.js";
export type {
	FleetRunPreview,
	FleetRunPreviewInput,
	FleetRunPreviewResult,
	FleetRunPreviewStep,
} from "./fleet-run-preview.js";
export { compileFleetRunPreview, fleetRouteResolver } from "./fleet-run-preview.js";
export {
	describeFleetToolInstall,
	executeFleetToolInstall,
	FLEET_TOOLS,
	isFleetTool,
	prepareFleetToolInstall,
} from "./fleet-tool-install.js";
export { gateTopology } from "./gate-topology.js";
export { DISPATCH_INTENT_PATH_LIST_CAP, declaredScopeIntent } from "./intent.js";
export type { RecordingReference } from "./recording.js";
export { readRunRecording } from "./recording.js";
export { runUsageFromCallRecords } from "./run-call-usage.js";
export type { RunResultFacts } from "./run-result-facts.js";
export {
	readRunResultFacts,
	readRunResultFactsForReplay,
	runEvidenceOf,
	runResultWireFacts,
} from "./run-result-facts.js";
export type { FleetRunRecord } from "./state.js";
export { openLedger, readFleetRun } from "./state.js";
export { WriterSetBusyError } from "./writer-set.js";
