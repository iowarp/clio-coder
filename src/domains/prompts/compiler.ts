import { join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
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
	/**
	 * Compact fleet roster (`renderFleetPromptSection`) for the sessions that
	 * carry the dispatch tool. Rendered only when `dispatch` is on the frozen
	 * surface: a roster without the tool to reach it is noise, and the tool
	 * without the roster is a guess.
	 */
	fleetRoster?: string;
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
	/**
	 * The session's `additionalFragments` channel, mirrored for a worker: active
	 * project rules scoped to this run's working context and the operator
	 * profile, when either renders non-empty. Rendered last, after persona, the
	 * same order `compile()` uses for its own `additionalFragments`.
	 */
	additionalFragments?: ReadonlyArray<RenderedPromptFragment>;
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
	/**
	 * Repo-relative `.clio-coder/rules/**` ids selected into this compile, in
	 * load order. Set only by `compileWorkerPrompt`, which owns rule
	 * selection; the pure compiler and `compileSessionPrompt` leave it absent.
	 */
	rulesApplied?: string[];
	/**
	 * Whether the operator profile rendered non-empty content into this
	 * compile. Set only by `compileWorkerPrompt`.
	 */
	operatorProfileApplied?: boolean;
}

export const FLEET_ROUTING_GUIDANCE_MAX_BYTES = 320;
// Points at the Fleet section rather than describing routing in the abstract:
// `agent:"auto"` baselines by task shape and can still land on a worker whose
// capability class is wrong for the job, so a pinned id is the reliable path.
export const FLEET_ROUTING_GUIDANCE =
	'Fleet routing: pin the `agent` id from the Fleet section; agent:"auto" baselines from the task text and is a fallback, not a router.';

/**
 * Worker-side mirror of the parent's `SPOT_CHECK_GUIDANCE`. The parent sentence
 * demonstrably works: in the E19 drive it is what caught a verifier reporting a
 * quality pass on a typecheck script that does not exist. The same failure
 * happens one level down, where a worker seals a fabricated report or a
 * fabricated `npm test`, so the worker gets the mirror image of that rule. It
 * lives in the shared worker scaffold rather than in each recipe: every
 * dispatched persona inherits this block, and a rule copied into twelve files
 * drifts in eleven of them.
 */
export const WORKER_CLAIM_GUIDANCE =
	'Never claim a completion, a validation, or a file change that no tool call in this run supports. If you did not run it or write it here, say "not verified" and report what you did do.';

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

/**
 * What "approval-required" resolves to for the session: one operator
 * confirmation per parked call. The level fragments say which calls park;
 * this line says what parking means, and it is role text because a worker's
 * parked call resolves through its `onPermission` routing instead.
 */
export const SESSION_APPROVAL_SEMANTICS =
	"Approval-required calls pause for one operator confirmation, which grants only the parked action; cancellation cancels the parked call cleanly.";

