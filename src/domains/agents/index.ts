import type { DomainModule } from "../../core/domain-loader.js";
import { createAgentsBundle } from "./extension.js";
import { AgentsManifest } from "./manifest.js";

export const AgentsDomainModule: DomainModule = {
	manifest: AgentsManifest,
	createExtension: createAgentsBundle,
};

export type { AgentsContract } from "./contract.js";
export type {
	FleetContract,
	FleetContractListing,
	FleetContractStep,
	FleetOnFailure,
	FleetStepScope,
} from "./fleet-contract.js";
export { listFleetContracts, loadFleetContract, parseFleetContract, renderFleetPrompt } from "./fleet-contract.js";
export type { Fleet, FleetStep } from "./fleet-parser.js";
export { parseFleet } from "./fleet-parser.js";
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
