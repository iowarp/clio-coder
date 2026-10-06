import { readSettings } from "../core/config.js";
import {
	loadPlaybook,
	loadPlaybookCommands,
	type Playbook,
	type PlaybookCommandRegistry,
	renderPlaybookPrompt,
} from "../domains/agents/index.js";
import { discoverAgentRecipes } from "../domains/agents/registry.js";
import { type AgentSpec, normalizeAgentSpec } from "../domains/agents/spec.js";
import type { ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { requestExecutionRole, withAttemptRole } from "../domains/dispatch/execution-role.js";
import { compileFleetExecutionPlan } from "../domains/dispatch/fleet-plan.js";

export interface PlaybookPreflightResult {
	playbook: Playbook;
	commands: PlaybookCommandRegistry | null;
	plan: ExecutionPlan;
	checks: ReadonlyArray<{ check: "parse" | "graph" | "commands" | "agents" | "plan"; summary: string }>;
}

function discoverSpecs(cwd: string): AgentSpec[] {
	return discoverAgentRecipes(cwd).map(normalizeAgentSpec);
}

export function inspectPlaybook(name: string, vars?: Readonly<Record<string, string>>): PlaybookPreflightResult {
	const cwd = process.cwd();
	const playbook = loadPlaybook(cwd, name);
	const commands = loadPlaybookCommands(cwd);
	const prompt = vars === undefined ? playbook.body : renderPlaybookPrompt(playbook.body, vars);
	const specs = discoverSpecs(cwd);
	const byId = new Map(specs.map((spec) => [spec.id, spec]));
	const resolved = new Set<string>();
	const settings = readSettings();
	const targetIds = new Set(settings.targets.map((target) => target.id));
	const profileIds = new Set(Object.keys(settings.fleet?.profiles ?? {}));
	for (const step of playbook.steps) {
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
		commands,
		...(vars ? { vars } : {}),
		playbook,
		task: prompt,
		resolveAgent(context) {
			const spec = byId.get(context.agentId);
			if (spec === undefined) {
				throw new Error(
					`unknown agent '${context.agentId}' (step '${context.stepId}' must name a recipe from 'clio-coder agents')`,
				);
			}
			if (spec.capabilityClass === "orchestration" || spec.capabilityClass === "internal") {
				throw new Error(`playbook step '${context.stepId}' has no automatable agent authority`);
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
		playbook,
		commands,
		plan,
		checks: [
			{ check: "parse", summary: `parsed playbook version ${playbook.version}` },
			{ check: "graph", summary: `validated ${playbook.steps.length} declared steps` },
			{ check: "commands", summary: `validated ${plan.steps.filter((step) => step.kind === "code").length} code steps` },
			{ check: "agents", summary: `resolved ${resolved.size} agents` },
			{ check: "plan", summary: `compiled ${plan.steps.length} plan steps with hash ${plan.hash}` },
		],
	};
}
