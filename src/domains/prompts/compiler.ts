import type { ToolName } from "../../core/tool-names.js";
import type { AutonomyLevel } from "../safety/autonomy.js";
import { ceilChars } from "../session/context-accounting.js";
import type { FragmentTable, LoadedFragment } from "./fragment-loader.js";
import { sha256 } from "./hash.js";
import type { ProjectPreloadClass } from "./preload.js";

/**
 * Session-prompt compiler. The system prompt is compiled once per session
 * from inputs that are constant for the session's lifetime (identity,
 * operating contract, safety level, provider/model, project context, tool
 * surface). Volatile runtime state (thinking level, send heuristics,
 * per-turn requests) never renders into the prompt: the prompt prefix must
 * stay byte-stable so local prefix caches survive across turns and sessions.
 */

/** One per-tool guidance sentence sourced from the tool registry's metadata. */
export interface ToolPromptHint {
	tool: string;
	hint: string;
}

export interface SessionPromptInputs {
	provider?: string | null;
	model?: string | null;
	contextWindow?: number | null;
	providerSupportsTools?: boolean | null;
	/** Model-stable thinking guidance from local-model quirks (changes only on model change). */
	thinkingGuidance?: string | null;
	/** Canonical names on the frozen direct-tool surface, rendered as a compact harness inventory. */
	toolNames?: ReadonlyArray<string>;
	/**
	 * Per-tool prompt hints derived once from the frozen surface at compile
	 * time (registry metadata `promptHint`). Rendered into the Tool Contract
	 * sorted by tool name so the compiled text is byte-stable per surface.
	 */
	toolPromptHints?: ReadonlyArray<ToolPromptHint>;
	contextFiles?: string;
	memorySection?: string;
}

export interface CompileInputs {
	identity: string;
	operatingContract: string;
	safety: string;
	sessionInputs: SessionPromptInputs;
	additionalFragments?: ReadonlyArray<RenderedPromptFragment>;
}

/** Stable inputs for one mediated fleet worker's canonical system prompt. */
export interface WorkerPromptInputs {
	/** The autonomy level already clamped by dispatch admission. */
	autonomy: AutonomyLevel;
	/**
	 * Whether the selected target can attach canonical Clio tool schemas.
	 * `null` means the delegated target's inventory is not observable.
	 */
	providerSupportsTools: boolean | null;
	/** Final canonical names used to attach worker schemas. */
	toolNames: ReadonlyArray<ToolName>;
	/** Registry-owned guidance for the final canonical toolkit. */
	toolPromptHints: ReadonlyArray<ToolPromptHint>;
	/** Whether canonical `context` is present in the final attached schema surface. */
	hasCanonicalContext: boolean;
	/** True only when dispatch has explicitly harness-activated recipe-bound skills. */
	hasBoundSkills: boolean;
	/** Effective approval routing for this worker run. */
	onPermission: "deny" | "fail" | "escalate";
	/** One stable persona: the recipe body or bounded override, including bound-skill mechanics. */
	persona: RenderedPromptFragment;
}

