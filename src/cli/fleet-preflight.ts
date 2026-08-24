import { join } from "node:path";
import { readSettings } from "../core/config.js";
import { resolvePackageRoot } from "../core/package-root.js";
import { clioConfigDir } from "../core/xdg.js";
import {
	type FleetCommandRegistry,
	type FleetContract,
	loadFleetCommands,
	loadFleetContract,
	renderFleetPrompt,
} from "../domains/agents/index.js";
import { type AgentRecipeDiagnostic, loadRecipesFromDir, mergeRecipes } from "../domains/agents/registry.js";
import { type AgentSpec, normalizeAgentSpec } from "../domains/agents/spec.js";
import type { ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { requestExecutionRole, withAttemptRole } from "../domains/dispatch/execution-role.js";
import { compileFleetExecutionPlan } from "../domains/dispatch/fleet-plan.js";

export interface FleetPreflightResult {
	contract: FleetContract;
	commands: FleetCommandRegistry | null;
	plan: ExecutionPlan;
	checks: ReadonlyArray<{ check: "parse" | "graph" | "commands" | "agents" | "plan"; summary: string }>;
}

function discoverSpecs(cwd: string): AgentSpec[] {
	const diagnostics: AgentRecipeDiagnostic[] = [];
	const builtin = loadRecipesFromDir(
		{ dir: join(resolvePackageRoot(), "src", "domains", "agents", "builtins"), source: "builtin" },
		diagnostics,
	);
	const user = loadRecipesFromDir({ dir: join(clioConfigDir(), "agents"), source: "user" }, diagnostics);
	const project = loadRecipesFromDir({ dir: join(cwd, ".clio-coder", "agents"), source: "project" }, diagnostics);
	return mergeRecipes(builtin, user, project).map(normalizeAgentSpec);
}

export function inspectFleet(name: string, vars?: Readonly<Record<string, string>>): FleetPreflightResult {
	const cwd = process.cwd();
	const contract = loadFleetContract(cwd, name);
	const commands = loadFleetCommands(cwd);
	const prompt = vars === undefined ? contract.body : renderFleetPrompt(contract.body, vars);
	const specs = discoverSpecs(cwd);
	const byId = new Map(specs.map((spec) => [spec.id, spec]));
	const resolved = new Set<string>();
	const settings = readSettings();
	const targetIds = new Set(settings.targets.map((target) => target.id));
	const profileIds = new Set(Object.keys(settings.workers?.profiles ?? {}));
	for (const step of contract.steps) {
		const positions =
			step.kind === "loop"
				? [
						...(step.check.kind === "agent" ? [{ id: `${step.id}.check`, route: step.check }] : []),
						{ id: `${step.id}.repair`, route: step.repair },
					]
				: step.kind === "agent" || step.kind === "gate" || step.kind === "plan"
					? [{ id: step.id, route: step }]
					: [];
		for (const position of positions) {
			if (position.route.target !== undefined && !targetIds.has(position.route.target)) {
				throw new Error(`unknown target '${position.route.target}' at step '${position.id}'`);
			}
			if (position.route.profile !== undefined && !profileIds.has(position.route.profile)) {
				throw new Error(`unknown profile '${position.route.profile}' at step '${position.id}'`);
			}
		}
	}
	const plan = compileFleetExecutionPlan({
		contract,
		task: prompt,
		resolveAgent(context) {
			const spec = byId.get(context.agentId);
			if (spec === undefined) {
				throw new Error(
					`unknown agent '${context.agentId}' (step '${context.stepId}' must name a recipe from 'clio-coder agents')`,
				);
			}
			if (spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
				throw new Error(`fleet step '${context.stepId}' has no automatable agent authority`);
			}
			resolved.add(spec.id);
			const role = requestExecutionRole({
				agentId: spec.id,
				resolveFacts: (id) => {
					const found = byId.get(id);
					return found === undefined
						? null
						: {
								category: found.category,
								capabilityClass: found.capabilityClass,
								resultContractKind: found.resultContract.kind,
							};
				},
				...(context.gateRole === undefined ? {} : { gateRole: context.gateRole }),
			});
			return {
				requestedAuthority: spec.capabilityClass,
				approvedAuthority: spec.capabilityClass,
				expectedResultContract:
					context.planRole === true
						? "delegation-plan"
						: context.gateAuthorRole === true
							? "artifact-report"
							: context.gateRole === "reviewer"
								? "verifier-report"
								: spec.resultContract.kind,
				executionRole: withAttemptRole(role, context.attempt),
			};
		},
	});
	return {
		contract,
		commands,
		plan,
		checks: [
			{ check: "parse", summary: `parsed contract version ${contract.version}` },
			{ check: "graph", summary: `validated ${contract.steps.length} declared steps` },
			{ check: "commands", summary: `validated ${plan.steps.filter((step) => step.kind === "code").length} code steps` },
			{ check: "agents", summary: `resolved ${resolved.size} agents` },
			{ check: "plan", summary: `compiled ${plan.steps.length} plan steps with hash ${plan.hash}` },
		],
	};
}
