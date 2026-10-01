import type { AgentSpec } from "./spec.js";
import { isUserVisibleAgent } from "./spec.js";

const DEFAULT_DISPATCH_AGENT_ID = "coder";

/** Shared by the fleet catalog and dispatch results so evidence guidance stays consistent. */
export const FLEET_EVIDENCE_GUIDANCE =
	'Use sealed worker results for synthesis, keeping reported findings distinct from independent verification. Spot-check consequential or uncertain claims only within the operator\'s scope. If repeated inspection is forbidden, report worker evidence and limitations without re-reading source or rerunning searches. Repeat a "tests pass" claim only when the named validation evidence supports it.';

export interface AgentCatalogSections {
	stable: string;
	volatile: string;
}

/**
 * S3 assigned files to a worker after editing them and disclosed neither change.
 * The coordinator contract (`operating.coordinator`) owns delegation policy;
 * this shared rule makes pending worker ownership explicit.
 */
export const FLEET_HANDOFF_RULE =
	"A file you assigned to a worker is not yours to edit while its dispatch is pending or after it succeeds; if you already changed it, say so in your report.";

/**
 * R5's admission correctly refused a verifier for mutation work and named the
 * mismatch, and the final answer to the operator never mentioned it. A refusal
 * the operator cannot see reads as a silent agent swap.
 */
export const FLEET_REFUSAL_DISCLOSURE =
	"When admission refuses a dispatch, report the refusal and the reason it gave; never substitute another agent without saying why.";

/**
 * R6 issued five near-identical `tester` dispatches because each differed
 * textually, so a string-identity rule never fired. The test that catches that
 * run is about the work, and the model needs somewhere else to go than a sixth
 * dispatch.
 */
export const FLEET_ANTI_CHURN_RULE =
	"Fleet anti-churn guard: do not repeat the same target files and goal while an identical run is pending or after an unresolved identical failure; collect its receipt, address the failure, or change approach. Once earlier runs have settled and the operator merged, discarded, or kept their work, a new operator request may dispatch the same task again. Past session runs alone do not block a new request. If a tool guard blocks a call, report its guard name and the action it requires.";

/**
 * `agent:"auto"` baselines from task text alone and cannot see the shape of a
 * probe, so the jobs it most often misroutes are named against the roster ids
 * directly below this line.
 */
export const FLEET_SPECIALIST_ROUTING =
	"Pick by job: supplied URLs, standards, or papers -> researcher; current ecosystems or an open-world second opinion -> world-knowledge; repository recon -> scout; receipts -> provenance; tests -> tester; gates -> verifier.";

/**
 * Spec-based roster used when the caller already holds normalized specs.
 * `AgentsContract.listSpecs()` includes ACP delegation agents synthesized from
 * settings.integrations.externalAgents.entries[], which never exist as recipe files; rendering
 * from specs keeps those dispatchable targets discoverable in the fleet block.
 */
export function renderAgentCatalogSectionsFromSpecs(input: ReadonlyArray<AgentSpec>): AgentCatalogSections {
	const specs = input.slice().sort((a, b) => {
		const category = a.category.localeCompare(b.category);
		return category === 0 ? a.id.localeCompare(b.id) : category;
	});
	const publicSpecs = specs.filter(isUserVisibleAgent);
	const shadowSpecs = specs.filter((spec) => spec.audience === "shadow");

	const lines: string[] = [
		"Clio manages a small fleet of coding agents. Recipes are Markdown files; normalized specs carry audience, category, capability, tools, skills, latency, and worker-budget hints.",
		"Use the `dispatch` tool to invoke one by `agent_id` when delegation helps.",
		`Default dispatch agent: ${DEFAULT_DISPATCH_AGENT_ID}.`,
		"User-facing agents are base/custom. Shadow agents are internal helpers for context, research, and provenance; do not recommend them as normal `/run` choices.",
		"Prefer fast read-only agents for orientation, verification agents for gates, and workspace-edit agents only for bounded coding tasks.",
		"When a task matches a skill named on an agent line (skills=...), prefer the recipe that binds it; its worker is told to load bound skills for the run.",
		FLEET_EVIDENCE_GUIDANCE,
		FLEET_ANTI_CHURN_RULE,
	];

	if (publicSpecs.length > 0) {
		lines.push("", "User-facing agents:");
		for (const spec of publicSpecs) {
			const description = spec.description.trim();
			const suffix = description.length > 0 ? ` - ${description}` : "";
			lines.push(formatSpecLine(spec, suffix));
		}
	}
	if (shadowSpecs.length > 0) {
		lines.push("", "Shadow agents for internal orchestration:");
		for (const spec of shadowSpecs) {
			const description = spec.description.trim();
			const suffix = description.length > 0 ? ` - ${description}` : "";
			lines.push(formatSpecLine(spec, suffix));
		}
	}

	return { stable: lines.join("\n"), volatile: "" };
}

function formatSpecLine(spec: AgentSpec, suffix: string): string {
	const tags = spec.tags.length > 0 ? `, tags=${spec.tags.join("/")}` : "";
	const skills = spec.skills.length > 0 ? `, skills=${spec.skills.join("/")}` : "";
	const maximum = spec.budget.maximum ? `..${spec.budget.maximum.toolCalls}/${spec.budget.maximum.readReserve}` : "";
	const budget = `, budget=${spec.budget.toolCalls}/${spec.budget.readReserve}${maximum}/${spec.budget.synthesis ? "synthesize" : "stop"}`;
	return `- ${spec.name} [${spec.id}] (${spec.audience}, ${spec.category}, ${spec.capabilityClass}, ${spec.latencyClass}, ${spec.source}${tags}${skills}${budget})${suffix}`;
}