export interface FragmentManifestEntry {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface RenderedPromptFragment {
	id: string;
	relPath: string;
	body: string;
	contentHash: string;
	dynamic: boolean;
}

export interface PromptSection {
	id: string;
	tokenEstimate: number;
}

export interface CompiledSessionPrompt {
	systemPrompt: string;
	systemPromptHash: string;
	tokenEstimate: number;
	sections: ReadonlyArray<PromptSection>;
	fragmentManifest: ReadonlyArray<FragmentManifestEntry>;
	/**
	 * How the project context entered this prompt (full preload, synopsis, or
	 * none). Set by the prompts extension, which owns project-context
	 * selection; the pure compiler leaves it absent.
	 */
	projectPreload?: ProjectPreloadClass | null;
}

export const FLEET_ROUTING_GUIDANCE_MAX_BYTES = 256;
export const FLEET_ROUTING_GUIDANCE =
	"Fleet routing: explicit broad repo/codebase exploration -> scout before repo-wide reads; external docs/papers -> researcher; receipts/evidence -> provenance; bounded code changes -> coder. Give each dispatch a concrete handoff and synthesize its receipt.";

function lookupFragment(table: FragmentTable, id: string, role: string): LoadedFragment {
	const frag = table.byId.get(id);
	if (!frag) {
		throw new Error(`prompts/compiler: ${role} fragment id "${id}" not found`);
	}
	return frag;
}

/**
 * One-sentence autonomy directive. Shared: the session prompt's safety
 * section and the dispatch worker safety-posture message must describe the
 * same enforced behavior, so neither side duplicates this switch.
 */
export function safetyOneLiner(level: string): string {
	switch (level) {
		case "read-only":
			return "inspect and answer; mutating calls are auto-denied, so propose changes instead.";
		case "suggest":
			return "every non-read action parks for one-shot operator approval before it runs.";
		case "auto-edit":
			return "workspace edits and recognized commands run; other bash asks for approval.";
		case "full-auto":
			return "act without asking; system_modify still asks and git_destructive is blocked by the safety net.";
		default:
			return "follow the active safety contract.";
	}
}

function renderSafetySection(safetyFragment: LoadedFragment, level: string): string {
	const oneLine = `Autonomy: ${level}. ${safetyOneLiner(level)}`;
	const body = safetyFragment.body.trim();
	return body.length > 0 ? `${oneLine}\n\n${body}` : oneLine;
}

function renderRuntimeBlock(inputs: SessionPromptInputs): string {
	const lines: string[] = ["# Runtime"];
	const provider = inputs.provider ?? "";
	const model = inputs.model ?? "";
	if (provider.length > 0) lines.push(`Provider: ${provider}`);
	if (model.length > 0) lines.push(`Model: ${model}`);
	if (typeof inputs.contextWindow === "number" && inputs.contextWindow > 0) {
		lines.push(`Context window: ${inputs.contextWindow}`);
	}
	const guidance = inputs.thinkingGuidance?.trim();
	if (guidance && guidance.length > 0) {
		lines.push("");
		lines.push(guidance);
	}
	return lines.join("\n");
}

function renderToolContractBlock(inputs: SessionPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Tool Contract",
			"Provider tool calls: unavailable.",
			"This target cannot call tools; answer from the visible user request and compact context only.",
		].join("\n");
	}
	const names = [
		...new Set((inputs.toolNames ?? []).map((name) => name.trim()).filter((name) => name.length > 0)),
	].sort();
	const hintedTools = new Set((inputs.toolPromptHints ?? []).map((entry) => entry.tool.trim()));
	const canDispatch = names.includes("dispatch") || hintedTools.has("dispatch");
	const canListSkills = names.includes("context") || hintedTools.has("context");
	const inventoryGuidance = [
		"When answering capability-inventory questions, list direct tools without calls",
		...(canDispatch ? ["add dispatch(list:true) only if agents or the fleet are requested"] : []),
		...(canListSkills ? ['add context(scope="skills") only if skills are requested'] : []),
	].join("; ");
	const lines = [
		"# Tool Contract",
		"The attached schemas are the session's complete direct-tool surface; follow each schema exactly.",
		...(names.length > 0 ? [`Direct tools: ${names.map((name) => `\`${name}\``).join(", ")}.`] : []),
		"Harness model: direct tools are attached schemas; fleet agents are workers behind dispatch; skills are operator-activated workflows reached through context. Keep these capability sets distinct.",
		`${inventoryGuidance}.`,
		"Call tools only for concrete inspection or changes the task requires. If the user asks for a tool-free answer, simply answer without calling tools.",
		'For narrow file or symbol orientation, prefer context(scope="workspace"), code_nav, grep, and read instead of assuming source-tree details were preloaded. When dispatch is available and Scout is routable, explicit broad repository/codebase exploration goes to Scout before repo-wide reads.',
		'Routing order: use structured observe tools before bash for narrow inspection; when the request has three or more steps, declare a tasks board (action="plan") before the first edit; treat broad reconnaissance as a bounded Scout handoff, dispatch other bounded parallel or delegated subwork, and synthesize receipts; validate with verify or git diff before final claims.',
		'When a tool call fails or is rejected, do not retry the same shape blindly: re-read the schema, adjust the arguments, or query context(scope="docs") for that tool\'s usage.',
		'List installed skills with context(scope="skills") only when the task is skill-shaped or the operator asks about skills; if one matches, suggest the operator run /skill:<name>, and never load a skill the operator did not request.',
	];
	// One hint per tool, sorted by tool name: deterministic bytes regardless
	// of surface or registration order, and removing a tool from the surface
	// removes its hint with no compiler edit.
	const seen = new Set<string>();
	const hints = [...(inputs.toolPromptHints ?? [])]
		.map((entry) => ({ tool: entry.tool.trim(), hint: entry.hint.trim() }))
		.filter((entry) => entry.tool.length > 0 && entry.hint.length > 0)
		.sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
	if (hints.some((entry) => entry.tool === "dispatch")) lines.push(FLEET_ROUTING_GUIDANCE);
	for (const entry of hints) {
		if (seen.has(entry.tool)) continue;
		seen.add(entry.tool);
		lines.push(entry.hint);
	}
	return lines.join("\n");
}

function canonicalWorkerTools(inputs: WorkerPromptInputs): string[] {
	return [...new Set(inputs.toolNames.map((name) => name.trim()).filter((name) => name.length > 0))].sort();
}

function workerPermissionSentence(mode: WorkerPromptInputs["onPermission"]): string {
	switch (mode) {
		case "escalate":
			return "Approval-required calls pause for a bounded operator decision before execution.";
		case "deny":
			return "Approval-required calls are denied immediately; they are not parked for an operator.";
		case "fail":
			return "An approval-required call fails and ends the worker run; it is not parked for an operator.";
	}
}

function renderWorkerOperatingContract(operatingContract: LoadedFragment, inputs: WorkerPromptInputs): string {
	const skillsHeading = "\n# Skills\n";
	const skillsAt = operatingContract.body.indexOf(skillsHeading);
	const withoutSkills = skillsAt >= 0 ? operatingContract.body.slice(0, skillsAt) : operatingContract.body;
	const skillAwareBody = inputs.hasCanonicalContext && !inputs.hasBoundSkills ? operatingContract.body : withoutSkills;
	const operatingPermission =
		inputs.autonomy === "read-only"
			? "This read-only worker denies mutating calls without requesting approval."
			: workerPermissionSentence(inputs.onPermission);
	const workerBody = skillAwareBody.replace(
		/Safety policy is authoritative[\s\S]*?Do not retry the same blocked\naction through another tool\./,
		[
			"Safety policy is authoritative for every tool call. Allow decisions run normally.",
			operatingPermission,
			"Hard blocks (destructive git, protected artifacts, project or path policy violations) remain hard blocks. When a call is blocked, pivot to a safer approach or explain the blocker. Do not retry the same blocked action through another tool.",
		].join("\n"),
	);
	return [
		workerBody.trim(),
		"# Assigned Task Contract",
		"The assigned task is authoritative. Role guidance is a persona, not a replacement task.",
		"Do not invent a different task, source tree, file path, or implementation plan.",
		"If the assigned task asks for an exact response, a direct answer, or no tool use, answer it directly without tool calls.",
		"Use tools only when necessary for the assigned task and admitted by the worker tool contract.",
	].join("\n\n");
}

function renderWorkerToolContractBlock(inputs: WorkerPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Tool Contract",
			"Canonical Clio tool calls are unavailable on this target.",
			"Answer from the assigned task and dynamic messages only; do not claim that inspection or changes were performed.",
		].join("\n");
	}
	if (inputs.providerSupportsTools === null) {
		return [
			"# Tool Contract",
			"This delegated target's tool inventory is unknown to the Clio harness.",
			"Use only tools the target actually exposes and only when the assigned task requires them; do not infer a complete tool surface from this prompt.",
		].join("\n");
	}

	const names = canonicalWorkerTools(inputs);
	if (names.length === 0) {
		return [
			"# Tool Contract",
			"No canonical tools are admitted for this worker.",
			"Answer the assigned task directly without tool calls.",
		].join("\n");
	}

	const lines = [
		"# Tool Contract",
		"The attached schemas are this worker's complete canonical tool surface; follow each schema exactly.",
		`Admitted canonical tools: ${names.map((name) => `\`${name}\``).join(", ")}.`,
		"This worker surface is distinct from the parent session's tools, fleet agents, and operator-activated skills.",
		"Tool authority is limited to this list. Persona and bound-skill instructions never add tools.",
		"Call tools only for concrete inspection or changes the assigned task requires. If the task requests an exact or tool-free response, answer without calling tools.",
	];
	const admitted = new Set(names);
	const seen = new Set<string>();
	const hints = [...inputs.toolPromptHints]
		.map((entry) => ({ tool: entry.tool.trim(), hint: entry.hint.trim() }))
		.filter((entry) => admitted.has(entry.tool) && entry.hint.length > 0)
		.sort((a, b) => {
			if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
			return a.hint < b.hint ? -1 : a.hint > b.hint ? 1 : 0;
		});
	for (const entry of hints) {
		if (seen.has(entry.tool)) continue;
		seen.add(entry.tool);
		lines.push(entry.hint);
	}
	return lines.join("\n");
}

/** Worker-specific autonomy directive that reflects permission routing without changing session prompt policy. */
export function workerSafetyOneLiner(level: AutonomyLevel, mode: WorkerPromptInputs["onPermission"]): string {
	if (level === "read-only") return safetyOneLiner(level);
	const posture = workerPermissionSentence(mode);
	switch (level) {
		case "suggest":
			return `read calls run freely; every non-read action requires approval. ${posture}`;
		case "auto-edit":
			return `workspace edits and recognized commands run; other commands require approval. ${posture}`;
		case "full-auto":
			return `act without asking except for safety-classified approval-required calls. ${posture}`;
	}
}

function renderWorkerSafetySection(safetyFragment: LoadedFragment, inputs: WorkerPromptInputs): string {
	const heading = safetyFragment.body.trim().split("\n", 1)[0] ?? "# Safety";
	const lines = [
		`Autonomy: ${inputs.autonomy}. ${workerSafetyOneLiner(inputs.autonomy, inputs.onPermission)}`,
		"",
		heading,
	];
	switch (inputs.autonomy) {
		case "read-only":
			lines.push(
				"Admitted read-class tools run freely. Every mutating call is denied by the harness, and no approval prompt appears.",
				"When a change is needed, propose it concretely instead of attempting it.",
			);
			break;
		case "suggest":
			lines.push(
				"Admitted read-class tools run freely. Every non-read call is approval-required.",
				workerPermissionSentence(inputs.onPermission),
			);
			break;
		case "auto-edit":
			lines.push(
				"Workspace edits and recognized commands run. Other commands and system modifications are approval-required.",
				workerPermissionSentence(inputs.onPermission),
			);
			break;
		case "full-auto":
			lines.push(
				"Writes, dispatches, and ordinary commands run. System modifications and opaque command substitutions remain approval-required.",
				workerPermissionSentence(inputs.onPermission),
			);
			break;
	}
	lines.push("Destructive git and other hard safety blocks remain denied at every autonomy level.");
	return lines.join("\n");
}

function renderRetrievalHintsBlock(inputs: SessionPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Retrieval Hints",
			"Repository details are intentionally compact because this target has no tool channel.",
			"Use only facts present in the current turn and say what file-specific context would be needed for precise code work.",
		].join("\n");
	}
	return [
		"# Retrieval Hints",
		"Compact CLIO.md project instructions may be preloaded above; everything else about the repository must be fetched, not assumed.",
		"For narrow questions about where code, skills, tools, prompts, or harness behavior live, inspect with code_nav, context, grep, or read before answering. For explicit broad repository exploration, follow the Scout fleet route when it is available. Never invent file paths, automatic tool behavior, or mutable repo details from the system prompt.",
	].join("\n");
}

function renderProjectBlock(contextFiles: string | undefined): string {
	const trimmedFiles = contextFiles?.trim() ?? "";
	return trimmedFiles.length === 0 ? "" : `# Project\n\n${trimmedFiles}`;
}

