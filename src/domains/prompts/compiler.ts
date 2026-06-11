import type { PendingSkillRequest } from "../../core/skill-activation.js";
import type { ThinkingMechanism } from "../providers/types/local-model-quirks.js";
import { ceilChars } from "../session/context-accounting.js";
import type { FragmentTable, LoadedFragment } from "./fragment-loader.js";
import { sha256 } from "./hash.js";

export interface CompileInputs {
	identity: string;
	operatingContract: string;
	safety: string;
	dynamicInputs: DynamicInputs;
	additionalFragments?: ReadonlyArray<RenderedPromptFragment>;
}

export interface DynamicInputs {
	provider?: string | null;
	model?: string | null;
	contextWindow?: number | null;
	providerSupportsTools?: boolean | null;
	sendPolicy?: PromptSendPolicy | null;
	thinkingBudget?: string | null;
	thinkingMechanism?: ThinkingMechanism | null;
	thinkingApplied?: "applied" | "ignored-on-off" | "always-on" | "unsupported" | null;
	thinkingNotice?: string | null;
	thinkingGuidance?: string | null;
	familyGuidance?: string | null;
	activeToolNames?: ReadonlyArray<string>;
	/**
	 * Compact, names-only catalog of every tool the target can use this session.
	 * Rendered verbatim into the always-present Tool Catalog block so the model
	 * knows its full surface even on turns with no active schema.
	 */
	toolCatalog?: string | null;
	toolPaletteIntent?: string | null;
	toolPalettePhase?: string | null;
	toolPaletteGroups?: ReadonlyArray<string>;
	omittedToolCount?: number | null;
	sessionNotes?: string;
	contextFiles?: string;
	projectType?: string | null;
	agentCatalog?: string;
	agentCatalogStable?: string;
	agentCatalogDelta?: string;
	skillsCatalog?: string;
	memorySection?: string;
	turnCount?: number;
	clioVersion?: string;
	piMonoVersion?: string;
	pendingSkillRequests?: ReadonlyArray<PendingSkillRequest>;
}

export interface FragmentManifestEntry {
	id: string;
	relPath: string;
	contentHash: string;
	dynamic: boolean;
}

export interface PromptSegmentManifestEntry {
	id: string;
	contentHash: string;
	dynamic: boolean;
	tier: PromptTier;
	envelopePart: PromptEnvelopePartId;
	tokenEstimate: number;
}

export interface RenderedPromptFragment {
	id: string;
	relPath: string;
	body: string;
	contentHash: string;
	dynamic: boolean;
}

export type PromptTier = "static-shell" | "session-shell" | "dynamic-turn";
export type PromptSendPolicy = "prefix-cache-deterministic" | "reduced-repeated-envelope" | "no-tools-fallback";
export type PromptEnvelopePartId =
	| "pinnedHarness"
	| "pinnedRuntime"
	| "pinnedToolContract"
	| "sessionContext"
	| "turnContext"
	| "retrievalHints";

export interface PromptEnvelopePartSummary {
	id: PromptEnvelopePartId;
	tier: PromptTier;
	contentHash: string;
	tokenEstimate: number;
	charLength: number;
	included: boolean;
}

export interface PromptEnvelopeSignature {
	version: 1;
	promptSignature: string;
	staticShellHash: string;
	sessionShellHash: string;
	dynamicHash: string;
	parts: ReadonlyArray<PromptEnvelopePartSummary>;
}

export interface DynamicPromptFragment {
	id: string;
	body: string;
	contentHash: string;
	tokenEstimate: number;
}

export interface CompileResult {
	/** Full prompt text retained for older callers and reproducibility. */
	text: string;
	/** Stable provider-facing system prompt: static shell + semi-static session shell. */
	systemPrompt: string;
	/** Ordered volatile fragments to send as messages before the real user turn. */
	dynamicPromptFragments: ReadonlyArray<DynamicPromptFragment>;
	renderedPromptHash: string;
	fragmentManifest: ReadonlyArray<FragmentManifestEntry>;
	segmentManifest: ReadonlyArray<PromptSegmentManifestEntry>;
	staticShellHash: string;
	sessionShellHash: string;
	dynamicHash: string;
	promptEnvelope: PromptEnvelopeSignature;
	staticShellTokenEstimate: number;
	dynamicInputs: Readonly<DynamicInputs>;
}

