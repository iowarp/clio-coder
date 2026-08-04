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
	FleetContractStep,
	FleetContractVersion,
	FleetOnFailure,
	FleetStepScope,
} from "./fleet-contract.js";
export {
	fleetCodeSteps,
	listFleetContracts,
	loadFleetContract,
	parseFleetContract,
	renderFleetPrompt,
	validateFleetCommands,
} from "./fleet-contract.js";
export { AgentsManifest } from "./manifest.js";
export type {
	AgentBudget,
	AgentRecipe,
	AgentToolAnyOfRequirement,
	AgentToolRequirement,
	AgentToolRequirements as AgentRecipeToolRequirements,
	RecipeSource,
} from "./recipe.js";
export { parseAgentBudget } from "./recipe.js";
export { parseAgentRecipeSchema, recipeSchemaFieldNames } from "./recipe-schema.js";
export type { AgentRecipeDiagnostic } from "./registry.js";
export type {
	ResultContract,
	ResultContractQuality,
	ResultContractValidation,
	ScoutResult,
} from "./result-contract.js";
export {
	parseResultContract,
	parseScoutResult,
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