function renderMemoryBlock(memorySection: string | undefined): string {
	const trimmed = memorySection?.trim() ?? "";
	return trimmed.length === 0 ? "" : `# Memory\n\n${trimmed}`;
}

function estimatePromptTokens(text: string): number {
	return ceilChars(text.trim().length);
}

/**
 * Compile the session system prompt. Identity and the operating contract
 * render verbatim from disk fragments; safety renders a one-line directive
 * plus the safety fragment body; everything else renders inline from typed
 * SessionPromptInputs. Output is one string, one sha256, one token estimate,
 * and a flat section breakdown for the /context overlay.
 */
export function compile(table: FragmentTable, inputs: CompileInputs): CompiledSessionPrompt {
	const identity = lookupFragment(table, inputs.identity, "identity");
	const operatingContract = lookupFragment(table, inputs.operatingContract, "operating contract");
	const safety = lookupFragment(table, inputs.safety, "safety");
	const autonomyLevel = safety.id.startsWith("safety.") ? safety.id.slice("safety.".length) : safety.id;
	const session = inputs.sessionInputs;

	const parts: string[] = [];
	const sections: PromptSection[] = [];
	const push = (id: string, body: string): void => {
		const trimmed = body.trim();
		if (trimmed.length === 0) return;
		parts.push(trimmed);
		sections.push({ id, tokenEstimate: estimatePromptTokens(trimmed) });
	};

	push("identity", identity.body);
	push("operating-contract", operatingContract.body);
	push("safety", renderSafetySection(safety, autonomyLevel));
	push("runtime", renderRuntimeBlock(session));
	push("tool-contract", renderToolContractBlock(session));
	push("retrieval-hints", renderRetrievalHintsBlock(session));
	push("memory", renderMemoryBlock(session.memorySection));
	push("project-context", renderProjectBlock(session.contextFiles));
	for (const fragment of inputs.additionalFragments ?? []) {
		push(fragment.id, fragment.body);
	}

	const systemPrompt = parts.join("\n\n");
	const fragmentManifest: FragmentManifestEntry[] = [identity, operatingContract, safety].map((f) => ({
		id: f.id,
		relPath: f.relPath,
		contentHash: f.contentHash,
		dynamic: f.dynamic,
	}));
	for (const fragment of inputs.additionalFragments ?? []) {
		fragmentManifest.push({
			id: fragment.id,
			relPath: fragment.relPath,
			contentHash: fragment.contentHash,
			dynamic: fragment.dynamic,
		});
	}

	return {
		systemPrompt,
		systemPromptHash: sha256(systemPrompt),
		tokenEstimate: estimatePromptTokens(systemPrompt),
		sections,
		fragmentManifest,
	};
}

