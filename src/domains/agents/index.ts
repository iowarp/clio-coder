import type { DomainModule } from "../../core/domain-loader.js";
import { createAgentsBundle } from "./extension.js";
import { AgentsManifest } from "./manifest.js";

export const AgentsDomainModule: DomainModule = {
	manifest: AgentsManifest,
	createExtension: createAgentsBundle,
};

export type { AgentsContract } from "./contract.js";
export { AgentsManifest } from "./manifest.js";
export type {
	Playbook,
	PlaybookAgentStep,
	PlaybookCodeStep,
	PlaybookGateStep,
	PlaybookListing,
	PlaybookLoopCheck,
	PlaybookLoopRepair,
	PlaybookLoopStep,
	PlaybookOnFailure,
	PlaybookPlanStep,
	PlaybookSource,
	PlaybookStep,
	PlaybookStepBoundary,
	PlaybookStepScope,
	PlaybookVersion,
} from "./playbook.js";
export {
	listPlaybooks,
	loadPlaybook,
	PLAYBOOK_COMMANDS_REMEDY,
	PLAYBOOK_COMMANDS_REPO_PATH,
	PLAYBOOK_DYNAMIC_STEP_VERSION,
	PLAYBOOK_LOOP_MAX_ATTEMPTS,
	PLAYBOOK_WRITE_BOUNDARY_VERSION,
	PlaybookCommandRegistryMissingError,
	parsePlaybook,
	playbookCodeSteps,
	playbookLoopCheckStepId,
	playbookLoopRepairStepId,
	playbookStepAncestors,
	playbookStepBoundaries,
	playbookStepWriteBoundary,
	renderPlaybookPrompt,
	validatePlaybookCommands,
	validatePlaybookGraph,
} from "./playbook.js";
export type { PlaybookCommand, PlaybookCommandRegistry } from "./playbook-commands.js";
export {
	loadPlaybookCommands,
	PLAYBOOK_COMMAND_BASE_ENV,
	PLAYBOOK_COMMAND_DEFAULT_TIMEOUT_MS,
	parsePlaybookCommands,
	playbookCommandsPath,
} from "./playbook-commands.js";
export type {
	AgentBudget,
	AgentRecipe,
	AgentToolAnyOfRequirement,
	AgentToolRequirement,
	RecipeSource,
} from "./recipe.js";
export { parseAgentBudget } from "./recipe.js";
export { parseAgentRecipeSchema } from "./recipe-schema.js";
export type { AgentRecipeDiagnostic } from "./registry.js";
export type {
	CouncilReport,
	CouncilReportMember,
	DelegationPlanResult,
	DelegationPlanResultTask,
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
	parseDelegationPlanResult,
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
	AGENT_CATEGORY_PURPOSE,
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
	writeBoundaryCovers,
} from "./write-boundary.js";