function renderSafetySection(safetyFragment: LoadedFragment, level: string): string {
	const oneLine = `Autonomy: ${level}. ${safetyOneLiner(level)}`;
	const body = safetyFragment.body.trim();
	return body.length > 0 ? `${oneLine}\n${SESSION_APPROVAL_SEMANTICS}\n\n${body}` : oneLine;
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

/**
 * Whether the session's frozen surface can reach fleet workers. Read from the
 * tool names and the registry's hints, never from settings: the Fleet section
 * and the Tool Contract's dispatch clauses must appear together or not at all.
 */
function sessionCanDispatch(inputs: SessionPromptInputs): boolean {
	if (inputs.providerSupportsTools === false) return false;
	return toolSurfaceHasTool(inputs.toolNames, inputs.toolPromptHints, "dispatch");
}

/**
 * Whether `context` is on the session's surface. The Skills passage, the docs
 * routing directive, and the Tool Contract's skills clause follow the same
 * rule as dispatch: text that teaches a call to `context` renders only when
 * `context` is there to be called.
 */
function sessionHasContext(inputs: SessionPromptInputs): boolean {
	if (inputs.providerSupportsTools === false) return false;
	return toolSurfaceHasTool(inputs.toolNames, inputs.toolPromptHints, "context");
}

/** One lookup for every "is this tool on the surface" predicate, over names and hints alike. */
function toolSurfaceHasTool(
	toolNames: ReadonlyArray<string> | undefined,
	toolPromptHints: ReadonlyArray<ToolPromptHint> | undefined,
	tool: string,
): boolean {
	const names = new Set((toolNames ?? []).map((name) => name.trim()));
	const hinted = new Set((toolPromptHints ?? []).map((entry) => entry.tool.trim()));
	return names.has(tool) || hinted.has(tool);
}

function renderFleetBlock(inputs: SessionPromptInputs): string {
	if (!sessionCanDispatch(inputs)) return "";
	return inputs.fleetRoster?.trim() ?? "";
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
	const canDispatch = sessionCanDispatch(inputs);
	const canListSkills = sessionHasContext(inputs);
	const inventoryGuidance = [
		// Asked twice in one session which tools it had, a live model gave two
		// different answers and invented `web_find`. The authoritative list is one
		// line above; pointing at it beats letting the model recall the schemas.
		"When answering capability-inventory questions, copy the Direct tools line above verbatim rather than recalling the attached schemas, and make no calls",
		...(canDispatch ? ["add dispatch(list:true) only if agents or the fleet are requested"] : []),
		...(canListSkills
			? ['add context(scope="skills") only if skills are requested (it lists installed and marketplace skills)']
			: []),
	].join("; ");
	const lines = [
		"# Tool Contract",
		"The attached schemas are the session's complete direct-tool surface; follow each schema exactly.",
		...(names.length > 0 ? [`Direct tools: ${names.map((name) => `\`${name}\``).join(", ")}.`] : []),
		"Harness model: direct tools are attached schemas; fleet agents are workers behind dispatch; skills are operator-activated workflows reached through context. Keep these capability sets distinct.",
		`${inventoryGuidance}.`,
		"Call tools only for concrete inspection or changes the task requires. If the user asks for a tool-free answer, simply answer without calling tools.",
		// The tool-specific instantiation of the operating contract's "narrow
		// work: inspect directly" rule; the contract cannot name tools.
		// Delegation, the tasks board, and skills are not restated here: the
		// Delegation and Skills passages and the registry hints carry them, and
		// each renders exactly when its tool does.
		'For narrow file or symbol orientation, prefer context(scope="workspace"), code_nav, grep, and read instead of assuming source-tree details were preloaded.',
		"Validate with verify or git diff before final claims.",
		'When a tool call fails or is rejected, do not retry the same shape blindly: re-read the schema, adjust the arguments, or query context(scope="docs") for that tool\'s usage.',
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

/**
 * The constitutional contract renders byte-identical for session and worker.
 * Role text is separate: the coordinator's `operating.delegation` and
 * `operating.skills` never reach a worker (its reply goes to the
 * orchestrator, it cannot suggest a skill to an operator, and no builtin
 * admits `dispatch`), and the worker's `operating.worker` never reaches the
 * session. What "approval-required" resolves to for a worker is stated once,
 * in its safety section, by `workerPermissionSentence`.
 */
function renderWorkerOperatingContract(operatingContract: LoadedFragment, workerContract: LoadedFragment): string {
	return [operatingContract.body.trim(), workerContract.body.trim(), WORKER_CLAIM_GUIDANCE].join("\n\n");
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

/**
 * The worker reads the same `safety.<level>` fragment the session does; the
 * one-liner (with the run's permission routing) is the only role text. The
 * level fragments speak in action classes and never name a tool, so nothing
 * here can be false for a surface that lacks one; the earlier inline copy of
 * the levels claimed a full-auto worker's "dispatches" ran when no builtin
 * admits dispatch.
 */
function renderWorkerSafetySection(safetyFragment: LoadedFragment, inputs: WorkerPromptInputs): string {
	const oneLine = `Autonomy: ${inputs.autonomy}. ${workerSafetyOneLiner(inputs.autonomy, inputs.onPermission)}`;
	const body = safetyFragment.body.trim();
	return body.length > 0 ? `${oneLine}\n\n${body}` : oneLine;
}

function renderRetrievalHintsBlock(inputs: SessionPromptInputs): string {
	if (inputs.providerSupportsTools === false) {
		return [
			"# Retrieval Hints",
			"Repository details are intentionally compact because this target has no tool channel.",
			"Use only facts present in the current turn and say what file-specific context would be needed for precise code work.",
		].join("\n");
	}
	// Where to look for skills and when to delegate exploration live in the
	// Skills and Delegation passages; this block only says what is and is not
	// preloaded.
	return [
		"# Retrieval Hints",
		"Compact CLIO-CODER.md project instructions may be preloaded above; everything else about the repository must be fetched, not assumed.",
		"Never invent file paths, automatic tool behavior, or mutable repo details from the system prompt.",
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

	let identityBody = identity.body;
	const selfAwareness = identity.id === "identity.clio" ? table.byId.get("identity.self-awareness") : undefined;
	// The routing directive teaches a call to `context`, so like the Skills
	// passage it renders only when `context` is on the surface. The paths and
	// the code-outranks-docs rule name no tool and stay unconditional.
	const docsRouting = selfAwareness && sessionHasContext(session) ? table.byId.get("identity.docs-routing") : undefined;
	if (selfAwareness) {
		const packageRoot = resolvePackageRoot();
		const rendered = selfAwareness.body
			.replace("{CLIO_DOCS_PATH}", join(packageRoot, "docs"))
			.replace("{CLIO_SRC_PATH}", join(packageRoot, "src"))
			.replace("{CLIO_CODEWIKI_PATH}", join(packageRoot, "dist", "assets", "codewiki.json"));
		identityBody = [identity.body.trim(), rendered.trim(), ...(docsRouting ? [docsRouting.body.trim()] : [])].join(
			"\n\n",
		);
	}

	// Role text gated on the surface, following the Fleet-block rule: text
	// about a tool renders only when the tool is there to be called.
	const delegation = sessionCanDispatch(session) ? table.byId.get("operating.delegation") : undefined;
	const skills = sessionHasContext(session) ? table.byId.get("operating.skills") : undefined;

	push("identity", identityBody);
	push("operating-contract", operatingContract.body);
	if (delegation) push("delegation", delegation.body);
	if (skills) push("skills", skills.body);
	push("safety", renderSafetySection(safety, autonomyLevel));
	push("runtime", renderRuntimeBlock(session));
	push("tool-contract", renderToolContractBlock(session));
	push("fleet", renderFleetBlock(session));
	push("retrieval-hints", renderRetrievalHintsBlock(session));
	push("memory", renderMemoryBlock(session.memorySection));
	push("project-context", renderProjectBlock(session.contextFiles));
	for (const fragment of inputs.additionalFragments ?? []) {
		push(fragment.id, fragment.body);
	}

	const systemPrompt = parts.join("\n\n");
	const baseFragments = [
		identity,
		...(selfAwareness ? [selfAwareness] : []),
		...(docsRouting ? [docsRouting] : []),
		operatingContract,
		...(delegation ? [delegation] : []),
		...(skills ? [skills] : []),
		safety,
	];
	const fragmentManifest: FragmentManifestEntry[] = baseFragments.map((f) => ({
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
 * not belong here; those ride in dispatch's `dynamicPromptMessages`. The one
 * exception is `additionalFragments`: the operator-editable layer (project
 * rules scoped to this run, the operator profile) that mirrors the session's
 * own `additionalFragments` channel, so a worker whose task touches a ruled
 * path reads the same rule the session would. The section order is a
 * protocol invariant.
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
	const workerContract = lookupFragment(table, "operating.worker", "worker contract");
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
	push("operating-contract", renderWorkerOperatingContract(operatingContract, workerContract));
	push("tool-contract", renderWorkerToolContractBlock(inputs));
	push("safety", renderWorkerSafetySection(safety, inputs));
	push("persona", inputs.persona.body);
	for (const fragment of inputs.additionalFragments ?? []) {
		push(fragment.id, fragment.body);
	}

	const systemPrompt = parts.join("\n\n");
	const fragmentManifest: FragmentManifestEntry[] = [
		identity,
		operatingContract,
		workerContract,
		safety,
		inputs.persona,
		...(inputs.additionalFragments ?? []),
	].map((fragment) => ({
		id: fragment.id,
		relPath: fragment.relPath,
		contentHash: fragment.contentHash,
		dynamic: fragment.dynamic,
	}));

	return {
		systemPrompt,
		systemPromptHash: sha256(systemPrompt),
		tokenEstimate: estimatePromptTokens(systemPrompt),
		sections,
		fragmentManifest,
	};
}