function lookupFragment(table: FragmentTable, id: string, role: string): LoadedFragment {
	const frag = table.byId.get(id);
	if (!frag) {
		throw new Error(`prompts/compiler: ${role} fragment id "${id}" not found`);
	}
	return frag;
}

function safetyOneLiner(level: string): string {
	switch (level) {
		case "suggest":
			return "describe the work; do not modify files or run effectful commands.";
		case "auto-edit":
			return "edits inside the workspace are allowed; execute-class actions need confirmation.";
		case "full-auto":
			return "edits and local commands are allowed; system_modify and git_destructive remain gated.";
		default:
			return "follow the active safety contract.";
	}
}

function renderSafetySection(safetyFragment: LoadedFragment, level: string): string {
	const oneLine = `Safety: ${level}. ${safetyOneLiner(level)}`;
	const body = safetyFragment.body.trim();
	return body.length > 0 ? `${oneLine}\n\n${body}` : oneLine;
}

function renderRuntimeBlock(inputs: DynamicInputs): string {
	const lines: string[] = ["# Runtime"];
	const provider = inputs.provider ?? "";
	const model = inputs.model ?? "";
	if (provider.length > 0) lines.push(`Provider: ${provider}`);
	if (model.length > 0) lines.push(`Model: ${model}`);
	if (typeof inputs.contextWindow === "number" && inputs.contextWindow > 0) {
		lines.push(`Context window: ${inputs.contextWindow}`);
	}
	if (typeof inputs.sendPolicy === "string" && inputs.sendPolicy.length > 0) {
		lines.push(`Prompt send policy: ${inputs.sendPolicy}`);
	}
	if (typeof inputs.thinkingBudget === "string" && inputs.thinkingBudget.length > 0) {
		lines.push(`Thinking level: ${inputs.thinkingBudget}`);
	}
	if (typeof inputs.thinkingMechanism === "string" && inputs.thinkingMechanism.length > 0) {
		lines.push(`Thinking mechanism: ${inputs.thinkingMechanism}`);
	}
	if (typeof inputs.thinkingApplied === "string" && inputs.thinkingApplied.length > 0) {
		lines.push(`Thinking applied: ${inputs.thinkingApplied}`);
	}
	if (typeof inputs.thinkingNotice === "string" && inputs.thinkingNotice.length > 0) {
		lines.push(`Note: ${inputs.thinkingNotice}`);
	}
	const guidance = inputs.thinkingGuidance?.trim();
	if (guidance && guidance.length > 0) {
		lines.push("");
		lines.push(guidance);
	}
	const familyGuidance = inputs.familyGuidance?.trim();
	if (familyGuidance && familyGuidance.length > 0) {
		lines.push("");
		lines.push(familyGuidance);
	}
	return lines.join("\n");
}

