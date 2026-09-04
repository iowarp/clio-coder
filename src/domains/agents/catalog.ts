import { type AgentSpec, isUserVisibleAgent } from "./spec.js";

const DEFAULT_DISPATCH_AGENT_ID = "coder";

/**
 * Shadow recipes an operator command owns, kept out of the prompt roster.
 *
 * `oracle` exists to challenge the operator's question against the decisions
 * the operator settled, and `/oracle` is the only thing that asks it. Listing
 * it among the workers the model reaches with `dispatch` would invite the main
 * agent to dispatch an advisor to argue with itself, which is neither what the
 * recipe is for nor something its briefing (the record, not the transcript)
 * would even let it do well.
 */
const OPERATOR_ONLY_SHADOW_AGENT_IDS: ReadonlySet<string> = new Set(["oracle"]);

export interface AgentCatalogSections {
	stable: string;
	volatile: string;
}

/** Keeps one roster line short enough that the whole fleet block stays near its token budget. */
const FLEET_PROMPT_PURPOSE_MAX_CHARS = 64;

/**
 * S3 handed two files to a worker, then edited both itself before dispatching,
 * reverted one, and disclosed neither. The threshold that says what to hand
 * off lives in the Delegation section (`operating.delegation`), stated once
 * as a count taken before the first edit with the dispatch call shape next
 * to it; the E19 drive found an incentive ("dispatch is the cheap path") lost
 * to inertia every time, and the round-2 drive found the bare threshold here,
 * after the tool contract and without a call shape, lost the same way on
 * two of two runs. This line says what handing off costs you.
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
	"A dispatch with the same target files and the same goal as one you already ran is a repeat however differently you word it: read that run's receipt, or run the check yourself, instead of dispatching again.";

/**
 * `agent:"auto"` baselines from task text alone and cannot see the shape of a
 * probe, so the jobs it most often misroutes are named against the roster ids
 * directly below this line.
 */
export const FLEET_SPECIALIST_ROUTING =
	"Pick by job: supplied URLs, standards, or papers -> researcher; current ecosystems or an open-world second opinion -> world-knowledge; repository recon -> scout; receipts -> provenance; tests -> tester; gates -> verifier.";

function fleetPromptPurpose(description: string): string {
	const trimmed = description.trim().replace(/\s+/gu, " ");
	if (trimmed.length === 0) return "";
	// One sentence is the useful unit: recipe descriptions put the agent's job
	// first and its qualifications after the first period.
	const stop = trimmed.indexOf(". ");
	const sentence = stop > 0 ? trimmed.slice(0, stop) : trimmed.replace(/\.$/u, "");
	if (sentence.length <= FLEET_PROMPT_PURPOSE_MAX_CHARS) return sentence;
	const cut = sentence.lastIndexOf(" ", FLEET_PROMPT_PURPOSE_MAX_CHARS);
	return `${sentence.slice(0, cut > 0 ? cut : FLEET_PROMPT_PURPOSE_MAX_CHARS).trimEnd()}...`;
}

function fleetPromptLine(spec: AgentSpec): string {
	const budget = spec.budget.maximum
		? `${spec.budget.toolCalls}..${spec.budget.maximum.toolCalls} calls`
		: `${spec.budget.toolCalls} calls`;
	const purpose = fleetPromptPurpose(spec.description);
	return `- ${spec.id} (${spec.capabilityClass}, ${budget})${purpose.length > 0 ? `: ${purpose}` : ""}`;
}

/**
 * Compact roster for the compiled session prompt. The full catalog above is a
 * tool result the model has to ask for; this is the same roster small enough to
 * live in the prompt, so choosing a specialist never costs a round trip. Shadow
 * agents are listed because they are dispatchable, marked so the model does not
 * offer them to the operator as `/run` choices. Byte-stable for a given spec
 * set: the prompt prefix must not churn between turns.
 */
export function renderFleetPromptSection(input: ReadonlyArray<AgentSpec>): string {
	const specs = input.slice().sort((a, b) => {
		const category = a.category.localeCompare(b.category);
		return category === 0 ? a.id.localeCompare(b.id) : category;
	});
	const publicSpecs = specs.filter(isUserVisibleAgent);
	const shadowSpecs = specs.filter((spec) => spec.audience === "shadow" && !OPERATOR_ONLY_SHADOW_AGENT_IDS.has(spec.id));
	if (publicSpecs.length === 0 && shadowSpecs.length === 0) return "";

	const lines: string[] = [
		"# Fleet",
		FLEET_HANDOFF_RULE,
		FLEET_ANTI_CHURN_RULE,
		FLEET_REFUSAL_DISCLOSURE,
		// `agent:"auto"` baselines by task shape and can still land on a worker
		// whose capability class is wrong for the job, so a pinned id is the
		// reliable path; said here, next to the ids, rather than in the Tool
		// Contract.
		`Workers you reach with \`dispatch\` by \`agent\` id (default ${DEFAULT_DISPATCH_AGENT_ID}); agent:"auto" is a fallback, not a router. Capability class is what a worker may do: a read-only worker cannot edit.`,
		FLEET_SPECIALIST_ROUTING,
	];
	if (publicSpecs.length > 0) {
		lines.push("", "Operator-facing:", ...publicSpecs.map(fleetPromptLine));
	}
	if (shadowSpecs.length > 0) {
		// Dispatchable, but never a `/run` suggestion: they are plumbing.
		lines.push("", "Internal specialists, dispatch-only:", ...shadowSpecs.map(fleetPromptLine));
	}
	return lines.join("\n");
}

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
		'After a dispatch succeeds, synthesize from the sealed receipt; the worker\'s prose is an advisory claim until its verification state is verified. Spot-check delegated claims before repeating them: re-read any cited file:line location, and re-run or inspect the named validation before repeating a "tests pass" claim.',
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