/**
 * Compile the canonical stable prompt for one mediated fleet worker.
 * Dynamic task, project, memory, pipeline, and per-run posture messages do
 * not belong here. The section order is a protocol invariant.
 */
export function compileWorker(table: FragmentTable, inputs: WorkerPromptInputs): CompiledSessionPrompt {
	if (inputs.persona.dynamic) {
		throw new Error("prompts/compiler: worker persona must be a stable fragment");
	}
	if (inputs.persona.body.trim().length === 0) {
		throw new Error("prompts/compiler: worker persona must not be empty");
	}
	const contextIsAttached = inputs.providerSupportsTools === true && canonicalWorkerTools(inputs).includes("context");
	if (inputs.hasCanonicalContext !== contextIsAttached) {
		throw new Error("prompts/compiler: hasCanonicalContext must match the final attached canonical tool surface");
	}
	if (inputs.hasBoundSkills && !inputs.hasCanonicalContext) {
		throw new Error("prompts/compiler: bound skills require canonical context in the final attached tool surface");
	}
	const identity = lookupFragment(table, "identity.clio-worker", "worker identity");
	const operatingContract = lookupFragment(table, "operating.contract", "operating contract");
	const safety = lookupFragment(table, `safety.${inputs.autonomy}`, "safety");

	const parts: string[] = [];
	const sections: PromptSection[] = [];
	const push = (id: string, body: string): void => {
		const trimmed = body.trim();
		if (trimmed.length === 0) return;
		parts.push(trimmed);
		sections.push({ id, tokenEstimate: estimatePromptTokens(trimmed) });
	};

	push("identity", identity.body);
	push("operating-contract", renderWorkerOperatingContract(operatingContract, inputs));
	push("tool-contract", renderWorkerToolContractBlock(inputs));
	push("safety", renderWorkerSafetySection(safety, inputs));
	push("persona", inputs.persona.body);

	const systemPrompt = parts.join("\n\n");
	const fragmentManifest: FragmentManifestEntry[] = [identity, operatingContract, safety, inputs.persona].map(
		(fragment) => ({
			id: fragment.id,
			relPath: fragment.relPath,
			contentHash: fragment.contentHash,
			dynamic: fragment.dynamic,
		}),
	);

	return {
		systemPrompt,
		systemPromptHash: sha256(systemPrompt),
		tokenEstimate: estimatePromptTokens(systemPrompt),
		sections,
		fragmentManifest,
	};
}