function renderToolContractBlock(inputs: DynamicInputs): string {
	const toolSupport =
		inputs.providerSupportsTools === true
			? "available"
			: inputs.providerSupportsTools === false
				? "unavailable"
				: "unknown";
	const activeToolNames = normalizeToolNames(inputs.activeToolNames);
	const lines = [
		"# Tool Contract",
		`Provider tool calls: ${toolSupport}.`,
		"Tool schemas are delivered by the provider layer; follow the schema exactly when calling a tool.",
	];
	if (inputs.providerSupportsTools === false) {
		lines.push("This target cannot call tools; answer from the visible user request and compact context only.");
	} else if (activeToolNames && activeToolNames.length === 0) {
		lines.push("Active tools this turn: none (small talk or a tool/meta question).");
		lines.push(
			"The Tool Catalog below lists everything you can use. Describe your real capabilities from it; never invent tool names or claim a tool channel you lack. To inspect or change the repository, say what you will do and the matching tools attach on the next turn.",
		);
	} else if (activeToolNames) {
		lines.push(`Active tools this turn: ${activeToolNames.join(", ")}.`);
		const intent = inputs.toolPaletteIntent?.trim();
		const phase = inputs.toolPalettePhase?.trim();
		if (intent || phase) {
			lines.push(`Palette: ${intent || "unknown"}${phase ? ` / ${phase}` : ""}.`);
		}
		lines.push("Only call tools in the active list, and only for concrete inspection or changes that the task requires.");
		lines.push(
			"The Tool Catalog below lists the full surface; if the task needs a tool that is not active yet, name the next step and it attaches next turn.",
		);
		lines.push(
			"Prefer workspace_context, grep, and read for repository orientation instead of assuming source-tree details were preloaded.",
		);
		if (
			activeToolNames.includes("entry_points") ||
			activeToolNames.includes("where_is") ||
			activeToolNames.includes("find_symbol")
		) {
			lines.push("Use entry_points, where_is, and find_symbol for indexed TypeScript navigation when they are active.");
		}
		if (activeToolNames.includes("read_skill")) {
			lines.push(
				"For pending skill requests, first call read_skill for the requested skill before answering, planning, writing files, or inspecting the repository.",
			);
		}
		if (activeToolNames.includes("ask_user")) {
			lines.push(
				'Use ask_user for structured operator interviews, confirmations, and choices. ask_user is an active tool, not a skill body or a file protocol. For interview or stress-test workflows use action="ask", mode="single_question", and exactly one question. For compact confirmations use mode="round" with one to four tightly related questions. Include options with descriptions when choices are natural and put your recommended answer first. Ask adaptive follow-up rounds only for new necessary information. When the interview has enough information, call ask_user with action="complete", a compact decisions array, and an optional short summary before final prose. If ask_user returns cancelled, continue with defaults and do not ask again.',
			);
		}
	} else {
		lines.push("Use tool calls only for concrete inspection or changes that the task requires.");
		lines.push(
			"Prefer workspace_context, grep, and read for repository orientation instead of assuming source-tree details were preloaded.",
		);
	}
	return lines.join("\n");
}

function renderToolCatalogBlock(inputs: DynamicInputs): string {
	if (inputs.providerSupportsTools === false) return "";
	const catalog = inputs.toolCatalog?.trim() ?? "";
	if (catalog.length === 0) return "";
	return [
		"# Tool Catalog",
		"Every tool you can use this session, grouped by purpose. Schemas are attached only for the active subset above; this catalog is the authoritative list of what exists. Use it to answer capability questions accurately.",
		"",
		catalog,
	].join("\n");
}

function renderPendingSkillRequestsBlock(inputs: DynamicInputs): string {
	const requests = inputs.pendingSkillRequests?.filter((request) => request.name.trim().length > 0) ?? [];
	if (requests.length === 0) return "";
	const allowed = [...new Set(requests.map((request) => request.name.trim()).filter(Boolean))];
	const lines = ["# Pending Skill Request"];
	for (const request of requests) {
		const status = request.installed ? "installed" : "not-installed";
		const args = request.args.trim();
		lines.push(`- ${request.name} (${status}, source=${request.source})`);
		if (args.length > 0) lines.push(`  User task: ${args}`);
	}
	lines.push(
		`First call read_skill for: ${allowed.join(", ")}.`,
		`Only these pending skill names are allowed this turn: ${allowed.join(", ")}.`,
		"After read_skill succeeds, follow the loaded workflow. The active tool surface then widens to the skill's declared tools merged with host policy, so load the skill before attempting other tool calls.",
		'If that workflow needs an interview, confirmation, or choice and ask_user is active, call ask_user with action="ask". Use mode="single_question" and exactly one question for interview workflows; use mode="round" only for tightly related confirmations. Adaptive follow-up rounds are allowed only for new, necessary questions. When enough information is collected, call ask_user with action="complete" and compact decisions before final prose. If ask_user is unavailable or cancelled, proceed with defaults and state assumptions.',
	);
	return lines.join("\n");
}

