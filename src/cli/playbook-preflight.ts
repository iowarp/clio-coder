import type { ClioSettings } from "../core/config.js";
import { readStrictLayeredSettings } from "../core/settings-layers.js";
import {
	loadPlaybook,
	loadPlaybookCommands,
	type Playbook,
	type PlaybookCommandRegistry,
	renderPlaybookPrompt,
} from "../domains/agents/index.js";
import { discoverAgentRecipes } from "../domains/agents/registry.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import { isShadowAgent, normalizeAgentSpec, userOriginAudienceRefusal } from "../domains/agents/spec.js";
import type { ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { gateAuthorContractKind, requestExecutionRole, withAttemptRole } from "../domains/dispatch/execution-role.js";
import { compileFleetExecutionPlan } from "../domains/dispatch/fleet-plan.js";

export interface PlaybookPreflightResult {
	playbook: Playbook;
	commands: PlaybookCommandRegistry | null;
	plan: ExecutionPlan;
	checks: ReadonlyArray<{ check: "parse" | "graph" | "commands" | "agents" | "plan"; summary: string }>;
}

/** Every agent a playbook dispatches, including both halves of every loop. */
export function playbookAgents(
	playbook: Playbook,
): Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> {
	const agents: Array<{ id: string; agent: string; scope: "readonly" | "workspace" }> = [];
	for (const step of playbook.steps) {
		if (step.kind === "agent") {
			agents.push({ id: step.id, agent: step.agent, scope: step.scope });
		} else if (step.kind === "gate") {
			agents.push({ id: step.id, agent: step.agent, scope: "workspace" });
		} else if (step.kind === "plan") {
			agents.push({ id: step.id, agent: step.agent, scope: step.scope });
			for (const agent of step.roster) {
				agents.push({ id: `${step.id}.roster`, agent, scope: "readonly" });
			}
		} else if (step.kind === "loop") {
			if (step.check.kind === "agent") {
				agents.push({ id: `${step.id}.check`, agent: step.check.agent, scope: step.check.scope });
			}
			agents.push({ id: `${step.id}.repair`, agent: step.repair.agent, scope: step.repair.scope });
		}
	}
	return agents;
}

/**
 * The one preflight `playbook validate` and `fleet run` share: every step route names a known target and profile, and
 * every agent is a known, non-shadow recipe. Returns the first diagnostic, or null. `agentSpec` answers undefined for
 * an unknown agent. `fleet run` adds the checks that need a booted session (scope, budget) after this one.
 */
export function playbookPreflightDiagnostic(
	playbook: Playbook,
	deps: {
		settings: Pick<Readonly<ClioSettings>, "targets" | "fleet">;
		agentSpec: (id: string) => AgentSpec | null | undefined;
	},
): string | null {
	const targets = new Set(deps.settings.targets.map((target) => target.id));
	const profiles = new Set(Object.keys(deps.settings.fleet?.profiles ?? {}));
	const checkRoute = (id: string, route: { target?: string; profile?: string }): string | null => {
		if (route.target !== undefined && !targets.has(route.target)) {
			return `unknown target '${route.target}' at step '${id}'`;
		}
		if (route.profile !== undefined && !profiles.has(route.profile)) {
			return `unknown profile '${route.profile}' at step '${id}'`;
		}
		return null;
	};
	for (const step of playbook.steps) {
		if (step.kind === "agent" || step.kind === "gate" || step.kind === "plan") {
			const error = checkRoute(step.id, step);
			if (error !== null) return error;
		}
		if (step.kind !== "loop") continue;
		if (step.check.kind === "agent") {
			const error = checkRoute(`${step.id}.check`, step.check);
			if (error !== null) return error;
		}
		const error = checkRoute(`${step.id}.repair`, step.repair);
		if (error !== null) return error;
	}
	for (const step of playbookAgents(playbook)) {
		const spec = deps.agentSpec(step.agent);
		if (spec === undefined) {
			return `unknown agent '${step.agent}' (step '${step.id}' must name a recipe from 'clio-coder agents')`;
		}
		if (spec !== null && isShadowAgent(spec)) {
			return `${userOriginAudienceRefusal(spec, null)} (step '${step.id}')`;
		}
	}
	return null;
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
	// The same effective stack fleet run boots with, so a target or profile a
	// trusted project layer declares validates here exactly as it runs there.
	const settings = readStrictLayeredSettings(cwd).settings;
	const diagnostic = playbookPreflightDiagnostic(playbook, { settings, agentSpec: (id) => byId.get(id) });
	if (diagnostic !== null) throw new Error(`preflight failed: ${diagnostic}`);
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
			if (isShadowAgent(spec)) {
				throw new Error(`${userOriginAudienceRefusal(spec, null)} (step '${context.stepId}')`);
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
				resultContract: spec.resultContract,
				expectedResultContract:
					context.planRole === true
						? "delegation-plan"
						: context.gateAuthorRole === true
							? gateAuthorContractKind(role)
							: context.gateRole === "reviewer"
								? "review-verdict"
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
