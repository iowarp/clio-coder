import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { assertAgentIdNamespace } from "../config/agent-namespace.js";
import type { ConfigContract } from "../config/contract.js";
import type { AgentsContract } from "./contract.js";
import type { AgentRecipe } from "./recipe.js";
import { type AgentRecipeDiagnostic, discoverAgentRecipes } from "./registry.js";
import { type AgentSpec, normalizeAgentSpec } from "./spec.js";

export function createAgentsBundle(_context: DomainContext): DomainBundle<AgentsContract> {
	let recipes: ReadonlyArray<AgentRecipe> = [];
	let specs: ReadonlyArray<AgentSpec> = [];
	let diagnostics: ReadonlyArray<AgentRecipeDiagnostic> = [];
	let revision = 0;

	function discover(): void {
		const nextDiagnostics: AgentRecipeDiagnostic[] = [];
		const merged = discoverAgentRecipes(process.cwd(), nextDiagnostics);
		const config = _context.getContract<ConfigContract>("config");
		assertAgentIdNamespace(merged, config?.get()?.integrations.externalAgents?.entries ?? []);
		recipes = merged;
		specs = recipes.map(normalizeAgentSpec);
		diagnostics = nextDiagnostics;
		revision += 1;
	}

	let unsubscribeExtensionsReload: (() => void) | null = null;
	const extension: DomainExtension = {
		async start() {
			discover();
			// Recipes are cached at start; extension agent roots come from the
			// committed extension generation, so a changed generation rediscovers.
			unsubscribeExtensionsReload = _context.bus.on(BusChannels.ExtensionsReloaded, (payload: unknown) => {
				if ((payload as { changed?: unknown } | undefined)?.changed !== true) return;
				try {
					discover();
				} catch (error) {
					process.stderr.write(
						`[clio-coder:agents] rediscovery after extension reload failed: ${error instanceof Error ? error.message : String(error)}\n`,
					);
				}
			});
		},
		async stop() {
			unsubscribeExtensionsReload?.();
			unsubscribeExtensionsReload = null;
		},
	};

	const contract: AgentsContract = {
		revision() {
			return revision;
		},
		list() {
			return recipes;
		},
		get(id: string): AgentRecipe | null {
			return recipes.find((r) => r.id === id) ?? null;
		},
		diagnostics() {
			return diagnostics.map((diagnostic) => ({ ...diagnostic }));
		},
		listSpecs() {
			const config = _context.getContract<ConfigContract>("config");
			const delegationAgents = config?.get()?.integrations.externalAgents?.entries ?? [];
			const delegationSpecs = delegationAgents.map((agent) => ({
				version: 1 as const,
				id: agent.id,
				name: agent.id,
				description: `External ACP delegation agent: ${agent.command} ${(agent.args ?? []).join(" ")}`,
				source: "custom" as const,
				filepath: "settings.yaml",
				tools: [],
				toolRequirements: { required: [], optional: [] },
				category: "explore" as const,
				capabilityClass: "orchestration" as const,
				latencyClass: "deep" as const,
				projectContextTier: "none" as const,
				audience: "custom" as const,
				tags: ["delegation", "acp"],
				skills: [],
				resultContract: { kind: "external-delegation" } as const,
				budget: { toolCalls: 1, readReserve: 0, synthesis: false },
				body: "External ACP delegation.",
			}));
			return [...specs, ...delegationSpecs];
		},
		getSpec(id: string): AgentSpec | null {
			const found = specs.find((r) => r.id === id);
			if (found) return found;
			const config = _context.getContract<ConfigContract>("config");
			const agent = config?.get()?.integrations.externalAgents?.entries?.find((entry) => entry.id === id);
			if (agent) {
				return {
					version: 1 as const,
					id: agent.id,
					name: agent.id,
					description: `External ACP delegation agent: ${agent.command} ${(agent.args ?? []).join(" ")}`,
					source: "custom" as const,
					filepath: "settings.yaml",
					tools: [],
					toolRequirements: { required: [], optional: [] },
					category: "explore" as const,
					capabilityClass: "orchestration" as const,
					latencyClass: "deep" as const,
					projectContextTier: "none" as const,
					audience: "custom" as const,
					tags: ["delegation", "acp"],
					skills: [],
					resultContract: { kind: "external-delegation" } as const,
					budget: { toolCalls: 1, readReserve: 0, synthesis: false },
					body: "External ACP delegation.",
				};
			}
			return null;
		},
		reload() {
			discover();
		},
	};

	return { extension, contract };
}