function renderRetrievalHintsBlock(inputs: DynamicInputs): string {
	const activeToolNames = normalizeToolNames(inputs.activeToolNames);
	if (activeToolNames && activeToolNames.length === 0) return "";
	if (inputs.providerSupportsTools === false) {
		return [
			"# Retrieval Hints",
			"Repository details are intentionally compact because this target has no tool channel.",
			"Use only facts present in the current turn and say what file-specific context would be needed for precise code work.",
		].join("\n");
	}
	return [
		"# Retrieval Hints",
		"Repository structure and CLIO.md contents are not preloaded every turn.",
		"Use workspace_context for a quick workspace snapshot. Use codewiki tools for indexed TypeScript structure when entry_points, where_is, or find_symbol are active. Use grep/read for exact file evidence.",
		"Do not infer mutable repo details from the pinned prompt envelope.",
		"",
		"- **Clio-internal Grounding Policy**:",
		"  - For questions about where code, context priming, context handoff, skills, tools, prompts, or harness behavior live, you MUST inspect local project context or call available lookup tools (such as `where_is`, `find_symbol`, `entry_points`, `workspace_context`, `grep`, or `read`) before answering. Never answer from generic assumptions or hallucinate details.",
		"  - Do not invent automatic tool behavior (e.g., claiming a tool runs automatically when it must be explicitly called).",
		"  - Clearly distinguish:",
		"    - `workspace_context`: An explicit, manual workspace snapshot tool (unless the codebase proves automatic invocation for a specific hook).",
		"    - `dispatch` / `dispatch_batch`: Shadow-agent/fleet delegation tools.",
		"    - Context handoff: A context-engine artifact/workflow (e.g., `.clio/handoffs/`), if present.",
		"    - Context priming: A prompt/context loading workflow (e.g., `.clio` or CLIO.md loading), if present.",
	].join("\n");
}

