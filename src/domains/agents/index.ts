import type { DomainModule } from "../../core/domain-loader.js";
import { createAgentsBundle } from "./extension.js";
import { AgentsManifest } from "./manifest.js";

export const AgentsDomainModule: DomainModule = {
	manifest: AgentsManifest,
	createExtension: createAgentsBundle,
};

export type { AgentsContract } from "./contract.js";
export type { Fleet, FleetStep } from "./fleet-parser.js";
export { parseFleet } from "./fleet-parser.js";
export { AgentsManifest } from "./manifest.js";
export type { AgentRecipe, RecipeSource } from "./recipe.js";
