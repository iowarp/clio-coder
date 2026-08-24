import type { DomainModule } from "../../core/domain-loader.js";
import { createAgentsBundle } from "./extension.js";
import { AgentsManifest } from "./manifest.js";

export const AgentsDomainModule: DomainModule = {
	manifest: AgentsManifest,
	createExtension: createAgentsBundle,
};

export type { AgentsContract } from "./contract.js";
export type { FleetCommand, FleetCommandRegistry } from "./fleet-commands.js";
export {
	FLEET_COMMAND_BASE_ENV,
	FLEET_COMMAND_DEFAULT_TIMEOUT_MS,
	fleetCommandsPath,
	loadFleetCommands,
	parseFleetCommands,
} from "./fleet-commands.js";
export type {
	FleetContract,
	FleetContractAgentStep,
	FleetContractCodeStep,
	FleetContractListing,
	FleetContractLoopCheck,
	FleetContractLoopRepair,
	FleetContractLoopStep,
	FleetContractSource,
	FleetContractStep,
	FleetContractVersion,
	FleetOnFailure,
	FleetStepBoundary,
	FleetStepScope,
} from "./fleet-contract.js";
export {
	FLEET_COMMANDS_REMEDY,
	FLEET_COMMANDS_REPO_PATH,
	FLEET_LOOP_MAX_ATTEMPTS,
	FLEET_WRITE_BOUNDARY_VERSION,
	FleetCommandRegistryMissingError,
	fleetCodeSteps,
	fleetLoopCheckStepId,
	fleetLoopRepairStepId,
	fleetLoopSteps,
	fleetStepAncestors,
	fleetStepBoundaries,
	fleetStepWriteBoundary,
	listFleetContracts,
	loadFleetContract,
	parseFleetContract,
	renderFleetPrompt,
	validateFleetCommands,
	validateFleetGraph,
} from "./fleet-contract.js";
export { AgentsManifest } from "./manifest.js";
export type {
	AgentBudget,
	AgentRecipe,
	AgentToolAnyOfRequirement,
	AgentToolRequirement,
	RecipeSource,
} from "./recipe.js";
export { parseAgentBudget } from "./recipe.js";
export { parseAgentRecipeSchema, recipeSchemaFieldNames } from "./recipe-schema.js";
export type { AgentRecipeDiagnostic } from "./registry.js";
export type {
	CouncilReport,
	CouncilReportMember,
	OracleResult,
	ResultAuthorship,
	ResultContract,
	ResultContractQuality,
	ResultContractValidation,
	ScoutResult,
	VerifierCheck,
	VerifierResult,
} from "./result-contract.js";
export {
	parseCouncilReport,
	parseOracleResult,
	parseResultContract,
	parseScoutResult,
	parseVerifierResult,
	resultContractAuthorship,
	resultContractDigest,
	validateRecipeResult,
	validateResultContract,
} from "./result-contract.js";
export type {
	AgentCapabilityClass,
	AgentCategory,
	AgentLatencyClass,
	AgentSpec,
	AgentToolCompatibility,
	AgentToolRequirements,
} from "./spec.js";
export {
	agentSpecPolicyErrors,
	assertAgentSpecPolicy,
	normalizeAgentSpec,
	resolveAgentToolCompatibility,
} from "./spec.js";
export type { WriteBoundary } from "./write-boundary.js";
export {
	describeWriteBoundary,
	normalizeWriteBoundary,
	normalizeWriteBoundaryEntry,
	WRITE_BOUNDARY_MAX_ENTRIES,
	writeBoundariesOverlap,
	writeBoundaryCovers,
} from "./write-boundary.js";