function normalizeToolNames(tools: ReadonlyArray<string> | undefined): string[] | null {
	if (!tools) return null;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const tool of tools) {
		const trimmed = tool.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function toolIsActive(inputs: DynamicInputs, name: string): boolean {
	const active = normalizeToolNames(inputs.activeToolNames);
	return active?.includes(name) === true;
}

function renderProjectBlock(contextFiles: string | undefined, projectType: string | null | undefined): string {
	const trimmedFiles = contextFiles?.trim() ?? "";
	const trimmedType = typeof projectType === "string" ? projectType.trim() : "";
	const hasType = trimmedType.length > 0 && trimmedType !== "unknown";
	if (trimmedFiles.length === 0 && !hasType) return "";
	const lines: string[] = ["# Project"];
	if (hasType) {
		lines.push("");
		lines.push(`Language: ${trimmedType}`);
	}
	if (trimmedFiles.length > 0) {
		lines.push("");
		lines.push(trimmedFiles);
	}
	return lines.join("\n");
}

function renderMemoryBlock(memorySection: string | undefined): string {
	const trimmed = memorySection?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Memory\n\n${trimmed}`;
}

function renderAgentCatalogBlock(agentCatalog: string | undefined): string {
	const trimmed = agentCatalog?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Agent Fleet\n\n${trimmed}`;
}

function renderAgentCatalogStableBlock(agentCatalog: string | undefined): string {
	return renderAgentCatalogBlock(agentCatalog);
}

function renderAgentCatalogDeltaBlock(agentCatalog: string | undefined): string {
	const trimmed = agentCatalog?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return `# Agent Fleet Status\n\n${trimmed}`;
}

function renderSkillsCatalogBlock(skillsCatalog: string | undefined): string {
	const trimmed = skillsCatalog?.trim() ?? "";
	if (trimmed.length === 0) return "";
	return trimmed.startsWith("# Skills") ? trimmed : `# Skills\n\n${trimmed}`;
}

function renderSessionBlock(inputs: DynamicInputs): string {
	const sessionNotes = inputs.sessionNotes?.trim() ?? "";
	const turnCount = typeof inputs.turnCount === "number" ? inputs.turnCount : 0;
	if (sessionNotes.length === 0 && turnCount === 0) return "";
	const lines: string[] = ["# Session"];
	if (turnCount > 0) lines.push(`Turn count: ${turnCount}`);
	if (sessionNotes.length > 0) {
		if (turnCount > 0) lines.push("");
		lines.push(sessionNotes);
	}
	return lines.join("\n");
}

function estimatePromptTokens(text: string): number {
	const trimmed = text.trim();
	return ceilChars(trimmed.length);
}

function pushSegment(
	segments: PromptSegmentManifestEntry[],
	parts: string[],
	id: string,
	body: string,
	dynamic: boolean,
	tier: PromptTier,
	envelopePart: PromptEnvelopePartId,
): void {
	const trimmed = body.trim();
	if (trimmed.length === 0) return;
	parts.push(trimmed);
	segments.push({
		id,
		contentHash: sha256(trimmed),
		dynamic,
		tier,
		envelopePart,
		tokenEstimate: estimatePromptTokens(trimmed),
	});
}

const ENVELOPE_PART_ORDER: readonly PromptEnvelopePartId[] = [
	"pinnedHarness",
	"pinnedRuntime",
	"pinnedToolContract",
	"sessionContext",
	"turnContext",
	"retrievalHints",
];

const ENVELOPE_PART_TIERS: Record<PromptEnvelopePartId, PromptTier> = {
	pinnedHarness: "static-shell",
	pinnedRuntime: "session-shell",
	pinnedToolContract: "session-shell",
	sessionContext: "dynamic-turn",
	turnContext: "dynamic-turn",
	retrievalHints: "session-shell",
};

function buildPromptEnvelope(
	entries: ReadonlyArray<{ segment: PromptSegmentManifestEntry; body: string }>,
	hashes: Pick<PromptEnvelopeSignature, "promptSignature" | "staticShellHash" | "sessionShellHash" | "dynamicHash">,
): PromptEnvelopeSignature {
	const parts = ENVELOPE_PART_ORDER.map((id): PromptEnvelopePartSummary => {
		const body = entries
			.filter((entry) => entry.segment.envelopePart === id)
			.map((entry) => entry.body)
			.join("\n\n")
			.trim();
		return {
			id,
			tier: ENVELOPE_PART_TIERS[id],
			contentHash: sha256(body),
			tokenEstimate: estimatePromptTokens(body),
			charLength: body.length,
			included: body.length > 0,
		};
	});
	return {
		version: 1,
		...hashes,
		parts,
	};
}

/**
 * Compile a Clio prompt from the supplied fragment table and inputs.
 *
 * Identity and the operating contract render verbatim from disk fragments.
 * Safety renders a single one-line directive followed by the safety fragment
 * body. Everything else renders inline from typed DynamicInputs:
 * runtime metadata (provider, model, context window, thinking mechanism,
 * thinking applied/notice/guidance, family guidance), skills catalog, memory,
 * project context, and session state.
 *
 * One reproducibility hash travels with the rendered text: `renderedPromptHash`
 * is sha256 over the final text. Receipts written by older builds remain
 * readable under the same field name.
 */
export function compile(table: FragmentTable, inputs: CompileInputs): CompileResult {
	const identity = lookupFragment(table, inputs.identity, "identity");
	const operatingContract = lookupFragment(table, inputs.operatingContract, "operating contract");
	const safety = lookupFragment(table, inputs.safety, "safety");

	const safetyLevel = safety.id.startsWith("safety.") ? safety.id.slice("safety.".length) : safety.id;
	const parts: string[] = [];
	const segmentManifest: PromptSegmentManifestEntry[] = [];
	pushSegment(segmentManifest, parts, "identity", identity.body, false, "static-shell", "pinnedHarness");
	pushSegment(
		segmentManifest,
		parts,
		"operating-contract",
		operatingContract.body,
		false,
		"static-shell",
		"pinnedHarness",
	);
	pushSegment(
		segmentManifest,
		parts,
		"safety",
		renderSafetySection(safety, safetyLevel),
		false,
		"static-shell",
		"pinnedHarness",
	);
	pushSegment(
		segmentManifest,
		parts,
		"runtime",
		renderRuntimeBlock(inputs.dynamicInputs),
		true,
		"session-shell",
		"pinnedRuntime",
	);
	pushSegment(
		segmentManifest,
		parts,
		"tool-contract",
		renderToolContractBlock(inputs.dynamicInputs),
		true,
		"session-shell",
		"pinnedToolContract",
	);
	pushSegment(
		segmentManifest,
		parts,
		"tool-catalog",
		renderToolCatalogBlock(inputs.dynamicInputs),
		true,
		"session-shell",
		"pinnedToolContract",
	);
	const stableAgentCatalog = renderAgentCatalogStableBlock(
		toolIsActive(inputs.dynamicInputs, "dispatch")
			? (inputs.dynamicInputs.agentCatalogStable ?? inputs.dynamicInputs.agentCatalog)
			: undefined,
	);
	pushSegment(
		segmentManifest,
		parts,
		"tools-and-agents",
		stableAgentCatalog,
		true,
		"session-shell",
		"pinnedToolContract",
	);
	const volatileAgentCatalog = renderAgentCatalogDeltaBlock(
		toolIsActive(inputs.dynamicInputs, "dispatch") ? inputs.dynamicInputs.agentCatalogDelta : undefined,
	);
	pushSegment(segmentManifest, parts, "agent-fleet-deltas", volatileAgentCatalog, true, "dynamic-turn", "turnContext");
	const skillsCatalog = renderSkillsCatalogBlock(
		toolIsActive(inputs.dynamicInputs, "read_skill") || toolIsActive(inputs.dynamicInputs, "create_skill")
			? inputs.dynamicInputs.skillsCatalog
			: undefined,
	);
	pushSegment(segmentManifest, parts, "skills-catalog", skillsCatalog, true, "session-shell", "pinnedToolContract");
	pushSegment(
		segmentManifest,
		parts,
		"pending-skill-requests",
		renderPendingSkillRequestsBlock(inputs.dynamicInputs),
		true,
		"dynamic-turn",
		"turnContext",
	);
	pushSegment(
		segmentManifest,
		parts,
		"retrieval-hints",
		renderRetrievalHintsBlock(inputs.dynamicInputs),
		true,
		"session-shell",
		"retrievalHints",
	);
	const memory = renderMemoryBlock(inputs.dynamicInputs.memorySection);
	pushSegment(segmentManifest, parts, "memory", memory, true, "dynamic-turn", "sessionContext");
	const project = renderProjectBlock(inputs.dynamicInputs.contextFiles, inputs.dynamicInputs.projectType);
	pushSegment(segmentManifest, parts, "project-context", project, true, "dynamic-turn", "turnContext");
	const session = renderSessionBlock(inputs.dynamicInputs);
	pushSegment(segmentManifest, parts, "history-summary", session, true, "dynamic-turn", "sessionContext");
	for (const fragment of inputs.additionalFragments ?? []) {
		pushSegment(segmentManifest, parts, fragment.id, fragment.body, fragment.dynamic, "session-shell", "pinnedHarness");
	}

	const text = parts.join("\n\n");
	const renderedPromptHash = sha256(text);
	const segmentEntries = segmentManifest.map((segment, index) => ({ segment, body: parts[index] ?? "" }));
	const staticShellParts = segmentEntries
		.filter((entry) => entry.segment.tier === "static-shell")
		.map((entry) => entry.body);
	const sessionShellParts = segmentEntries
		.filter((entry) => entry.segment.tier === "static-shell" || entry.segment.tier === "session-shell")
		.map((entry) => entry.body);
	const dynamicFragments = segmentEntries
		.filter((entry) => entry.segment.tier === "dynamic-turn")
		.map(
			({ segment, body }): DynamicPromptFragment => ({
				id: segment.id,
				body,
				contentHash: segment.contentHash,
				tokenEstimate: segment.tokenEstimate,
			}),
		);
	const staticShellText = staticShellParts.join("\n\n");
	const systemPrompt = sessionShellParts.join("\n\n");
	const dynamicText = dynamicFragments.map((fragment) => fragment.body).join("\n\n");
	const staticShellHash = sha256(staticShellText);
	const sessionShellHash = sha256(systemPrompt);
	const dynamicHash = sha256(dynamicText);
	const staticShellTokenEstimate = estimatePromptTokens(staticShellText);
	const promptEnvelope = buildPromptEnvelope(segmentEntries, {
		promptSignature: renderedPromptHash,
		staticShellHash,
		sessionShellHash,
		dynamicHash,
	});

	const manifestFragments: LoadedFragment[] = [identity, operatingContract, safety];
	const fragmentManifest: FragmentManifestEntry[] = manifestFragments.map((f) => ({
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
		text,
		systemPrompt,
		dynamicPromptFragments: dynamicFragments,
		renderedPromptHash,
		fragmentManifest,
		segmentManifest,
		staticShellHash,
		sessionShellHash,
		dynamicHash,
		promptEnvelope,
		staticShellTokenEstimate,
		dynamicInputs: { ...inputs.dynamicInputs },
	};
}
